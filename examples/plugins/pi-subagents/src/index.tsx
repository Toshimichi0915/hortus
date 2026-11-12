/**
 * `pi-subagents` (Nico Bailon, MIT), ported: delegation to focused child agents defined as markdown files. A `subagent`
 * tool runs one agent, parallel `tasks`, a `chain`, or a workflow script (`runs.run`/`runs.all`), in the foreground
 * (`ctx.subrun`, progress through `ctx.update`) or in the background (a detached `hortus --rpc` child per agent, whose
 * completion wakes the parent with `ctx.send`), and manages runs (`list`, `status`, `steer`, `interrupt`, `stop`,
 * `resume`). Children reach the parent through `contact_supervisor` (`ctx.ask`; a background child's ask is relayed to
 * the parent model, which answers with `subagent_supervisor`). Other plugins use the bus (`subagents:rpc:v1:request`,
 * `pi-subagents:runtime-agent-register:v1`, the `subagent:*` events). The bundled agents and prompt templates are
 * pi-subagents' own (LICENSE.pi-subagents).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  type CliPlugin,
  createStore,
  hortusBin,
  linesRenderer,
  type Span,
  type StoreApi,
  theme,
  usePluginCtx,
  useStore,
} from "@hortus/cli";
import {
  type Command,
  type Ctx,
  childDir,
  type Effort,
  findSkills,
  hortusDir,
  listSessions,
  type Message,
  openSession,
  type PluginEntry,
  readSession,
  type Session,
  type SubRun,
  type Tool,
  type ToolCtx,
  tool,
} from "@hortus/core";
import { Box, Text } from "ink";
import type { ComponentType } from "react";
import { z } from "zod";
import { type AgentDef, type AgentOverride, discoverAgents, effortOf, findAgent, splitFrontmatter } from "./agents.ts";
import { boundary, type ChildConfig, childPlugin, lastText, type ResultFile } from "./child.ts";

export type Status = "running" | "completed" | "failed" | "paused" | "stopped";

/** A child run as status, the fleet, notices and the bus show it (also saved as a `<plugin>:run` entry). */
export interface RunRecord {
  id: string;
  agent: string;
  task: string;
  mode: "foreground" | "background";
  status: Status;
  cwd: string;
  model?: string;
  context: "fresh" | "fork";
  startedAt: number;
  endedAt?: number;
  output?: string;
  error?: string;
  /** the last thing it did (a tool, a line of text) */
  activity?: string;
  /** its last `contact_supervisor` progress update */
  progress?: string;
  turns: number;
  toolCalls: number;
  /** its own session: a file child of the parent's (a background one's through `--parent`) */
  session?: { id: string; path?: string };
  /** the session that started it */
  parentSession?: string;
  /** background */
  pid?: number;
  resultFile?: string;
  logFile?: string;
  delivered?: boolean;
  resumedFrom?: string;
}

/** Plugin config: `~/.hortus/<plugin>.json`. */
export interface Config {
  maxSubagentDepth?: number;
  timeoutMs?: number;
  /** a single agent runs in the background unless the call (or agent) says otherwise; default true */
  asyncByDefault?: boolean;
  defaultSubagentContext?: "fresh" | "fork";
  /** "lazy": fresh sessions get `subagents_enable` instead of `subagent` until it is called */
  toolActivation?: "eager" | "lazy";
  agentOverrides?: Record<string, AgentOverride>;
}

/**
 * Nesting limits of a session: `depth` is its runs' (`ctx.run.depth`, a background child's counted from its parent
 * session through `--parent`); the rest from the environment (a background child's) or the config.
 */
interface Limits {
  depth: number;
  maxDepth: number;
  allowedAgents?: string[];
}

interface Live {
  ctx: Ctx;
  handle?: SubRun;
  proc?: ChildProcess;
  write?: (cmd: object) => void;
  stop?: () => void;
}

/** A background child's question, waiting for `subagent_supervisor({ action: "reply" })`. */
interface Pending {
  replyTo: string;
  runId: string;
  agent: string;
  question: string;
  reason?: string;
  answer: (text: string) => void;
}

interface State {
  runs: Map<string, RunRecord>;
  live: Map<string, Live>;
  /** foreground children's sessions, for status transcripts and resume */
  sessions: Map<string, Session>;
  limits: Map<string, Limits>;
  pending: Map<string, Pending>;
  /** registered over the bus */
  runtime: Map<string, AgentDef>;
  /** each run's last request system prompt, for forked children */
  systems: Map<string, string>;
  /** lazy activation: the tools held back, by run */
  stash: Map<string, Tool[]>;
  ui: StoreApi<{ v: number }>;
  closed?: boolean;
}

declare module "@hortus/core" {
  interface Events {
    "subagent:async-started": { run: RunRecord };
    "subagent:async-complete": { run: RunRecord };
    "subagent:foreground-complete": { run: RunRecord };
    /** a run started, changed or ended (Pi's `subagent:jobs-changed`) */
    "subagent:jobs-changed": { version: 1 };
    /** Pi's in-process RPC: the handler sets `reply` before the emit resolves */
    "subagents:rpc:v1:request": RpcRequest;
    /** registers an agent; the handler sets `result` before the emit resolves */
    "pi-subagents:runtime-agent-register:v1": RegisterRequest;
  }
}

export interface RpcRequest {
  version: 1;
  requestId: string;
  method: string;
  params?: Record<string, unknown>;
  reply?: {
    version: 1;
    requestId: string;
    success: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  };
}

export interface RegisterRequest {
  version: 1;
  name: string;
  definition: { description: string; systemPrompt: string; tools?: readonly string[]; model?: string };
  result?: { ok: true; registration: { dispose(): void } } | { ok: false; error: Error };
}

/** The env var a background child's main plugin reads its agent limits (`maxDepth`, `allowedAgents`) from. */
const LIMITS_ENV = "HORTUS_PI_SUBAGENTS";
const DEFAULT_TIMEOUT = 30 * 60_000;
const ICON: Record<Status, string> = { running: "◆", completed: "✓", failed: "✗", paused: "‖", stopped: "■" };

const stateOf = (ctx: Ctx): State => {
  ctx.state.s ??= {
    runs: new Map(),
    live: new Map(),
    sessions: new Map(),
    limits: new Map(),
    pending: new Map(),
    runtime: new Map(),
    systems: new Map(),
    stash: new Map(),
    ui: createStore(() => ({ v: 0 })),
  } satisfies State;
  return ctx.state.s as State;
};

async function loadConfig(ctx: Ctx): Promise<Config> {
  const text = await readFile(join(hortusDir(), `${ctx.plugin}.json`), "utf8").catch(() => "{}");
  try {
    return JSON.parse(text) as Config;
  } catch (e) {
    throw new Error(`${ctx.plugin}.json: ${e instanceof Error ? e.message : e}`);
  }
}

const agentsFor = async (ctx: Ctx, cfg: Config) =>
  discoverAgents(ctx.cwd, stateOf(ctx).runtime.values(), cfg.agentOverrides);

const newId = () => randomBytes(4).toString("hex");
const oneLine = (s: string, n = 72) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Redraws the fleet and tells the bus. */
function changed(ctx: Ctx) {
  const s = stateOf(ctx);
  s.ui.setState({ v: s.ui.getState().v + 1 });
  if (!s.closed) void ctx.emit("subagent:jobs-changed", { version: 1 }).catch(() => {});
}

