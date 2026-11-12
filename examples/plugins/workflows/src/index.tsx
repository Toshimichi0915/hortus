import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Cli,
  type CliPlugin,
  type EntryRenderer,
  linesRenderer,
  type Span,
  theme,
  usePluginCtx,
  useTheme,
} from "@hortus/cli";
import { type Ctx, hortusDir, tool, truncate } from "@hortus/core";
import { Box, Text } from "ink";
import { type ComponentType, useSyncExternalStore } from "react";
import { z } from "zod";
import { execute, type Limits, parseScript, type Run } from "./engine.ts";

// ── per-agent state ──

interface State {
  runs: Map<string, Run>;
  lastScript?: string;
  /** the keyword that arms workflows mode, or false */
  trigger: string | false;
  /** the ids of runs the keyword armed (from `input` to their `prompt`) */
  armed: Set<string>;
  version: number;
  listeners: Set<() => void>;
  /** the TUI navigator (`/workflows`): open, the selected run, its detail shown */
  nav?: { index: number; detail: boolean };
}

function stateOf(ctx: Ctx): State {
  ctx.state.workflows ??= {
    runs: new Map(),
    trigger: "workflow",
    armed: new Set(),
    version: 0,
    listeners: new Set(),
  } satisfies State;
  return ctx.state.workflows as State;
}

const changed = (s: State) => {
  s.version++;
  for (const l of s.listeners) l();
};

// ── running workflows ──

const savedDir = () => join(hortusDir(), "workflows", "saved");

const BUILTINS: Record<string, { description: string; script: string }> = {
  "adversarial-review": {
    description:
      "Investigate a task, then cross-check each finding with skeptical reviewers. args: { task, reviewers?, threshold? }",
    script: `export const meta = {
  name: 'adversarial_review',
  description: 'Adversarial review: findings cross-checked by independent skeptics',
  phases: [{ title: 'Investigate' }, { title: 'Refute' }, { title: 'Consensus' }],
}
const task = (args && args.task) || ''
const reviewers = (args && args.reviewers) || 2
const threshold = (args && args.threshold) || 0.5
phase('Investigate')
const investigation = await agent('Investigate the following and list concrete, individually-checkable findings:\\n' + task,
  { label: 'investigate', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } }, required: ['findings'] } })
const findings = (investigation && investigation.findings) || []
phase('Refute')
const judged = await parallel(findings.map((f, i) => () =>
  parallel(Array.from({ length: reviewers }, (_, r) => () => agent(
    'You are a skeptical reviewer. Try to REFUTE this finding for the task below. Default to real=false when uncertain. Investigate with the available tools if needed.\\n\\nTASK: ' + task + '\\nFINDING: ' + f,
    { label: 'refute ' + (i + 1) + '.' + (r + 1), schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real'] } }
  ))).then((votes) => {
    const valid = votes.filter(Boolean)
    const realCount = valid.filter((v) => v.real).length
    return { finding: f, realVotes: realCount, totalVotes: valid.length, survives: valid.length > 0 && realCount / valid.length >= threshold }
  })))
const survivors = judged.filter((j) => j && j.survives)
phase('Consensus')
const report = await agent('Write a final review report. Include ONLY the findings that survived adversarial review (listed below), each with a short justification. Note how many were discarded.\\n\\nSURVIVING FINDINGS JSON:\\n' + JSON.stringify(survivors), { label: 'consensus' })
return { total: findings.length, survivors, report }`,
  },
  "multi-perspective": {
    description:
      "Analyze a topic from several independent perspectives in parallel, then synthesize. args: { topic, perspectives? }",
    script: `export const meta = {
  name: 'multi_perspective_analysis',
  description: 'Analyze a topic from different perspectives, then synthesize',
  phases: [{ title: 'Perspective Analysis' }, { title: 'Synthesis' }],
}
const topic = args.topic
const perspectives = args.perspectives && args.perspectives.length >= 2 ? args.perspectives : ['technical', 'product', 'security', 'user experience', 'maintainability']
phase('Perspective Analysis')
const analyses = await parallel(perspectives.map((p) => () => agent('Analyze from ' + p + ' perspective: ' + topic, { label: p })))
phase('Synthesis')
const synthesis = await agent('Synthesize these different perspectives into a balanced analysis:\\nAnalyses: ' + JSON.stringify(analyses) + '\\nTopic: ' + topic, { label: 'synthesizer' })
return { analyses, synthesis }`,
  },
};

