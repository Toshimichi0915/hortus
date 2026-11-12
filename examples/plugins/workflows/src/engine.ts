import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import {
  addUsage,
  type Ctx,
  EFFORTS,
  type Effort,
  hortusDir,
  parseFrontmatter,
  type Plugin,
  type Session,
  tool,
  type Usage,
} from "@hortus/core";
import { z } from "zod";

const exec = promisify(execFile);

export const MAX_CONCURRENCY = 16;
export const MAX_AGENTS = 1000;
const MAX_RETRIES = 3;

export interface Meta {
  name: string;
  description: string;
  phases?: { title: string }[];
}

export interface AgentRow {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  /** `provider/model`, once its run started */
  model?: string;
  status: "queued" | "running" | "done" | "failed";
  /** input + output tokens so far */
  tokens: number;
  /** the tool it called last */
  activity?: string;
  result?: unknown;
  error?: string;
  worktree?: string;
}

export interface Run {
  id: string;
  name: string;
  description: string;
  script: string;
  args?: unknown;
  status: "running" | "completed" | "failed" | "stopped";
  phases: string[];
  phase?: string;
  agents: AgentRow[];
  logs: string[];
  result?: unknown;
  error?: string;
  usage?: Usage;
  started: number;
  ended?: number;
  abort: AbortController;
}

export interface Limits {
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number;
  tokenBudget?: number;
}

/** Where agents start from: the ctx whose `subrun` spawns them, and the caller's run settings they inherit. */
export interface Starter {
  ctx: Ctx;
  /** its agents outlive the caller's abort (`SubrunOptions.detached`) */
  detached?: boolean;
  cwd: string;
  provider?: string;
  model?: string;
  effort?: Effort;
}

export interface AgentOptions {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  model?: string;
  thinking?: string;
  tier?: string;
  isolation?: "worktree" | false;
  keepWorktree?: boolean;
  cwd?: string;
  thread?: string;
  agentType?: string;
  timeoutMs?: number | null;
  retries?: number;
}

/** A failure; non-recoverable ones (limits, invalid options) halt the run, recoverable ones resolve `agent()` to null. */
export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly recoverable: boolean,
  ) {
    super(message);
  }
}

/** Strips Markdown fences and splits off `export const meta = {...}`, which must be the first statement. */
export function parseScript(script: string): { meta: Meta; body: string } {
  const src = script.trim().replace(/^```[a-z]*\n([\s\S]*?)\n?```$/i, "$1");
  const head = /^\s*export\s+const\s+meta\s*=/.exec(src);
  if (!head) throw new Error("`export const meta = { name, description, phases }` must be the first statement");
  // the literal ends at the first `}` that makes it a whole expression
  for (let end = src.indexOf("}", head[0].length); end >= 0; end = src.indexOf("}", end + 1)) {
    const literal = `(${src.slice(head[0].length, end + 1)})`;
    try {
      new vm.Script(literal);
    } catch {
      continue;
    }
    const meta = vm.runInNewContext(literal, {}, { timeout: 100 }) as Meta;
    if (typeof meta?.name !== "string" || !meta.name.trim()) throw new Error("meta.name must be a non-empty string");
    if (typeof meta.description !== "string" || !meta.description.trim())
      throw new Error("meta.description must be a non-empty string");
    if (
      meta.phases !== undefined &&
      !(Array.isArray(meta.phases) && meta.phases.every((p) => typeof p?.title === "string"))
    )
      throw new Error("meta.phases must be an array of { title }");
    return { meta, body: src.slice(end + 1).replace(/^\s*;/, "") };
  }
  throw new Error("meta must be an object literal");
}

// ── agent definitions (agentType) and model tiers ──

export interface AgentDef {
  name: string;
  description?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  thinking?: string;
  isolation?: "worktree";
  prompt: string;
}

const list = (v: string | undefined) =>
  v
    ?.replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);