/** Saves `run` on the session that started it. */
const save = (ctx: Ctx, run: RunRecord) =>
  void ctx.session?.appendEntry(`${ctx.plugin}:run`, { ...run }).catch(() => {});

function limitsOf(ctx: Ctx, cfg: Config): Limits {
  const own = ctx.session && stateOf(ctx).limits.get(ctx.session.id);
  if (own) return own;
  const env: Partial<Limits> = JSON.parse(process.env[LIMITS_ENV] ?? "{}");
  return {
    // ponytail: a background child of a session with no file (a memory subrun's) counts from 1, not its true depth
    depth: ctx.run?.depth ?? 0,
    maxDepth: env.maxDepth ?? cfg.maxSubagentDepth ?? 2,
    allowedAgents: env.allowedAgents,
  };
}

/** `provider/model[:thinking]` or a bare model (the caller's provider); the agent's thinking unless the suffix sets one. */
async function modelOf(ctx: Ctx, raw: string | undefined, agent: AgentDef) {
  let effort: Effort | undefined = agent.thinking;
  if (!raw) return { effort };
  const colon = raw.lastIndexOf(":");
  const level = colon > 0 ? effortOf(raw.slice(colon + 1)) : undefined;
  const id = level ? raw.slice(0, colon) : raw;
  if (level) effort = level;
  const slash = id.indexOf("/");
  if (slash > 0) return { provider: id.slice(0, slash), model: id.slice(slash + 1), effort };
  return { provider: ctx.run?.provider ?? (await ctx.resolve()).provider, model: id, effort };
}

/** What a launch needs: agent, task, cwd, model and context, after defaults. */
interface Spec {
  agent: AgentDef;
  task: string;
  cwd: string;
  model?: string;
  context: "fresh" | "fork";
  timeoutMs?: number;
}

interface Item {
  agent: string;
  task?: string;
  cwd?: string;
  model?: string;
  context?: "fresh" | "fork";
}

function specOf(ctx: Ctx, cfg: Config, agents: Map<string, AgentDef>, item: Item, base: Partial<Item> = {}): Spec {
  const agent = findAgent(agents, item.agent);
  return {
    agent,
    task: item.task ?? base.task ?? "",
    cwd: resolve(ctx.cwd, item.cwd ?? base.cwd ?? "."),
    model: item.model ?? base.model ?? agent.model,
    context: item.context ?? base.context ?? agent.defaultContext ?? cfg.defaultSubagentContext ?? "fresh",
  };
}

/** The parent conversation for a forked child: subagent calls, their results and this plugin's notices left out. */
export function forkHistory(ctx: Ctx): Message[] {
  const dropped = new Set<string>();
  const out: Message[] = [];
  for (const { entryId: _, ...m } of ctx.session?.getState().messages ?? []) {
    if (m.role === "user") {
      if (m.meta?.plugin !== ctx.plugin) out.push(m);
    } else if (m.role === "assistant") {
      const calls = m.toolCalls.filter((c) => (c.name === "subagent" ? !dropped.add(c.id) : true));
      if (calls.length === m.toolCalls.length) out.push(m);
      else if (m.text || calls.length) {
        // a provider's raw content would replay the dropped calls
        const { raw: _raw, ...rest } = m;
        out.push({ ...rest, toolCalls: calls });
      }
    } else {
      const results = m.results.filter((r) => !dropped.has(r.id));
      if (results.length) out.push({ ...m, results });
    }
  }
  return out;
}

/** How a child is set up: its limits, plugin filter, tools and config, for both runners. */
function childSetup(ctx: Ctx, cfg: Config, spec: Spec, run: RunRecord, depth: number) {
  const lim = limitsOf(ctx, cfg);
  const a = spec.agent;
  if (lim.depth >= lim.maxDepth)
    throw new Error(
      `Subagent nesting limit reached (depth ${lim.depth} of ${lim.maxDepth}): complete the task directly.`,
    );
  if (lim.allowedAgents && !lim.allowedAgents.includes(a.name))
    throw new Error(`This agent may launch only: ${lim.allowedAgents.join(", ") || "none"}`);
  const childLimits: Limits = {
    depth: lim.depth + 1,
    maxDepth: Math.min(lim.maxDepth, a.maxSubagentDepth ?? Number.POSITIVE_INFINITY),
    allowedAgents: a.allowedAgents ?? lim.allowedAgents,
  };
  const nested = !!a.tools?.includes("subagent") && childLimits.depth < childLimits.maxDepth;
  const fork = spec.context === "fork";
  const disable = [
    ...(nested ? [] : [ctx.plugin]),
    ...(a.systemPromptMode === "replace" && !fork ? ["builtin:prompt"] : []),
  ];
  const only = a.extensions && ["builtin:*", ...a.extensions, ...(nested ? [ctx.plugin] : [])];
  const tools =
    a.tools &&
    [
      ...a.tools.filter((t) => t !== "subagent" || nested),
      "contact_supervisor",
      ...(nested ? ["subagent_supervisor"] : []),
    ].filter((t, i, all) => all.indexOf(t) === i);
  const system = fork && ctx.run ? stateOf(ctx).systems.get(ctx.run.id) : undefined;
  const child: ChildConfig = {
    plugin: ctx.plugin,
    agent: a.name,
    runId: run.id,
    prompt: a.prompt,
    mode: a.systemPromptMode,
    inheritProjectContext: a.inheritProjectContext,
    inheritSkills: a.inheritSkills,
    excludeTools: a.excludeTools,
    depth,
    ...(system && { system }),
  };
  const input = fork
    ? `<subagent_instructions>\n${a.prompt}\n\n${boundary(a.name)}\n</subagent_instructions>\n\n${spec.task}`
    : spec.task;
  return { childLimits, disable, only, tools, child, input, seed: fork ? forkHistory(ctx) : undefined };
}

function newRun(ctx: Ctx, spec: Spec, mode: RunRecord["mode"], resumedFrom?: string): RunRecord {
  return {
    id: newId(),
    agent: spec.agent.name,
    task: spec.task,
    mode,
    status: "running",
    cwd: spec.cwd,
    model: spec.model,
    context: spec.context,
    startedAt: Date.now(),
    turns: 0,
    toolCalls: 0,
    parentSession: ctx.session?.id,
    ...(resumedFrom && { resumedFrom }),
  };
}

/** Notes a child's tool call or reply on its record. */
function note(run: RunRecord, event: string, p: unknown) {
  if (event === "tool_call") {
    const { name, input } = (p as { call: { name: string; input: { reason?: string; message?: string } } }).call;
    run.toolCalls++;
    run.activity = `→ ${name}`;
    if (name === "contact_supervisor" && input.reason === "progress_update") run.progress = input.message;
  } else if (event === "message" && (p as Message).role === "assistant") {
    run.turns++;
    const text = (p as { text?: string }).text?.trim();
    if (text) run.activity = oneLine(text);
  }
}

interface Hooks {
  /** the call's progress: every record it started */
  details: { results: RunRecord[] };
  changed: () => void;
}