/** A saved workflow (`~/.hortus/workflows/saved/<name>.js`) wins over a built-in of the same name. */
function named(name: string): string | undefined {
  try {
    return readFileSync(join(savedDir(), `${name}.js`), "utf8");
  } catch {
    return BUILTINS[name]?.script;
  }
}

const clip = (v: unknown) => truncate(show(v)).content;
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const spent = (r: Run) => r.agents.reduce((n, a) => n + a.tokens, 0);
const secs = (r: Run) => `${Math.round(((r.ended ?? Date.now()) - r.started) / 1000)}s`;

function summary(r: Run): string {
  const done = r.agents.filter((a) => a.status === "done").length;
  return `${r.name} (${r.id}) ${r.status}${r.phase ? ` · ${r.phase}` : ""} · ${done}/${r.agents.length} agents · ${tokens(spent(r))} tok · ${secs(r)}`;
}

function status(r: Run): string {
  const active = r.agents.filter((a) => a.status === "running").map((a) => a.label);
  return [
    summary(r),
    ...(active.length ? [`active: ${active.join(", ")}`] : []),
    ...r.logs.slice(-5).map((l) => `log: ${l}`),
    ...(r.error ? [`error: ${r.error}`] : []),
    ...(r.status === "completed" ? [`result:\n${clip(r.result)}`] : []),
  ].join("\n");
}

/** The message delivered back into the conversation when a background run ends. */
const resultText = (r: Run) =>
  r.status === "completed"
    ? `Background workflow "${r.name}" (${r.id}) completed in ${secs(r)} · ${r.agents.length} agents · ${tokens(spent(r))} tokens.\n\nResult:\n${clip(r.result)}`
    : `✗ Background workflow "${r.name}" (${r.id}) failed: ${r.error}`;

interface Start extends Limits {
  script: string;
  args?: unknown;
  background?: boolean;
}

/**
 * Starts a run from `ctx` (a tool's, or a command's host ctx); its agents are `ctx`'s subruns. In the background they
 * are detached (the caller's abort, Esc, doesn't stop them; their usage goes to the session) and the result is sent to
 * `ctx`'s session as a `workflows:result` message that starts a turn; in the foreground they are aborted with the
 * caller's run, their usage is its result's, and progress goes to `update`.
 */
function start(ctx: Ctx, input: Start, update?: (r: Run) => void): { run: Run; done: Promise<void> } {
  const s = stateOf(ctx);
  const { meta } = parseScript(input.script); // a bad script is the caller's error, before anything runs
  const run: Run = {
    id: `wf-${randomUUID().slice(0, 8)}`,
    name: meta.name,
    description: meta.description,
    script: input.script,
    args: input.args,
    status: "running",
    phases: [],
    agents: [],
    logs: [],
    started: Date.now(),
    abort: new AbortController(),
  };
  s.runs.set(run.id, run);
  s.lastScript = input.script;
  const background = input.background ?? true;
  if (!background) ctx.signal.addEventListener("abort", () => run.abort.abort(), { once: true });
  const starter = {
    ctx,
    detached: background,
    cwd: ctx.cwd,
    provider: ctx.run?.provider,
    model: ctx.run?.model,
    effort: ctx.run?.effort,
  };
  const done = execute(run, starter, input, () => {
    changed(s);
    update?.(run);
  })
    .then(
      (result) => {
        run.status = "completed";
        run.result = result;
      },
      (e) => {
        run.status = run.abort.signal.aborted ? "stopped" : "failed";
        run.error = e instanceof Error ? e.message : String(e);
      },
    )
    .finally(() => {
      run.ended = Date.now();
      changed(s);
      update?.(run);
    });
  if (background)
    void done.then(async () => {
      if (run.status === "stopped") return;
      await ctx
        .send(
          { content: resultText(run), meta: { plugin: "workflows", type: "result", details: { runId: run.id } } },
          { deliver: "after" },
        )
        .catch((e) => ctx.notify(`Delivering workflow ${run.id} failed: ${e}`, "error"));
    });
  return { run, done };
}

function find(s: State, id: string | undefined): Run {
  const run = id ? s.runs.get(id) : undefined;
  if (!run) throw new Error(id ? `No workflow run ${id}` : "Which run? Give its id");
  return run;
}