/** `~/.hortus/agents/*.md`, then `<cwd>/.hortus/agents/*.md` (the project's win): frontmatter binds tools/model, the body is the role. */
export function agentDefs(cwd: string): Map<string, AgentDef> {
  const defs = new Map<string, AgentDef>();
  for (const dir of [join(hortusDir(), "agents"), join(cwd, ".hortus", "agents")]) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {}
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      let fm: Record<string, string | undefined> = {};
      let body = text;
      try {
        const parsed = parseFrontmatter(text);
        body = parsed.body;
        fm = Object.fromEntries(
          Object.entries(parsed.meta).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(",") : v == null ? undefined : String(v),
          ]),
        );
      } catch {}
      const name = fm.name || basename(f, ".md");
      defs.set(name, {
        name,
        description: fm.description,
        tools: list(fm.tools),
        disallowedTools: list(fm.disallowedTools),
        model: fm.model,
        thinking: fm.thinking,
        isolation: fm.isolation === "worktree" ? "worktree" : undefined,
        prompt: body.trim(),
      });
    }
  }
  return defs;
}

/** `~/.hortus/workflows/model-tiers.json`: `{ tiers: { small: "provider/model:effort", ... } }`. */
function tiers(): Record<string, string> | undefined {
  try {
    return JSON.parse(readFileSync(join(hortusDir(), "workflows", "model-tiers.json"), "utf8")).tiers;
  } catch {
    return undefined;
  }
}

/** `provider/model:effort`, `model:effort` or `model`; Pi's "minimal" thinking is hortus's "low". */
export function parseModel(spec: string): { provider?: string; model: string; effort?: Effort } {
  let rest = spec.trim();
  let effort: string | undefined;
  const colon = rest.lastIndexOf(":");
  const suffix = rest.slice(colon + 1);
  if (colon > 0 && (suffix === "minimal" || (EFFORTS as readonly string[]).includes(suffix))) {
    effort = suffix === "minimal" ? "low" : suffix;
    rest = rest.slice(0, colon);
  }
  const slash = rest.indexOf("/");
  return {
    ...(slash > 0 && { provider: rest.slice(0, slash) }),
    model: slash > 0 ? rest.slice(slash + 1) : rest,
    ...(effort && { effort: effort as Effort }),
  };
}

// ── worktrees ──

export interface Worktree {
  cwd: string;
  branch: string;
  root: string;
}

/** A git worktree on its own branch under `<repo>/.hortus/worktrees/`, so parallel agents can edit without conflict. */
export async function createWorktree(cwd: string, name: string): Promise<Worktree> {
  const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 30_000 });
  const root = stdout.trim();
  const id = `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent"
  }-${randomUUID().slice(0, 8)}`;
  const path = join(root, ".hortus", "worktrees", id);
  const branch = `hortus/wf/${id}`;
  await exec("git", ["-C", root, "worktree", "add", "-b", branch, path, "HEAD"], { timeout: 30_000 });
  return { cwd: path, branch, root };
}

export async function removeWorktree(wt: Worktree): Promise<void> {
  await exec("git", ["-C", wt.root, "worktree", "remove", "--force", wt.cwd]).catch(() =>
    rm(wt.cwd, { recursive: true, force: true }),
  );
  await exec("git", ["-C", wt.root, "branch", "-D", wt.branch]).catch(() => {});
}

// ── the runtime ──

const STRUCTURED = [
  "Structured output:",
  "- Your final action MUST be a structured_output tool call.",
  "- The structured_output arguments are the return value of this subagent.",
  "- Do not emit a prose final answer instead of structured_output.",
  "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
].join("\n");

const total = (u: Usage | undefined) => (u ? u.input + u.output : 0);