/** Runs a child in this process (`ctx.subrun`), its session a file child of the caller's; resolves once it ended. */
async function runForeground(
  ctx: Ctx,
  cfg: Config,
  spec: Spec,
  hooks: Hooks,
  opts: { detached?: boolean; session?: Session; resumedFrom?: string } = {},
): Promise<RunRecord> {
  const s = stateOf(ctx);
  const run = newRun(ctx, spec, "foreground", opts.resumedFrom);
  const setup = childSetup(ctx, cfg, spec, run, (ctx.run?.depth ?? 0) + 1);
  const m = await modelOf(ctx, spec.model, spec.agent);
  const timeout = AbortSignal.timeout(spec.timeoutMs ?? spec.agent.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT);
  const observe = (event: string, p: unknown) => {
    note(run, event, p);
    hooks.changed();
  };
  const handle = ctx.subrun(setup.input, {
    session: opts.session ?? "file",
    cwd: spec.cwd,
    ...(setup.tools && { tools: setup.tools }),
    plugins: {
      disable: setup.disable,
      ...(setup.only && { only: setup.only }),
      extra: [{ name: `${ctx.plugin}:child`, plugin: childPlugin(setup.child, observe) }],
    },
    ...(m.provider && { provider: m.provider }),
    ...(m.model && { model: m.model }),
    ...(m.effort && { effort: m.effort }),
    ...(setup.seed && { seed: setup.seed }),
    signal: timeout,
    ...(opts.detached && { detached: true }),
  });
  run.session = { id: handle.session.id, ...(handle.session.path && { path: handle.session.path }) };
  s.limits.set(handle.session.id, setup.childLimits);
  s.sessions.set(run.id, handle.session);
  s.runs.set(run.id, run);
  s.live.set(run.id, { ctx, handle });
  hooks.details.results.push(run);
  save(ctx, run);
  hooks.changed();
  try {
    const end = await handle.done;
    run.output = lastText(end?.messages ?? []);
    if (run.status === "stopped") {
    } else if (timeout.aborted) Object.assign(run, { status: "failed", error: "Timed out" });
    else if (end?.aborted) Object.assign(run, { status: "paused", error: `Interrupted by ${end.aborted.by}` });
    else if (end?.error !== undefined) Object.assign(run, { status: "failed", error: errText(end.error) });
    else run.status = "completed";
  } catch (e) {
    Object.assign(run, { status: "failed", error: errText(e) });
  } finally {
    s.live.delete(run.id);
  }
  run.endedAt = Date.now();
  save(ctx, run);
  hooks.changed();
  if (!s.closed) void ctx.emit("subagent:foreground-complete", { run }).catch(() => {});
  return run;
}

/**
 * Reads lines appended to `file` (a background child's stdout), every 100 ms; `stop` reads what is left. A file, not a
 * pipe: the child outlives this process if it must.
 */
function tail(file: string, onLine: (line: string) => void) {
  let pos = 0;
  let rest = Buffer.alloc(0);
  const read = () => {
    let fd: number;
    try {
      fd = openSync(file, "r");
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= pos) return;
      const buf = Buffer.alloc(size - pos);
      readSync(fd, buf, 0, buf.length, pos);
      pos = size;
      const all = Buffer.concat([rest, buf]);
      const end = all.lastIndexOf(10);
      rest = all.subarray(end + 1);
      if (end >= 0) for (const l of all.subarray(0, end).toString("utf8").split("\n")) onLine(l);
    } finally {
      closeSync(fd);
    }
  };
  const timer = setInterval(read, 100);
  timer.unref();
  return () => {
    clearInterval(timer);
    read();
  };
}

/** Pi's completion notice: the text the parent model reads, ending with what to do. */
function notice(runs: RunRecord[]): string {
  return runs
    .map((r) => {
      const head = `Background subagent ${r.agent} (${r.id}) ${r.status}${r.error ? `: ${r.error}` : ""}.`;
      const body = r.output ? `\n\n${r.output}` : "";
      const action =
        r.status === "completed"
          ? `Parent action: use this result; follow up with subagent({ action: "resume", id: "${r.id}", message }).`
          : `Parent action: check subagent({ action: "status", id: "${r.id}" }) and decide whether to resume or relaunch.`;
      return `${head}${body}\n\n${action}`;
    })
    .join("\n\n---\n\n");
}

/** Wakes the parent with a finished background run (a turn of its own when idle, else joining the running one). */
function deliver(ctx: Ctx, runs: RunRecord[]) {
  const s = stateOf(ctx);
  if (s.closed) return;
  for (const r of runs) r.delivered = true;
  ctx
    .send(
      {
        content: notice(runs),
        meta: {
          plugin: ctx.plugin,
          type: "notify",
          details: { runs: runs.map(({ id, agent, status }) => ({ runId: id, agent, status })) },
          display: true,
        },
      },
      { deliver: "steer" },
    )
    .catch((e) => {
      for (const r of runs) {
        r.delivered = false;
        save(ctx, r);
      }
      void ctx.notify(`Delivering subagent results failed: ${errText(e)}`, "error").catch(() => {});
    });
  for (const r of runs) save(ctx, r);
}

/** Settles a background run from its result file (or the exit), then delivers it. */
function settle(ctx: Ctx, run: RunRecord, code?: number | null) {
  const s = stateOf(ctx);
  let r: ResultFile | undefined;
  try {
    r = JSON.parse(readFileSync(run.resultFile ?? "", "utf8"));
  } catch {}
  if (run.status === "stopped") {
  } else if (r) Object.assign(run, { status: r.status, output: r.output, ...(r.error && { error: r.error }) });
  else Object.assign(run, { status: "failed", error: `Its hortus process exited (${code ?? "unknown"})` });
  run.endedAt = Date.now();
  // a background child's tokens count toward the session that started it, as a foreground child's do
  if (r?.usage && !s.closed) void ctx.session?.addUsage(r.usage).catch(() => {});
  s.live.delete(run.id);
  for (const [id, p] of s.pending) if (p.runId === run.id) s.pending.delete(id);
  // after exit, the session's next opening (maybe another process's) settles it from the result file
  if (s.closed) return;
  save(ctx, run);
  changed(ctx);
  void ctx.emit("subagent:async-complete", { run }).catch(() => {});
  deliver(ctx, [run]);
}

/**
 * Starts a child in its own `hortus --rpc` process (Pi's detached runner): the task as an RPC prompt, its events read
 * from a log file, its answer from the result file its child plugin writes. Steering, interrupts and supervisor
 * replies go to its stdin; once its task's run ended, stdin closes and it exits.
 */