function stop(s: State, id: string | undefined): string {
  const run = find(s, id);
  if (run.status !== "running") return `${run.id} is already ${run.status}`;
  run.abort.abort();
  return `Stopping ${run.id}`;
}

const list = (s: State) => [...s.runs.values()].map(summary).join("\n") || "No workflow runs";

// ── workflows mode (keyword trigger) ──

const BACKGROUND =
  "If you do call `workflow`, it runs in the background by default: this turn will end and the result is delivered back into the conversation automatically when it finishes — that's expected, not a stall, so you do not need to stay and block. Only pass background:false if the user is waiting for the result inline in this same turn.";

const directive = (word: string) =>
  [
    "---",
    "[workflows mode armed. Decide first: if this message is a question, a trivial task, or",
    "just talk (about workflows, this repo, or the tool itself), answer it directly and stay",
    "conversational — arming authorizes the tool, it does not force it. If it is a real,",
    "decomposable request to do work, handle it by calling the `workflow` tool: write a script",
    "that fans the task out across subagents via agent()/parallel()/pipeline().",
    `Why this turn is armed: the user's message contains the trigger word "${word}".`,
    `${BACKGROUND}]`,
  ].join("\n");

const forced = (prompt: string) =>
  [
    prompt,
    "",
    "---",
    "[/workflows run — you ran an explicit command to execute a workflow for this request.",
    "Call the `workflow` tool now: write a script that fans this task out across subagents",
    "via agent()/parallel()/pipeline(). (This is a direct command, not a heuristic guess, so",
    "do not answer in prose instead of running the workflow.)",
    `${BACKGROUND}]`,
  ].join("\n");

/** The word as a token: not inside identifiers or paths (`myworkflow`, `src/workflow.ts`); "workflow" also matches "workflows". */
export function hasTrigger(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const plural = word.toLowerCase() === "workflow" ? "s?" : "";
  return new RegExp(
    `(?<![/\\p{ID_Continue}$.-])${escaped}${plural}(?![/\\p{ID_Continue}$-]|\\.\\p{ID_Continue})`,
    "iu",
  ).test(text);
}

const GATE =
  "The `workflow` tool runs multi-agent orchestration — it fans decomposable work out across subagents, and fits tasks shaped like: repo-wide inspection, independent parallel research/checks, multi-perspective review, or fan-out/fan-in synthesis. ONLY call it when the user explicitly opts in — via the workflow trigger word, `/workflows run`, or their own words (e.g. 'run a workflow', 'fan this out'). For any other task — even one that would clearly benefit — do not call it; you may briefly offer it (with a rough cost) as an option instead.";

const SCRIPT = [
  "Raw JavaScript workflow script, with no Markdown fences. Required unless `name` is given.",
  "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Add phases: [{ title: 'Phase' }] only when the workflow has named phases. With multiple phases, call phase('Exact Title') before each phase's work or set `phase` in the agent options.",
  "Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, cwd, process.cwd(), and budget. The workflow must call agent() at least once.",
  "agent() options: label, phase, schema (plain JSON Schema of an object: the agent returns that value instead of text), model ('provider/model[:thinking]'), thinking, tier ('small' | 'medium' | 'big', from ~/.hortus/workflows/model-tiers.json), isolation: 'worktree' (its own git worktree and branch, kept unless keepWorktree: false), cwd (absolute), thread (a named session that continues across calls), agentType (a ~/.hortus/agents or .hortus/agents definition binding tools, model and role), timeoutMs, retries. A failed agent resolves to null.",
  "parallel() requires functions, not promises, and returns results in input order: await parallel(items.map(item => () => agent(...))).",
  "pipeline(items, ...stages) runs stages sequentially for each item while items proceed concurrently; each stage receives (previousValue, originalItem, index).",
  "Quality helpers: verify(item, { reviewers, threshold, lens }), judgePanel(attempts, { judges, rubric }), loopUntilDry({ round, key, consecutiveEmpty, maxRounds }), completenessCheck(taskArgs, results), retry(thunk, { attempts, until }), gate(thunk, validator, { attempts }), checkpoint(question, { kind, choices, default, headless }).",
  "Imports, require() and filesystem modules are unavailable: agents do the work.",
].join(" ");

// ── the plugin ──