function limiter(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

const clamp = (v: unknown, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.floor(v)) : fallback;

/**
 * Runs `run.script` in a `node:vm` context whose globals are the workflow API (`agent`, `parallel`, `pipeline`, `phase`,
 * `log`, the quality helpers, `checkpoint`, `args`, `cwd`, `budget`). Each `agent()` is a subrun of `starter.ctx`: its
 * own cwd (or git worktree), model, tools and role, without this plugin (no recursion). `changed` is called on every
 * progress change. Resolves with the script's return value.
 */
export async function execute(run: Run, starter: Starter, limits: Limits, changed: () => void): Promise<unknown> {
  const { meta, body } = parseScript(run.script);
  const signal = run.abort.signal;
  const maxAgents = clamp(limits.maxAgents, MAX_AGENTS, MAX_AGENTS) || 1;
  const limit = limiter(clamp(limits.concurrency, MAX_CONCURRENCY, 8) || 1);
  const retries = clamp(limits.agentRetries, MAX_RETRIES, 0);
  const defs = agentDefs(starter.cwd);
  const threads = new Map<string, { session: Session; busy: boolean }>();
  let spent = 0;
  let calls = 0;
  for (const p of meta.phases ?? []) run.phases.push(p.title);

  const log = (message: unknown) => {
    run.logs.push(String(message));
    changed();
  };
  const aborted = () => new WorkflowError("workflow aborted", false);
  const check = () => {
    if (signal.aborted) throw aborted();
  };

  const agent = async (prompt: string, o: AgentOptions = {}): Promise<unknown> => {
    check();
    if (calls >= maxAgents) throw new WorkflowError(`Agent limit exceeded (${calls}/${maxAgents})`, false);
    if (limits.tokenBudget != null && spent >= limits.tokenBudget)
      throw new WorkflowError(`Token budget exhausted (${spent}/${limits.tokenBudget})`, false);
    if (o.timeoutMs != null && !(Number.isFinite(o.timeoutMs) && o.timeoutMs >= 1 && o.timeoutMs <= 2 ** 31 - 1))
      throw new WorkflowError("agent() timeoutMs must be a finite number of milliseconds in [1, 2^31-1]", false);
    const def = o.agentType ? defs.get(o.agentType) : undefined;
    const phase = o.phase ?? run.phase;
    const id = ++calls;
    const row: AgentRow = {
      id,
      label: o.label ?? `${phase ?? "agent"} #${id}`,
      phase,
      prompt,
      status: "queued",
      tokens: 0,
    };
    run.agents.push(row);
    changed();
    const spec = resolveModel(o, def, starter, log);
    let cwd = starter.cwd;
    if (o.cwd !== undefined) {
      if (typeof o.cwd !== "string" || !isAbsolute(o.cwd))
        throw new WorkflowError("agent cwd must be an absolute directory", false);
      try {
        cwd = realpathSync(o.cwd);
        if (!statSync(cwd).isDirectory()) throw new Error();
      } catch {
        throw new WorkflowError(`agent cwd must be an existing directory: ${o.cwd}`, false);
      }
    }
    const isolation = o.isolation === false ? undefined : (o.isolation ?? def?.isolation);
    return limit(async () => {
      check();
      row.status = "running";
      changed();
      let wt: Worktree | undefined;
      if (isolation === "worktree") {
        try {
          wt = await createWorktree(cwd, `${run.id}-${id}-${row.label}`);
        } catch (e) {
          throw new WorkflowError(`worktree isolation failed for "${row.label}": ${(e as Error).message}`, false);
        }
        row.worktree = wt.cwd;
        if (o.cwd === undefined) cwd = wt.cwd;
      }
      const timeout = o.timeoutMs !== undefined ? o.timeoutMs : limits.agentTimeoutMs;
      const attempts = clamp(o.retries, MAX_RETRIES, retries) + 1;
      try {
        for (let attempt = 1; ; attempt++) {
          try {
            const value = await spawn(prompt, { ...o, ...spec, cwd, def, timeout, isolated: !!wt });
            row.status = "done";
            row.result = value;
            return value;
          } catch (e) {
            const err = signal.aborted
              ? aborted()
              : e instanceof WorkflowError
                ? e
                : new WorkflowError(String(e), true);
            if (err.recoverable && attempt < attempts) {
              log(`agent "${row.label}" attempt ${attempt}/${attempts} failed: ${err.message}; retrying`);
              await new Promise((r) => setTimeout(r, Math.min(250 * 2 ** (attempt - 1), 2000)));
              check();
              continue;
            }
            row.status = "failed";
            row.error = err.message;
            if (!err.recoverable) throw err;
            log(`agent "${row.label}" exhausted ${attempts} attempt${attempts === 1 ? "" : "s"}: ${err.message}`);
            return null;
          }
        }
      } finally {
        row.activity = undefined;
        changed();
        if (wt) {
          if (o.keepWorktree === false) await removeWorktree(wt);
          else log(`worktree kept: ${wt.cwd} (${wt.branch})`);
        }
      }
    });

    /** One attempt: a subrun, with a child-only plugin that adds the role, `structured_output`, and reports progress. */
    async function spawn(
      task: string,
      a: AgentOptions &
        ReturnType<typeof resolveModel> & { def?: AgentDef; timeout?: number | null; isolated: boolean },
    ): Promise<unknown> {
      const capture: { called: boolean; value?: unknown } = { called: false };
      const instructions: string[] = [];
      if (a.def?.prompt) instructions.push(a.def.prompt);
      else if (a.agentType) instructions.push(`Act as workflow subagent type: ${a.agentType}`);
      if (phase) instructions.push(`Workflow phase: ${phase}`);
      if (a.isolated) instructions.push("Requested isolation: worktree");
      if (a.schema) instructions.push(STRUCTURED);
      const validate = a.schema ? z.fromJSONSchema(a.schema as never) : undefined;
      const child: Plugin = {
        tools: validate
          ? [
              tool({
                name: "structured_output",
                description: "Return the final machine-readable result for this subagent task.",
                inputSchema: z.looseObject({}),
                jsonSchema: a.schema,
                execute: async (input) => {
                  capture.value = validate.parse(input);
                  capture.called = true;
                  return "Structured output received.";
                },
              }),
            ]
          : [],
        on: {
          run_start: (p) => {
            row.model = `${p.provider}/${p.model}`;
            changed();
          },
          prompt: (p) => {
            if (instructions.length) p.system.push(instructions.join("\n\n"));
          },
          tool_call: (p) => {
            row.activity = p.call.name;
            changed();
          },
          message: (m) => {
            if (m.role !== "assistant" || !m.usage) return;
            row.tokens += total(m.usage);
            spent += total(m.usage);
            run.usage = addUsage(run.usage, m.usage);
            changed();
          },
          // structured_output ends the agent, like Pi's `terminate: true`
          turn_end: (p) => {
            if (capture.called) p.stop = true;
          },
        },
      };
      const allowed = a.def?.tools ?? (a.def?.disallowedTools && starter.ctx.tools.map((t) => t.name));
      const tools = allowed
        ?.filter((n) => !a.def?.disallowedTools?.includes(n))
        .concat(validate ? ["structured_output"] : []);
      const thread = a.thread ? threads.get(a.thread) : undefined;
      if (thread?.busy)
        throw new WorkflowError(
          `agent thread "${a.thread}" is already running; same-thread calls must be sequential`,
          false,
        );
      const timer = a.timeout != null ? AbortSignal.timeout(a.timeout) : undefined;
      const sub = starter.ctx.subrun(task, {
        cwd: a.cwd,
        ...(a.provider && { provider: a.provider }),
        ...(a.model && { model: a.model }),
        ...(a.effort && { effort: a.effort }),
        ...(tools && { tools }),
        ...(starter.detached && { detached: true }),
        plugins: { disable: ["workflows", "subagent"], extra: [{ name: "workflows:agent", plugin: child }] },
        signal: timer ? AbortSignal.any([signal, timer]) : signal,
        ...(thread && { session: thread.session }),
      });
      if (a.thread) threads.set(a.thread, { session: sub.session, busy: true });
      try {
        let end = await sub.done;
        // bounded repair: a model that answered in prose is asked for the tool call
        for (let i = 0; validate && !capture.called && end && !end.error && !end.aborted && i < 2; i++)
          end = await sub.send(
            "You did not call the structured_output tool. Call structured_output now as your only action, with the required fields filled in. Do not write a prose answer.",
            { deliver: "steer" },
          );
        if (timer?.aborted) throw new WorkflowError(`agent timed out after ${a.timeout}ms`, true);
        if (end?.aborted) throw new WorkflowError(`agent aborted by ${end.aborted.by}`, true);
        if (end?.error !== undefined) throw new WorkflowError(`agent failed: ${String(end.error)}`, true);
        if (validate) {
          if (!capture.called) throw new WorkflowError("Subagent did not produce valid structured_output", true);
          return capture.value;
        }
        const last = [...(end?.messages ?? [])].reverse().find((m) => m.role === "assistant");
        const text = last?.role === "assistant" ? last.text : "";
        if (!text.trim()) throw new WorkflowError("Subagent produced no assistant output", true);
        return text;
      } finally {
        const t = a.thread && threads.get(a.thread);
        if (t) t.busy = false;
      }
    }
  };

  const settle = async (index: number, kind: string, fn: () => unknown) => {
    try {
      return await fn();
    } catch (e) {
      if (signal.aborted || (e instanceof WorkflowError && !e.recoverable)) throw e;
      log(`${kind}[${index}] failed: ${(e as Error).message ?? e}`);
      return null;
    }
  };

  const parallel = async (thunks: (() => unknown)[]) => {
    check();
    if (!Array.isArray(thunks) || thunks.some((t) => typeof t !== "function"))
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    return Promise.all(thunks.map((t, i) => settle(i, "parallel", t)));
  };

  const pipeline = async (items: unknown[], ...stages: ((prev: unknown, item: unknown, i: number) => unknown)[]) => {
    check();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((s) => typeof s !== "function")) throw new TypeError("pipeline() stages must be functions");
    return Promise.all(
      items.map((item, i) =>
        settle(i, "pipeline", async () => {
          let value = item;
          for (const stage of stages) {
            check();
            value = await stage(value, item, i);
          }
          return value;
        }),
      ),
    );
  };

  const phase = (title: string) => {
    run.phase = title;
    if (!run.phases.includes(title)) run.phases.push(title);
    changed();
  };

  const verify = async (
    item: unknown,
    opts: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ) => {
    const lenses = opts.lens ? [opts.lens].flat() : [];
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const votes = (
      await parallel(
        Array.from(
          { length: opts.reviewers ?? 2 },
          (_, i) => () =>
            agent(
              `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`,
              { label: `verify ${i + 1}`, schema: VERIFY },
            ),
        ),
      )
    ).filter(Boolean) as { real?: boolean; reason?: string }[];
    const realCount = votes.filter((v) => v.real).length;
    return {
      real: votes.length > 0 && realCount / votes.length >= (opts.threshold ?? 0.5),
      realCount,
      total: votes.length,
      votes,
    };
  };

  const judgePanel = async (attempts: unknown[], opts: { judges?: number; rubric?: string } = {}) => {
    const rubric = opts.rubric ?? "overall quality and correctness";
    const scored = (
      await parallel(
        (Array.isArray(attempts) ? attempts : []).map((attempt, index) => async () => {
          const text = typeof attempt === "string" ? attempt : JSON.stringify(attempt);
          const judgments = (
            await parallel(
              Array.from(
                { length: opts.judges ?? 3 },
                (_, j) => () =>
                  agent(
                    `Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`,
                    {
                      label: `judge ${index + 1}.${j + 1}`,
                      schema: JUDGE,
                    },
                  ),
              ),
            )
          ).filter(Boolean) as { score?: number }[];
          const score = judgments.length
            ? judgments.reduce((s, v) => s + (Number(v.score) || 0), 0) / judgments.length
            : 0;
          return { index, attempt, score, judgments };
        }),
      )
    ).filter(Boolean) as { index: number; score: number }[];
    return scored.reduce<(typeof scored)[number] | undefined>(
      (best, s) => (!best || s.score > best.score ? s : best),
      undefined,
    );
  };

  const loopUntilDry = async (opts: {
    round: (i: number) => unknown[] | Promise<unknown[]>;
    key?: (item: unknown) => string;
    consecutiveEmpty?: number;
    maxRounds?: number;
  }) => {
    if (typeof opts?.round !== "function") throw new TypeError("loopUntilDry requires { round: (i) => items[] }");
    const key = opts.key ?? ((x: unknown) => JSON.stringify(x));
    const seen = new Set<string>();
    const all: unknown[] = [];
    for (let r = 0, dry = 0; r < (opts.maxRounds ?? 50) && dry < Math.max(1, opts.consecutiveEmpty ?? 2); r++) {
      let items: unknown[];
      try {
        items = (await opts.round(r)) ?? [];
      } catch (e) {
        if (e instanceof WorkflowError && !e.recoverable && !signal.aborted) break; // budget / agent limit: partial result
        throw e;
      }
      const fresh = (Array.isArray(items) ? items : []).filter((x) => x != null && !seen.has(key(x)));
      dry = fresh.length ? 0 : dry + 1;
      for (const x of fresh) {
        seen.add(key(x));
        all.push(x);
      }
    }
    return all;
  };

  const completenessCheck = (taskArgs: unknown, results: unknown) =>
    agent(
      `Given the task and the results gathered so far, list what is still MISSING (modalities not covered, claims unverified, gaps). Be specific and concise.\n\nTask:\n${JSON.stringify(taskArgs)}\n\nResults so far:\n${JSON.stringify(results).slice(0, 4000)}`,
      { label: "completeness critic", schema: COMPLETENESS },
    );

  const retry = async (
    thunk: (attempt: number) => unknown,
    opts: { attempts?: number; until?: (r: unknown) => boolean } = {},
  ) => {
    let last: unknown;
    for (let i = 0; i < Math.max(1, opts.attempts ?? 3); i++) {
      last = await thunk(i);
      if (!opts.until || opts.until(last)) return last;
    }
    return last;
  };

  const gate = async (
    thunk: (feedback: string | undefined, attempt: number) => unknown,
    validator: (v: unknown) => { ok: boolean; feedback?: string } | Promise<{ ok: boolean; feedback?: string }>,
    opts: { attempts?: number } = {},
  ) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let feedback: string | undefined;
    let value: unknown;
    for (let i = 0; i < attempts; i++) {
      value = await thunk(feedback, i);
      const verdict = await validator(value);
      if (verdict?.ok) return { ok: true, value, attempts: i + 1 };
      feedback = verdict?.feedback;
    }
    return { ok: false, value, attempts };
  };

  /** A human gate through `ask`; with nobody to answer, `default` (true), or a failure with `headless: "abort"`. */
  const checkpoint = async (
    question: string,
    opts: {
      kind?: "confirm" | "input" | "select";
      choices?: string[];
      default?: unknown;
      headless?: "default" | "abort";
    } = {},
  ) => {
    check();
    const kind = opts.kind ?? "confirm";
    const answer = await starter.ctx.ask({
      question: `Workflow checkpoint: ${question}`,
      ...(kind === "confirm" && { options: [{ label: "Yes" }, { label: "No" }] }),
      ...(kind === "select" && { options: (opts.choices ?? []).map((label) => ({ label })) }),
      ...(kind === "input" && { allowText: true }),
    });
    if (answer === undefined) {
      if (opts.headless === "abort")
        throw new WorkflowError(`checkpoint "${question}" needs human input but none is available`, false);
      return opts.default ?? true;
    }
    return kind === "confirm" ? answer === "Yes" : answer;
  };

  const context = vm.createContext({
    agent,
    parallel,
    pipeline,
    phase,
    log,
    verify,
    judgePanel,
    loopUntilDry,
    completenessCheck,
    retry,
    gate,
    checkpoint,
    args: run.args,
    cwd: starter.cwd,
    process: Object.freeze({ cwd: () => starter.cwd }),
    budget: Object.freeze({
      total: limits.tokenBudget ?? null,
      spent: () => spent,
      remaining: () => (limits.tokenBudget == null ? Infinity : Math.max(0, limits.tokenBudget - spent)),
    }),
    console: { log, info: log, warn: (m: unknown) => log(`[warn] ${m}`), error: (m: unknown) => log(`[error] ${m}`) },
  });
  const result = await new vm.Script(`"use strict";(async () => {\n${body}\n})()`, {
    filename: `${meta.name}.js`,
  }).runInContext(context);
  if (calls === 0) throw new Error("The workflow must call agent() at least once");
  if (run.agents.length && run.agents.every((a) => a.result == null))
    log("⚠ Workflow produced no usable results: every agent came back empty or failed (consider agentRetries)");
  return result;
}