async function startBackground(ctx: Ctx, cfg: Config, spec: Spec, resume?: RunRecord): Promise<RunRecord> {
  const s = stateOf(ctx);
  const run = newRun(ctx, spec, "background", resume?.id);
  const setup = childSetup(ctx, cfg, spec, run, 0);
  // its process's sessions are children of the one that started it (a resumed run's: the original's)
  const parent = resume?.parentSession ?? ctx.session?.id;
  if (parent) setup.child.parent = parent;
  run.parentSession = parent;
  const m = await modelOf(ctx, spec.model, spec.agent);
  const settings = m.model ? { provider: m.provider, model: m.model } : await ctx.resolve();
  const dir = join(hortusDir(), ctx.plugin, "runs", run.id);
  mkdirSync(dir, { recursive: true });
  run.resultFile = join(dir, "result.json");
  run.logFile = join(dir, "events.jsonl");
  const mod = join(dir, "child.mjs");
  const childUrl = new URL("./child.js", import.meta.url).href;
  writeFileSync(
    mod,
    `import { childPlugin } from ${JSON.stringify(childUrl)};\nexport default childPlugin(${JSON.stringify({ ...setup.child, resultFile: run.resultFile })});\n`,
  );
  const seed = setup.seed && !resume ? join(dir, "seed.json") : undefined;
  if (seed) writeFileSync(seed, JSON.stringify(setup.seed));
  const args = [
    hortusBin,
    "--rpc",
    ...(parent ? ["--parent", parent] : []),
    "--session",
    resume?.session?.id ?? "new",
    ...(resume ? [] : ["--name", `${spec.agent.name}: ${oneLine(spec.task, 40)}`]),
    "--cwd",
    spec.cwd,
    "--model",
    `${settings.provider}/${settings.model}`,
    ...(m.effort ? ["--effort", m.effort] : []),
    "--plugin",
    mod,
    ...(setup.disable.length ? ["--disable", setup.disable.join(",")] : []),
    ...(setup.only ? ["--only", setup.only.join(",")] : []),
    ...(setup.tools ? ["--tools", setup.tools.join(",")] : []),
    ...(seed ? ["--seed", seed] : []),
  ];
  const log = openSync(run.logFile, "a");
  const proc = spawn(process.execPath, args, {
    cwd: spec.cwd,
    env: {
      ...process.env,
      ...(ctx as Partial<ToolCtx>).env,
      [LIMITS_ENV]: JSON.stringify({
        maxDepth: setup.childLimits.maxDepth,
        allowedAgents: setup.childLimits.allowedAgents,
      }),
    },
    detached: true,
    stdio: ["pipe", log, log],
  });
  closeSync(log);
  run.pid = proc.pid;
  run.session = resume?.session;
  const write = (cmd: object) => {
    if (proc.stdin?.writable) proc.stdin.write(`${JSON.stringify(cmd)}\n`);
  };
  proc.stdin?.on("error", () => {});
  const stop = tail(run.logFile, (line) => {
    let o: {
      event?: string;
      payload?: { session?: RunRecord["session"]; askId?: string; question?: string; data?: { reason?: string } };
      run?: { depth?: number; parent?: { session?: string } };
      response?: string;
      id?: string;
    };
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o.response === "prompt" && o.id === "task") proc.stdin?.end();
    const p = o.payload ?? {};
    if (o.event === "session_open") run.session = p.session;
    // its top-level runs' (their parent is the session it runs under), not its own subruns'
    else if (
      (o.event === "tool_call" || o.event === "message") &&
      (parent ? o.run?.parent?.session === parent : !o.run?.depth)
    )
      note(run, o.event, p);
    else if (o.event === "ask" && p.askId)
      relayAsk(ctx, run, { askId: p.askId, question: p.question ?? "", data: p.data }, write);
    else if (o.event === "answered" && p.askId) s.pending.delete(p.askId);
    else return;
    changed(ctx);
  });
  s.runs.set(run.id, run);
  s.live.set(run.id, { ctx, proc, write, stop });
  proc.on("error", (e) => {
    run.error = e.message;
  });
  proc.on("close", (code) => {
    stop();
    settle(ctx, run, code);
  });
  write({ type: "prompt", text: setup.input, id: "task" });
  save(ctx, run);
  changed(ctx);
  void ctx.emit("subagent:async-started", { run }).catch(() => {});
  return run;
}

/** A background child's `contact_supervisor` question: to the parent model, answered with `subagent_supervisor`. */
function relayAsk(
  ctx: Ctx,
  run: RunRecord,
  p: { askId: string; question: string; data?: { reason?: string } },
  write: (cmd: object) => void,
) {
  const s = stateOf(ctx);
  s.pending.set(p.askId, {
    replyTo: p.askId,
    runId: run.id,
    agent: run.agent,
    question: p.question,
    reason: p.data?.reason,
    answer: (text) => write({ type: "answer", askId: p.askId, answer: text }),
  });
  if (s.closed) return;
  ctx
    .send(
      {
        content: `Subagent ${run.agent} (${run.id}) asks its supervisor${p.data?.reason ? ` (${p.data.reason})` : ""}:\n\n${p.question}\n\nReply with subagent_supervisor({ action: "reply", replyTo: "${p.askId}", message }).`,
        meta: { plugin: ctx.plugin, type: "supervisor", details: { runId: run.id, replyTo: p.askId }, display: true },
      },
      { deliver: "steer" },
    )
    .catch((e) => void ctx.notify(`Relaying ${run.agent}'s question failed: ${errText(e)}`, "error").catch(() => {}));
}

/**
 * Picks up this session's background runs from an earlier process: delivers a finished one, watches one still running
 * (until its result file or its process is gone), marks the rest ended.
 */
function recover(ctx: Ctx, run: RunRecord) {
  const s = stateOf(ctx);
  s.runs.set(run.id, run);
  if (run.mode === "foreground" || run.delivered) {
    if (run.status === "running") Object.assign(run, { status: "stopped", error: "Its hortus process exited" });
    return;
  }
  const alive = () => {
    try {
      return !!run.pid && process.kill(run.pid, 0);
    } catch {
      return false;
    }
  };
  if (run.status !== "running" || (run.resultFile && existsSync(run.resultFile)) || !alive()) {
    if (run.status === "running") settle(ctx, run);
    else deliver(ctx, [run]);
    return;
  }
  const timer = setInterval(() => {
    if ((run.resultFile && existsSync(run.resultFile)) || !alive()) {
      clearInterval(timer);
      settle(ctx, run);
    }
  }, 500);
  timer.unref();
  s.live.set(run.id, { ctx, stop: () => clearInterval(timer) });
}

/** An exact run id or an unambiguous prefix. */
function findRun(s: State, id: string | undefined): RunRecord {
  if (!id) throw new Error("This action needs an id");
  const exact = s.runs.get(id);
  if (exact) return exact;
  const m = [...s.runs.values()].filter((r) => r.id.startsWith(id));
  if (m.length === 1 && m[0]) return m[0];
  throw new Error(m.length ? `Ambiguous run id ${id}` : `Unknown subagent run: ${id}`);
}

const age = (r: RunRecord) => `${Math.round(((r.endedAt ?? Date.now()) - r.startedAt) / 1000)}s`;
const runLine = (r: RunRecord) =>
  `${ICON[r.status]} ${r.id} ${r.agent} (${r.mode}) ${r.status} ${age(r)} — ${oneLine(r.task, 60)}`;

/** A run's status, with the tail of its transcript (`lines`). */
async function statusText(s: State, r: RunRecord, lines = 20): Promise<string> {
  const out = [runLine(r)];
  if (r.progress) out.push(`progress: ${r.progress}`);
  if (r.activity && r.status === "running") out.push(`activity: ${r.activity}`);
  if (r.error) out.push(`error: ${r.error}`);
  out.push(`turns: ${r.turns}, tool calls: ${r.toolCalls}, cwd: ${r.cwd}`);
  if (r.session) out.push(`session: ${r.session.path ?? r.session.id}`);
  const session = s.sessions.get(r.id);
  const messages = session
    ? session.getState().messages
    : r.session?.path
      ? (await readSession(r.session.path).catch(() => undefined))?.messages
      : undefined;
  const transcript = (messages ?? []).flatMap((m) =>
    m.role === "user"
      ? [`user: ${m.content}`]
      : m.role === "assistant"
        ? [...(m.text ? [`assistant: ${m.text}`] : []), ...m.toolCalls.map((c) => `tool: ${c.name}`)]
        : m.results.map((x) => `result: ${oneLine(x.output, 100)}`),
  );
  const tailLines = transcript.join("\n").split("\n").slice(-Math.min(lines, 500));
  if (tailLines.length && tailLines[0]) out.push("", "transcript:", ...tailLines);
  return out.join("\n");
}