const plugin: CliPlugin = {
  tools: [
    tool({
      name: "workflow",
      effects: { code: ["script"] },
      description:
        "Run a JavaScript workflow that delegates work to subagents with agent(), optionally composing calls with parallel() and pipeline().",
      prompt: GATE,
      inputSchema: z.object({
        script: z.string().optional().describe(SCRIPT),
        name: z
          .string()
          .optional()
          .describe(
            `Run a saved or built-in workflow by name instead of \`script\`; its args go in \`args\`. Built-ins: ${Object.entries(
              BUILTINS,
            )
              .map(([n, b]) => `${n} (${b.description})`)
              .join("; ")}. A same-named saved workflow wins.`,
          ),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("JSON value exposed to the script as global `args`"),
        background: z
          .boolean()
          .optional()
          .describe(
            "Default true: returns at once with a run id, and the result is delivered into the conversation when it finishes. false blocks until it completes.",
          ),
        maxAgents: z.number().optional().describe("Agent cap (default 1000)"),
        concurrency: z.number().optional().describe("Maximum concurrent agents (default 8, at most 16)"),
        agentRetries: z.number().optional().describe("Retries for recoverable agent failures (default 0, at most 3)"),
        agentTimeoutMs: z
          .number()
          .optional()
          .describe("Timeout per agent in ms; only when the user asks to bound time"),
        tokenBudget: z.number().optional().describe("Soft token cap; only when the user supplies one"),
      }),
      execute: async ({ name, script: given, ...rest }, ctx) => {
        const script = name ? named(name) : given;
        if (!script)
          throw new Error(
            name ? `No saved or built-in workflow named "${name}"` : "workflow requires either `script` or `name`",
          );
        const fg = rest.background === false;
        const { run, done } = start(ctx, { ...rest, script }, fg ? (r) => ctx.update(details(r)) : undefined);
        if (!fg)
          return `Workflow "${run.name}" started in the background (run ${run.id}). Its result will be delivered into the conversation when it finishes; end your turn now unless there is other work.`;
        await done;
        if (run.status !== "completed") throw new Error(`Workflow ${run.id} ${run.status}: ${run.error}`);
        return show(run.result) ?? "undefined";
      },
    }),
    tool({
      name: "workflow_control",
      description:
        "Manage background workflow runs: list them, show one's status (phase, agents, tokens, result), or stop one by its run id.",
      inputSchema: z.object({ action: z.enum(["list", "status", "stop"]), runId: z.string().optional() }),
      execute: async ({ action, runId }, ctx) => {
        const s = stateOf(ctx);
        return action === "list" ? list(s) : action === "stop" ? stop(s, runId) : status(find(s, runId));
      },
    }),
  ],
  commands: [
    {
      name: "workflows",
      description:
        "Workflow runs: open the navigator, or list | status <id> | stop <id> | rm <id> | save <name> | run <prompt>",
      args: "[list|status|stop|rm|save|run] [arg]",
      complete: (ctx) =>
        ["list", "status", "stop", "rm", "save", "run"]
          .map((value) => ({ value }))
          .concat([...stateOf(ctx).runs.keys()].map((id) => ({ value: `status ${id}` }))),
      run: async (arg, ctx) => {
        const s = stateOf(ctx);
        const [sub = "", ...words] = arg.trim().split(/\s+/);
        const rest = words.join(" ");
        if (!sub) {
          if (!(ctx.host as { cli?: Cli }).cli) return list(s);
          s.nav = { index: 0, detail: false };
          changed(s);
          return;
        }
        if (sub === "list") return list(s);
        if (sub === "status") return status(find(s, rest));
        if (sub === "stop") return stop(s, rest);
        if (sub === "rm") {
          const run = find(s, rest);
          if (run.status === "running") throw new Error(`${run.id} is running; stop it first`);
          s.runs.delete(run.id);
          changed(s);
          return `Removed ${run.id}`;
        }
        if (sub === "save") {
          if (!/^[\w-]+$/.test(rest)) throw new Error("Usage: /workflows save <name> (letters, digits, - and _)");
          if (!s.lastScript) throw new Error("No workflow has run yet");
          mkdirSync(savedDir(), { recursive: true });
          writeFileSync(join(savedDir(), `${rest}.js`), s.lastScript);
          return `Saved as ${rest}: run it with the workflow tool's name "${rest}"`;
        }
        if (sub === "run") {
          if (!rest) throw new Error("Usage: /workflows run <prompt>");
          void ctx.send({ content: forced(rest), meta: { plugin: "workflows", type: "run" } }, { deliver: "steer" });
          return;
        }
        throw new Error(`Unknown subcommand ${sub}`);
      },
    },
    {
      name: "workflows-trigger",
      description: "Keyword workflow trigger: on | off | set <word> | reset | status",
      args: "[on|off|set <word>|reset|status]",
      run: (arg, ctx) => {
        const s = stateOf(ctx);
        const [sub = "status", word] = arg.trim().split(/\s+/);
        if (sub === "on") s.trigger = "workflow";
        else if (sub === "off") s.trigger = false;
        else if (sub === "reset") s.trigger = "workflow";
        else if (sub === "set") {
          if (!word || word.startsWith("/")) throw new Error("Usage: /workflows-trigger set <word>");
          s.trigger = word;
        } else if (sub !== "status") throw new Error(`Unknown subcommand ${sub}`);
        // ponytail: kept for this agent only; persist to ~/.hortus/workflows/settings.json if it should outlive it
        return s.trigger ? `Workflows keyword trigger: "${s.trigger}"` : "Workflows keyword trigger off";
      },
    },
    {
      name: "adversarial-review",
      description: "Background workflow: findings cross-checked by skeptical reviewers",
      args: "<task>",
      run: (arg, ctx) => background(ctx, "adversarial-review", { task: arg.trim() }, !!arg.trim()),
    },
    {
      name: "multi-perspective",
      description: "Background workflow: independent angles, then a synthesis",
      args: '"<topic>" [angle …]',
      run: (arg, ctx) => {
        const [topic, ...perspectives] = [...arg.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? "");
        return background(ctx, "multi-perspective", { topic, perspectives }, !!topic);
      },
    },
  ],
  on: {
    input: (p, ctx) => {
      const s = stateOf(ctx);
      if (ctx.run && p.source === "user" && s.trigger && hasTrigger(p.text, s.trigger)) s.armed.add(ctx.run.id);
    },
    prompt: (p, ctx) => {
      const s = stateOf(ctx);
      if (ctx.run && s.armed.delete(ctx.run.id) && s.trigger) p.system.push(directive(s.trigger));
    },
    // an armed run that ended before its `prompt` (a provider error)
    run_end: (_, ctx) => {
      if (ctx.run) stateOf(ctx).armed.delete(ctx.run.id);
    },
    close: (_, ctx) => {
      for (const run of stateOf(ctx).runs.values()) run.abort.abort();
    },
  },
  cli: {
    aboveInput: Panel,
    transcript: Navigator,
    keys: (input, key, _cli, ctx) => {
      const ui = stateOf(ctx);
      const nav = ui.nav;
      if (!nav) return false;
      const runs = [...ui.runs.values()];
      if (key.escape || input === "q") ui.nav = nav.detail && input !== "q" ? { ...nav, detail: false } : undefined;
      else if (key.upArrow) nav.index = Math.max(0, nav.index - 1);
      else if (key.downArrow) nav.index = Math.min(runs.length - 1, nav.index + 1);
      else if (key.return || key.rightArrow) nav.detail = runs.length > 0;
      else if (key.leftArrow) nav.detail = false;
      else if (input === "x") runs[nav.index]?.abort.abort();
      changed(ui);
      return true;
    },
    entries: { "workflows:result": line("workflow result"), "workflows:run": line("/workflows run") },
    tools: {
      workflow: linesRenderer(({ call, result, details: d }) => {
        const input = call.input as { name?: string; script?: string };
        const title: Span[] = [
          { text: "workflow ", color: theme.toolTitle, bold: true },
          { text: input.name ?? "script" },
        ];
        const p = d as Details | undefined;
        const body: Span[][] = p
          ? [[{ text: p.line, color: theme.dim }], ...p.agents.map((a) => [{ text: `  ${a}`, color: theme.dim }])]
          : result
            ? result.output
                .split("\n")
                .slice(0, 6)
                .map((l) => [{ text: l, color: result.isError ? theme.red : theme.dim }])
            : [];
        return [title, ...body];
      }),
    },
  },
};
export default plugin;