function resolveModel(o: AgentOptions, def: AgentDef | undefined, starter: Starter, log: (m: string) => void) {
  let spec = o.model ?? def?.model;
  if (!spec && o.tier) {
    const map = tiers();
    if (map && !map[o.tier])
      throw new WorkflowError(
        `Unknown model tier "${o.tier}" (model-tiers.json has ${Object.keys(map).join(", ")})`,
        false,
      );
    spec = map?.[o.tier];
    if (!spec) log(`no model tiers configured: "${o.tier}" uses the caller's model`);
  }
  const parsed = spec ? parseModel(spec) : undefined;
  const thinking = o.thinking ?? def?.thinking;
  const effort = thinking ? (thinking === "minimal" ? "low" : thinking) : parsed?.effort;
  if (effort && !(EFFORTS as readonly string[]).includes(effort))
    throw new WorkflowError(`Unknown thinking level "${effort}"`, false);
  return {
    provider: parsed?.provider ?? starter.provider,
    model: parsed?.model ?? starter.model,
    effort: (effort as Effort | undefined) ?? starter.effort,
  };
}

const VERIFY = {
  type: "object",
  properties: { real: { type: "boolean" }, reason: { type: "string" } },
  required: ["real"],
};
const JUDGE = {
  type: "object",
  properties: { score: { type: "number" }, reason: { type: "string" } },
  required: ["score"],
};
const COMPLETENESS = {
  type: "object",
  properties: { complete: { type: "boolean" }, missing: { type: "array", items: { type: "string" } } },
  required: ["complete"],
};