/** The session of a finished foreground child, to resume: in memory, else its file under the parent's children. */
async function childSession(ctx: Ctx, r: RunRecord): Promise<Session> {
  const s = stateOf(ctx);
  const known = s.sessions.get(r.id);
  if (known) return known;
  if (!r.parentSession || !r.session) throw new Error(`Run ${r.id} has no saved session to resume`);
  const info = (await listSessions({ parent: r.parentSession })).find((x) => x.id === r.session?.id);
  if (!info) throw new Error(`Run ${r.id}'s session file is gone`);
  return openSession(info.leafId, childDir(r.parentSession));
}

/** steer / interrupt / stop / resume, as the tool, commands and the bus run them. */
async function control(
  ctx: Ctx,
  action: "steer" | "interrupt" | "stop" | "resume",
  id: string | undefined,
  message?: string,
  mode: "steer" | "follow_up" = "steer",
  hooks: Hooks = { details: { results: [] }, changed: () => changed(ctx) },
): Promise<string> {
  const s = stateOf(ctx);
  const run = findRun(s, id);
  const live = s.live.get(run.id);
  if (action === "resume") {
    if (!message) throw new Error("resume needs a message");
    if (live) throw new Error(`Run ${run.id} is still running: use steer`);
    if (run.status === "stopped") throw new Error(`Run ${run.id} was stopped; start a new run instead`);
    const cfg = await loadConfig(ctx);
    const agents = await agentsFor(ctx, cfg);
    const spec = specOf(ctx, cfg, agents, { agent: run.agent, task: message, cwd: run.cwd, model: run.model });
    if (run.mode === "background") {
      const next = await startBackground(ctx, cfg, spec, run);
      return `Resumed ${run.id} in the background as ${next.id}; its result arrives as a message.`;
    }
    const next = await runForeground(ctx, cfg, spec, hooks, {
      session: await childSession(ctx, run),
      resumedFrom: run.id,
    });
    return result(next);
  }
  if (!live || run.status !== "running") throw new Error(`Run ${run.id} is ${run.status}, not running`);
  if (action === "steer") {
    if (!message) throw new Error("steer needs a message");
    const deliverMode = mode === "follow_up" ? "after" : "steer";
    if (live.handle) void live.handle.send(message, { deliver: deliverMode }).catch(() => {});
    else live.write?.({ type: "prompt", text: message, deliver: deliverMode });
    return `Steering message ${mode === "follow_up" ? "queued for after the current turn of" : "delivered to"} ${run.agent} (${run.id}).`;
  }
  if (action === "interrupt") {
    if (live.handle) live.handle.abort("interrupt");
    else live.write?.({ type: "abort" });
    return `Interrupted ${run.agent} (${run.id}); resume it with a message to continue.`;
  }
  run.status = "stopped";
  run.error = "Stopped";
  if (live.handle) live.handle.abort("stop");
  else if (live.proc?.pid)
    try {
      process.kill(-live.proc.pid, "SIGTERM");
    } catch {
      live.proc.kill("SIGTERM");
    }
  changed(ctx);
  return `Stopped ${run.agent} (${run.id}).`;
}

/** A foreground run as the tool returns it: its answer, then a footer naming it. */
function result(r: RunRecord): string {
  const footer = `[subagent ${r.agent} · run ${r.id} · ${r.status}${r.error ? `: ${r.error}` : ""}]`;
  if (r.status !== "completed") throw new Error(`${footer}${r.output ? `\n\n${r.output}` : ""}`);
  return `${r.output || "(no text)"}\n\n${footer}`;
}

/** The script of `workflow`: true → the last ```js workflow block of the reply making this call; a path → that file. */
async function workflowSource(ctx: Ctx, w: true | string): Promise<string> {
  if (typeof w === "string") {
    if (!w.includes("/"))
      throw new Error(`Unknown workflow resource "${w}": pass true (a \`\`\`js workflow block) or a script path`);
    return readFile(resolve(ctx.cwd, w), "utf8");
  }
  const reply = [...(ctx.session?.getState().messages ?? [])]
    .reverse()
    .find((m) => m.role === "assistant" && m.toolCalls.some((c) => c.id === ctx.callId));
  const text = reply?.role === "assistant" ? reply.text : "";
  const src = [...text.matchAll(/```js workflow\r?\n([\s\S]*?)```/g)].at(-1)?.[1];
  if (!src?.trim()) throw new Error("workflow: true needs one ```js workflow block in the same reply");
  return src;
}

const deepFreeze = <T,>(v: T): T => {
  if (v && typeof v === "object") for (const x of Object.values(v)) deepFreeze(x);
  return Object.freeze(v);
};

/**
 * Runs a workflow script: an async function body with `runs.run(key, { agent, task, ... })`, `runs.all([...])`,
 * frozen `args` and `console.log`. Children run in the foreground of the script.
 * ponytail: `node:vm`, not a sandbox (Pi runs scripts in an isolated worker); the script is the model's own
 */
async function runWorkflow(
  ctx: Ctx,
  cfg: Config,
  src: string,
  args: unknown,
  base: Partial<Item>,
  hooks: Hooks,
  detached: boolean,
): Promise<string> {
  const agents = await agentsFor(ctx, cfg);
  const logs: string[] = [];
  const one = async (key: string, item: Item) => {
    const r = await runForeground(ctx, cfg, specOf(ctx, cfg, agents, item, base), hooks, { detached });
    return {
      key,
      agent: r.agent,
      runId: r.id,
      status: r.status,
      ok: r.status === "completed",
      output: r.output ?? "",
      ...(r.error && { error: r.error }),
    };
  };
  const runs = {
    run: (key: string, item: Item) => one(key, item),
    all: (items: (Item & { key?: string })[]) => Promise.all(items.map((i, n) => one(i.key ?? String(n), i))),
  };
  const value = await vm.runInNewContext(
    `(async () => {\n${src}\n})()`,
    {
      runs,
      args: deepFreeze(structuredClone(args ?? {})),
      console: { log: (...a: unknown[]) => logs.push(a.join(" ")) },
    },
    { filename: "workflow.js" },
  );
  const ret = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    [ret && `Return:\n${ret}`, logs.length ? `Console:\n${logs.join("\n")}` : ""].filter(Boolean).join("\n\n") ||
    "Workflow finished."
  );
}

/** A multi-child job (parallel, chain, workflow) in the background: its children detached, its result a notice. */
function backgroundJob(ctx: Ctx, label: string, work: (hooks: Hooks) => Promise<string>): string {
  const id = newId();
  const hooks: Hooks = { details: { results: [] }, changed: () => changed(ctx) };
  void work(hooks)
    .catch((e) => `Failed: ${errText(e)}`)
    .then((text) => {
      if (stateOf(ctx).closed) return;
      return ctx.send(
        {
          content: `Background ${label} ${id} finished.\n\n${text}`,
          meta: {
            plugin: ctx.plugin,
            type: "notify",
            details: { runs: hooks.details.results.map(({ id, agent, status }) => ({ runId: id, agent, status })) },
            display: true,
          },
        },
        { deliver: "steer" },
      );
    })
    .catch((e) => void ctx.notify(`Delivering ${label} ${id} failed: ${errText(e)}`, "error").catch(() => {}));
  return `Started background ${label} ${id}; its result arrives as a message when it finishes. Do not poll.`;
}