function background(ctx: Ctx, name: string, args: Record<string, unknown>, ok: boolean): string {
  if (!ok) throw new Error(`Usage: /${name} ${name === "multi-perspective" ? '"<topic>" [angle …]' : "<task>"}`);
  const { run } = start(ctx, { script: named(name) as string, args });
  return `Started ${run.name} in the background (${run.id}); /workflows to watch it. Its report arrives in the conversation.`;
}

// ── TUI ──

/** this agent's state, re-rendering on each change */
function useWorkflows(): State {
  const s = stateOf(usePluginCtx());
  useSyncExternalStore(
    (l) => {
      s.listeners.add(l);
      return () => s.listeners.delete(l);
    },
    () => s.version,
  );
  return s;
}

interface Details {
  line: string;
  agents: string[];
}

/** A foreground run's progress, as its tool block shows it. */
const details = (r: Run): Details => ({
  line: summary(r),
  agents: r.agents
    .filter((a) => a.status === "running")
    .map((a) => `${a.label}${a.activity ? ` · ${a.activity}` : ""}`),
});

const MARK = { queued: "·", running: "◆", done: "✓", failed: "✗" } as const;

function agentLine(a: Run["agents"][number]): string {
  return `${MARK[a.status]} ${a.label}${a.model ? ` (${a.model})` : ""}${a.activity ? ` · ${a.activity}` : ""} · ${tokens(a.tokens)} tok${a.error ? ` · ${a.error}` : ""}`;
}