function agentList(agents: Map<string, AgentDef>): string {
  if (!agents.size) return "No agents.";
  return [...agents.values()]
    .map(
      (a) =>
        `- ${a.name}${a.aliases.length ? ` (${a.aliases.join(", ")})` : ""} [${a.source}]: ${a.description}${a.tools ? ` — tools: ${a.tools.join(", ")}` : ""}`,
    )
    .join("\n");
}

const Input = z.object({
  action: z
    .enum(["list", "status", "steer", "interrupt", "stop", "resume"])
    .optional()
    .describe("Manage agents and runs instead of launching"),
  agent: z.string().optional().describe("The agent for a single run (see action: list)"),
  task: z.string().optional().describe("The single run's task; a chain's original task ({task})"),
  tasks: z
    .array(z.object({ agent: z.string(), task: z.string(), cwd: z.string().optional(), model: z.string().optional() }))
    .optional()
    .describe("Run these in parallel"),
  chain: z
    .array(
      z.object({
        agent: z.string(),
        task: z.string().optional(),
        cwd: z.string().optional(),
        model: z.string().optional(),
      }),
    )
    .optional()
    .describe("Run these in order; a step's task may use {previous} (the last output) and {task}"),
  workflow: z
    .union([z.literal(true), z.string()])
    .optional()
    .describe("true: run the ```js workflow block of this reply; or a script path (contains /)"),
  args: z.record(z.string(), z.unknown()).optional().describe("Plain JSON args for a workflow script"),
  async: z.boolean().optional().describe("Run in the background (default: on); the result arrives as a message"),
  model: z.string().optional().describe("provider/model[:thinking], overriding the agent's"),
  cwd: z.string().optional(),
  context: z.enum(["fresh", "fork"]).optional().describe("fork: the child starts from this conversation"),
  timeoutMs: z.number().int().positive().optional(),
  id: z.string().optional().describe("Run id for status/steer/interrupt/stop/resume"),
  message: z.string().optional().describe("For steer and resume"),
  mode: z.enum(["steer", "follow_up"]).optional().describe("steer: now; follow_up: after the current turn"),
  lines: z.number().int().positive().optional().describe("Transcript lines for status with an id"),
});

const DESCRIPTION = `Delegate work to focused child agents (see action: "list"). One agent: { agent, task }. Parallel: { tasks: [{ agent, task }] }. Sequential: { chain: [{ agent, task }] } ({previous} is the last output). Scripted: write one \`\`\`js workflow block in your reply (\`await runs.run(key, { agent, task })\`, \`await runs.all([{ key, agent, task }])\`, \`args\`; return a value), then call { workflow: true }. Runs go to the background by default (async); their result arrives as a message: don't poll. Manage runs with action status / steer / interrupt / stop / resume (id, message).`;

async function execute(input: z.infer<typeof Input>, ctx: ToolCtx): Promise<string> {
  const s = stateOf(ctx);
  const cfg = await loadConfig(ctx);
  const details = { results: [] as RunRecord[] };
  const hooks: Hooks = {
    details,
    changed: () => {
      ctx.update({ results: details.results.map((r) => ({ ...r })) });
      changed(ctx);
    },
  };
  if (input.action === "list") return agentList(await agentsFor(ctx, cfg));
  if (input.action === "status") {
    if (input.id) return statusText(s, findRun(s, input.id), input.lines);
    const runs = [...s.runs.values()];
    const pending = [...s.pending.values()].map((p) => `? ${p.agent} (${p.runId}) asks [${p.replyTo}]: ${p.question}`);
    return [...runs.map(runLine), ...pending].join("\n") || "No subagent runs.";
  }
  if (input.action) return control(ctx, input.action, input.id, input.message, input.mode, hooks);

  const background = (a?: AgentDef) => ctx.host.interactive && (input.async ?? a?.async ?? cfg.asyncByDefault ?? true);
  const base: Partial<Item> = {
    ...(input.cwd && { cwd: input.cwd }),
    ...(input.model && { model: input.model }),
    ...(input.context && { context: input.context }),
  };
  if (input.workflow !== undefined) {
    const src = await workflowSource(ctx, input.workflow);
    if (background())
      return backgroundJob(ctx, "workflow", (h) => runWorkflow(ctx, cfg, src, input.args, base, h, true));
    return runWorkflow(ctx, cfg, src, input.args, base, hooks, false);
  }
  const agents = await agentsFor(ctx, cfg);
  if (input.tasks?.length) {
    const tasks = input.tasks;
    for (const t of tasks) findAgent(agents, t.agent);
    const work = async (h: Hooks, detached: boolean) => {
      const runs = await Promise.all(
        tasks.map((t) => runForeground(ctx, cfg, specOf(ctx, cfg, agents, t, base), h, { detached })),
      );
      return runs
        .map(
          (r, i) =>
            `## ${i + 1}. ${r.agent} (${r.id}) ${r.status}${r.error ? `: ${r.error}` : ""}\n\n${r.output ?? ""}`,
        )
        .join("\n\n");
    };
    if (background()) return backgroundJob(ctx, "parallel run", (h) => work(h, true));
    return work(hooks, false);
  }
  if (input.chain?.length) {
    const chain = input.chain;
    for (const t of chain) findAgent(agents, t.agent);
    const work = async (h: Hooks, detached: boolean) => {
      let previous = "";
      const steps: string[] = [];
      for (const step of chain) {
        const task = (step.task ?? "{previous}")
          .replaceAll("{previous}", previous)
          .replaceAll("{task}", input.task ?? "");
        const r = await runForeground(ctx, cfg, specOf(ctx, cfg, agents, { ...step, task }, base), h, { detached });
        steps.push(`${r.agent} (${r.id}) ${r.status}`);
        if (r.status !== "completed") throw new Error(`Chain stopped at ${steps.join(" → ")}: ${r.error ?? ""}`);
        previous = r.output ?? "";
      }
      return `${previous}\n\n[chain: ${steps.join(" → ")}]`;
    };
    if (background()) return backgroundJob(ctx, "chain", (h) => work(h, true));
    return work(hooks, false);
  }
  if (!input.agent) throw new Error("Pass { agent, task }, tasks, chain, workflow, or an action");
  if (!input.task) throw new Error("A single run needs a task");
  const spec = {
    ...specOf(ctx, cfg, agents, { agent: input.agent, task: input.task }, base),
    timeoutMs: input.timeoutMs,
  };
  if (background(spec.agent)) {
    const run = await startBackground(ctx, cfg, spec);
    return `Started ${run.agent} in the background as ${run.id}. Its result arrives as a message when it finishes: do not poll or sleep; continue with independent work or end your turn.`;
  }
  return result(await runForeground(ctx, cfg, spec, hooks));
}

const subagentTool = tool({ name: "subagent", description: DESCRIPTION, inputSchema: Input, execute });

const supervisorTool = tool({
  name: "subagent_supervisor",
  description:
    'Answer your background subagents\' questions: action "pending" lists them, "reply" answers one (replyTo, message).',
  inputSchema: z.object({
    action: z.enum(["pending", "reply"]),
    replyTo: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async ({ action, replyTo, message }, ctx) => {
    const s = stateOf(ctx);
    if (action === "pending")
      return (
        [...s.pending.values()].map((p) => `[${p.replyTo}] ${p.agent} (${p.runId}): ${p.question}`).join("\n") ||
        "No pending questions."
      );
    const p = replyTo ? s.pending.get(replyTo) : undefined;
    if (!p) throw new Error(`No pending question ${replyTo ?? ""}`);
    if (!message) throw new Error("reply needs a message");
    p.answer(message);
    s.pending.delete(p.replyTo);
    return `Replied to ${p.agent} (${p.runId}).`;
  },
});

const enableTool = tool({
  name: "subagents_enable",
  description:
    "Make the subagent tool available (from the next request), when the user's request or instructions authorize delegation. Launches nothing.",
  inputSchema: z.object({}),
  execute: async (_, ctx) => {
    const s = stateOf(ctx);
    await ctx.session?.appendEntry(`${ctx.plugin}:enabled`, true);
    const held = (ctx.run && s.stash.get(ctx.run.id)) ?? [];
    for (const t of held) if (!ctx.tools.some((x) => x.name === t.name)) ctx.tools.push(t);
    return "The subagent tool is available from the next request.";
  },
});

/** The plugin's prompt templates (`prompts/*.md`, Pi's): `/name [args]` sends the body, `$@`/`$ARGUMENTS` = args. */
const promptsDir = fileURLToPath(new URL("../prompts", import.meta.url));
const templates: Command[] = await Promise.all(
  (await readdir(promptsDir).catch(() => []))
    .filter((n) => n.endsWith(".md"))
    .map(async (n) => {
      const { meta, body } = splitFrontmatter(await readFile(join(promptsDir, n), "utf8"));
      return {
        name: n.slice(0, -3),
        description: typeof meta.description === "string" ? meta.description : n,
        args: typeof meta["argument-hint"] === "string" ? meta["argument-hint"] : "[request]",
        run: async (arg, ctx) => {
          await ctx.send(body.replace(/\$@|\$ARGUMENTS/g, arg.trim()), { deliver: "steer", source: "user" });
        },
      } satisfies Command;
    }),
);

const skillsDir = fileURLToPath(new URL("../skills", import.meta.url));

/** `/run <agent> [task] [--bg] [--fork]`: one child, its result added to the conversation. */
async function runCommand(arg: string, ctx: Ctx): Promise<string> {
  const bg = /(^|\s)--bg(\s|$)/.test(arg);
  const fork = /(^|\s)--fork(\s|$)/.test(arg);
  const [name, ...rest] = arg
    .replace(/(^|\s)--(bg|fork)(?=\s|$)/g, " ")
    .trim()
    .split(/\s+/);
  if (!name) throw new Error("Usage: /run <agent> [task] [--bg] [--fork]");
  const cfg = await loadConfig(ctx);
  const spec = specOf(ctx, cfg, await agentsFor(ctx, cfg), {
    agent: name,
    task: rest.join(" "),
    ...(fork && { context: "fork" }),
  });
  if (bg) return `Started ${(await startBackground(ctx, cfg, spec)).id} in the background.`;
  const run = await runForeground(ctx, cfg, spec, { details: { results: [] }, changed: () => changed(ctx) });
  await ctx.send(
    {
      content: `/run ${run.agent} (${run.id}) ${run.status}${run.error ? `: ${run.error}` : ""}\n\n${run.output ?? ""}`,
      meta: { plugin: ctx.plugin, type: "run", details: { runId: run.id }, display: true },
    },
    { deliver: "context" },
  );
  return `${run.agent} (${run.id}) ${run.status}.`;
}

async function doctor(ctx: Ctx): Promise<string> {
  const out: string[] = [];
  let cfg: Config = {};
  try {
    cfg = await loadConfig(ctx);
    out.push(`✓ config ${join(hortusDir(), `${ctx.plugin}.json`)}`);
  } catch (e) {
    out.push(`✗ ${errText(e)}`);
  }
  const agents = await agentsFor(ctx, cfg);
  out.push(`✓ ${agents.size} agents: ${[...agents.keys()].join(", ")}`);
  out.push(existsSync(hortusBin) ? `✓ background runner ${hortusBin}` : `✗ background runner missing: ${hortusBin}`);
  out.push(
    ctx.host.interactive
      ? "✓ interactive host: background runs and supervisor relays on"
      : "! host isn't interactive: runs stay in the foreground",
  );
  const lim = limitsOf(ctx, cfg);
  out.push(`✓ nesting depth ${lim.depth} of ${lim.maxDepth}`);
  try {
    const r = await ctx.resolve();
    out.push(`✓ model ${r.provider}/${r.model}`);
  } catch (e) {
    out.push(`✗ model: ${errText(e)}`);
  }
  return out.join("\n");
}

const commands: Command[] = [
  { name: "run", description: "Run one subagent", args: "<agent> [task] [--bg] [--fork]", run: runCommand },
  {
    name: "subagents",
    description: "List the available subagents",
    run: async (_, ctx) => agentList(await agentsFor(ctx, await loadConfig(ctx))),
  },
  {
    name: "subagents-status",
    description: "Show subagent runs, or one run with its transcript",
    args: "[run-id]",
    run: async (arg, ctx) => {
      const s = stateOf(ctx);
      if (arg.trim()) return statusText(s, findRun(s, arg.trim()));
      return [...s.runs.values()].map(runLine).join("\n") || "No subagent runs.";
    },
  },
  {
    name: "subagents-stop",
    description: "Stop a running subagent",
    args: "<run-id>",
    run: (arg, ctx) => control(ctx, "stop", arg.trim()),
  },
  {
    name: "subagents-steer",
    description: "Steer a running subagent",
    args: "<run-id> <message>",
    run: (arg, ctx) => {
      const [id, ...msg] = arg.trim().split(/\s+/);
      return control(ctx, "steer", id, msg.join(" "));
    },
  },
  { name: "subagents-doctor", description: "Check the subagent setup", run: (_, ctx) => doctor(ctx) },
  ...templates,
];

/** Pi's FleetView: running subagents, under the transcript. */
const Fleet: ComponentType<{ Default: ComponentType }> = ({ Default }) => {
  const s = stateOf(usePluginCtx());
  useStore(s.ui, (x) => x.v);
  const running = [...s.runs.values()].filter((r) => r.status === "running");
  return (
    <>
      <Default />
      {running.length > 0 && (
        <Box flexDirection="column">
          {running.map((r) => (
            <Text key={r.id} wrap="truncate">
              <Text color={theme.accent}>{ICON.running} </Text>
              <Text bold>{r.agent}</Text>
              <Text color={theme.muted}>
                {` ${r.id} ${r.mode === "background" ? "bg" : "fg"} ${age(r)} · ${r.progress ? `progress: ${r.progress}` : (r.activity ?? oneLine(r.task, 40))}`}
              </Text>
            </Text>
          ))}
        </Box>
      )}
    </>
  );
};

const colorOf = (st: Status) =>
  st === "completed" ? theme.green : st === "failed" ? theme.red : st === "running" ? theme.accent : theme.yellow;

/** The `subagent` block: a row per child (status, counts), then its activity, error or answer. */
const renderer = linesRenderer((view) => {
  const input = view.call.input as z.infer<typeof Input>;
  const what = input.action
    ? `${input.action}${input.id ? ` ${input.id}` : ""}`
    : input.workflow !== undefined
      ? "workflow"
      : input.tasks
        ? `${input.tasks.length} in parallel`
        : input.chain
          ? `chain of ${input.chain.length}`
          : `${input.agent ?? ""} ${oneLine(input.task ?? "", 50)}`;
  const rows: Span[][] = [
    [
      { text: "subagent ", bold: true, color: theme.toolTitle },
      { text: what, color: theme.muted },
    ],
  ];
  const results = (view.details as { results?: RunRecord[] } | undefined)?.results ?? [];
  const max = view.expanded ? 40 : 3;
  for (const r of results) {
    rows.push([
      { text: `${ICON[r.status]} `, color: colorOf(r.status) },
      { text: r.agent, bold: true },
      { text: ` ${r.id} ${r.status} · ${r.turns} turns · ${r.toolCalls} tools · ${age(r)}`, color: theme.muted },
    ]);
    const sub =
      r.status === "running" ? (r.progress ? `progress: ${r.progress}` : r.activity) : (r.error ?? r.output ?? "");
    for (const l of (sub ?? "").split("\n").filter(Boolean).slice(0, max))
      rows.push([{ text: `  ${l}`, color: theme.toolOutput }]);
  }
  if (!results.length && view.result)
    for (const l of view.result.output.split("\n").slice(0, max))
      rows.push([{ text: `  ${l}`, color: view.result.isError ? theme.red : theme.toolOutput }]);
  return rows;
});

/** The bus RPC methods (Pi's `subagents:rpc:v1`). */
async function rpc(ctx: Ctx, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const s = stateOf(ctx);
  const str = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : undefined);
  switch (method) {
    case "ping":
      return {
        version: 1,
        methods: ["ping", "status", "spawn", "steer", "interrupt", "stop", "resume"],
        events: {
          asyncStarted: "subagent:async-started",
          asyncComplete: "subagent:async-complete",
          jobsChanged: "subagent:jobs-changed",
        },
      };
    case "status": {
      const id = str("id");
      if (id) return { run: findRun(s, id), text: await statusText(s, findRun(s, id)) };
      return { runs: [...s.runs.values()] };
    }
    case "spawn": {
      const cfg = await loadConfig(ctx);
      const agent = str("agent");
      if (!agent || !str("task")) throw new Error("spawn needs agent and task");
      const spec = specOf(ctx, cfg, await agentsFor(ctx, cfg), {
        agent,
        task: str("task"),
        cwd: str("cwd"),
        model: str("model"),
        ...(str("context") === "fork" && { context: "fork" }),
      });
      const run = await startBackground(ctx, cfg, spec);
      return { runId: run.id };
    }
    case "steer":
    case "interrupt":
    case "stop":
    case "resume":
      return {
        text: await control(
          ctx,
          method,
          str("id"),
          str("message"),
          str("mode") === "follow_up" ? "follow_up" : "steer",
        ),
      };
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

export default {
  tools: [subagentTool, supervisorTool, enableTool],
  commands,
  entries: {
    run: (e: PluginEntry<RunRecord>, state, plugin) => {
      const d = (state.data[plugin] ?? {}) as { runs?: Record<string, RunRecord>; enabled?: boolean };
      state.data[plugin] = { ...d, runs: { ...d.runs, [e.data.id]: e.data } };
    },
    enabled: (_: PluginEntry<boolean>, state, plugin) => {
      state.data[plugin] = { ...(state.data[plugin] as object), enabled: true };
    },
  },
  on: {
    skills: async ({ skills }) => {
      skills.push(...(await findSkills(skillsDir)));
    },
    session_open: ({ session }, ctx) => {
      const s = stateOf(ctx);
      const runs = (session.getState().data[ctx.plugin] as { runs?: Record<string, RunRecord> } | undefined)?.runs;
      for (const r of Object.values(runs ?? {})) if (!s.runs.has(r.id)) recover(ctx, { ...r });
      changed(ctx);
    },
    run_start: async (p, ctx) => {
      const s = stateOf(ctx);
      const cfg = await loadConfig(ctx).catch(() => ({}) as Config);
      const enabled = (ctx.session?.getState().data[ctx.plugin] as { enabled?: boolean } | undefined)?.enabled;
      const lazy = cfg.toolActivation === "lazy" && !limitsOf(ctx, cfg).depth && !enabled;
      const held = lazy ? ["subagent", "subagent_supervisor"] : ["subagents_enable"];
      const stash: Tool[] = [];
      for (let i = p.tools.length - 1; i >= 0; i--) {
        const t = p.tools[i];
        if (t && held.includes(t.name)) stash.push(...p.tools.splice(i, 1));
      }
      if (lazy && ctx.run) s.stash.set(ctx.run.id, stash);
    },
    prompt: async ({ system, tools }, ctx) => {
      if (!tools.some((t) => t.name === "subagent")) return;
      const agents = [...(await agentsFor(ctx, await loadConfig(ctx).catch(() => ({})))).values()].filter(
        (a) => a.advertise,
      );
      if (!agents.length) return;
      system.push(
        `<advertised_subagents>\nAgents you can launch with the subagent tool (advertising is not a reason to delegate):\n${agents
          .slice(0, 16)
          .map((a) => `- ${a.name}: ${a.description.slice(0, 512)}`)
          .join("\n")}\n</advertised_subagents>`,
      );
    },
    request: (p, ctx) => {
      if (p.source === "run" && ctx.run) stateOf(ctx).systems.set(ctx.run.id, p.system);
    },
    run_end: (_, ctx) => {
      if (!ctx.run) return;
      stateOf(ctx).systems.delete(ctx.run.id);
      stateOf(ctx).stash.delete(ctx.run.id);
    },
    "subagents:rpc:v1:request": async (req, ctx) => {
      if (req.reply || req.version !== 1) return;
      try {
        req.reply = {
          version: 1,
          requestId: req.requestId,
          success: true,
          data: await rpc(ctx, req.method, req.params),
        };
      } catch (e) {
        req.reply = {
          version: 1,
          requestId: req.requestId,
          success: false,
          error: { code: "failed", message: errText(e) },
        };
      }
    },
    "pi-subagents:runtime-agent-register:v1": (req, ctx) => {
      if (req.result) return;
      const s = stateOf(ctx);
      const d = req.definition;
      if (req.version !== 1 || !req.name || !d?.description || typeof d.systemPrompt !== "string") {
        req.result = {
          ok: false,
          error: new Error("Malformed registration (version 1: name, description, systemPrompt)"),
        };
        return;
      }
      if (s.runtime.has(req.name)) {
        req.result = { ok: false, error: new Error(`Agent ${req.name} is already registered`) };
        return;
      }
      s.runtime.set(req.name, {
        name: req.name,
        description: d.description,
        prompt: d.systemPrompt,
        source: "runtime",
        aliases: [],
        ...(d.tools && { tools: [...d.tools] }),
        ...(d.model && { model: d.model }),
        excludeTools: [],
        systemPromptMode: "replace",
        inheritProjectContext: true,
        inheritSkills: false,
        advertise: false,
      });
      const name = req.name;
      req.result = { ok: true, registration: { dispose: () => void s.runtime.delete(name) } };
    },
    // background children keep going (Pi's detached runners): their stdin closes, so each ends after its run, and
    // its result waits in its result file for the session's next opening
    close: (_, ctx) => {
      const s = stateOf(ctx);
      s.closed = true;
      for (const l of s.live.values()) {
        l.stop?.();
        l.proc?.stdin?.end();
      }
    },
  },
  cli: {
    tools: { subagent: renderer },
    aboveInput: Fleet,
  },
} satisfies CliPlugin;