/** Live progress of running workflows above the input. */
function Panel({ Default }: { Default: ComponentType }) {
  const ui = useWorkflows();
  useTheme();
  const running = [...ui.runs.values()].filter((r) => r.status === "running");
  return (
    <Box flexDirection="column" flexShrink={0}>
      {running.map((r) => (
        <Box key={r.id} flexDirection="column" marginTop={1} paddingX={1}>
          <Text color={theme.accent}>{`◆ ${summary(r)}`}</Text>
          {r.agents
            .filter((a) => a.status === "running")
            .slice(0, 6)
            .map((a) => (
              <Text key={a.id} color={theme.dim} wrap="truncate-end">{`  ${agentLine(a)}`}</Text>
            ))}
        </Box>
      ))}
      <Default />
    </Box>
  );
}

/** `/workflows`: the runs, then one run's phases, agents, logs and result, in place of the transcript. */
function Navigator({ Default }: { Default: ComponentType }) {
  const ui = useWorkflows();
  useTheme();
  const nav = ui.nav;
  if (!nav) return <Default />;
  const runs = [...ui.runs.values()];
  const run = runs[nav.index];
  if (nav.detail && run)
    return (
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <Text color={theme.accent} bold>{`${run.name} — ${run.description}`}</Text>
        <Text color={theme.dim}>{summary(run)}</Text>
        {(run.phases.length ? run.phases : [undefined]).map((p) => (
          <Box key={p ?? ""} flexDirection="column" marginTop={1}>
            {p && <Text bold>{`${p === run.phase ? "▸ " : "  "}${p}`}</Text>}
            {run.agents
              .filter((a) => a.phase === p || (!p && !a.phase))
              .map((a) => (
                <Text key={a.id} wrap="truncate-end" color={a.status === "failed" ? theme.red : theme.text}>
                  {`  ${agentLine(a)}`}
                </Text>
              ))}
          </Box>
        ))}
        {run.logs.slice(-5).map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: log lines are positional
          <Text key={i} color={theme.dim} wrap="truncate-end">{`log: ${l}`}</Text>
        ))}
        {run.status !== "running" && (
          <Text wrap="truncate-end">
            {run.error ? `error: ${run.error}` : clip(run.result).split("\n").slice(0, 10).join("\n")}
          </Text>
        )}
        <Text color={theme.dim}>esc back · x stop · q quit</Text>
      </Box>
    );
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Text color={theme.accent} bold>
        Workflows
      </Text>
      {runs.length ? (
        runs.map((r, i) => (
          <Text key={r.id} wrap="truncate-end" inverse={i === nav.index}>
            {`${MARK[r.status === "running" ? "running" : r.status === "completed" ? "done" : "failed"]} ${summary(r)}`}
          </Text>
        ))
      ) : (
        <Text color={theme.dim}>No workflow runs yet</Text>
      )}
      <Text color={theme.dim}>↑/↓ select · enter open · x stop · esc close</Text>
    </Box>
  );
}

function line(label: string): EntryRenderer {
  return {
    // biome-ignore lint/correctness/noComponentHookFactories: made once per label, at load
    Render: ({ entry }) => (
      <Text wrap="truncate-end">
        <Text color={theme.accent}>{`◆ ${label} `}</Text>
        <Text color={theme.dim}>{entry.text.trim().split("\n")[0]}</Text>
      </Text>
    ),
  };
}
