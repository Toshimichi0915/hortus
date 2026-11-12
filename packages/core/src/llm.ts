import { z } from "zod";
import type { McpServer } from "./mcp.ts";
import type { Named } from "./plugins.ts";
import type { Secret, SecretStore } from "./secrets.ts";
import type { PluginEntry, Session, SessionState } from "./session.ts";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /**
   * set by the provider for a call it ran itself (server-side web search, an agent-backed model's own tool use): core
   * fires `tool_call`/`tool_result` for it but doesn't run it, and providers leave it out when rebuilding history
   */
  result?: ToolResult;
}
/** Base64 image; return one (or an array of them) from a tool's execute to send it to the model. */
export interface Image {
  type: "image";
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
  /** text sent along with the image, e.g. a codemode script's output */
  text?: string;
  /** where the image is on disk; a result's image without one is saved to a temp file */
  path?: string;
}
export interface ToolResult {
  id: string;
  output: string;
  /** sent to the model after `output`, every one */
  images?: Image[];
  isError?: boolean;
  /** for the host's renderer, never sent to the model: the last value the call passed to `ctx.update` */
  details?: unknown;
  /** tokens the call spent on its own model calls (a subagent's), added to the session's totals */
  usage?: Usage;
  /**
   * what `execute` returned when it was neither text nor images (e.g. an MCP tool's structured content; `output` is its
   * JSON): for `ctx.runTool` callers (codemode scripts get it as is), never sent to the model nor saved
   */
  value?: unknown;
  /** how long its tool's `execute` ran, stamped by core (none when a handler supplied the result) and saved */
  durationMs?: number;
}

/** Who a run is, as handlers, tools and providers see it in `ctx.run`. */
export interface RunInfo {
  id: string;
  /** 0 for a top-level run */
  depth: number;
  /**
   * a subrun's (depth > 0) starter: the session it was started from, its run (none from a command or other host ctx)
   * and tool call (only when a tool started it)
   */
  parent?: { session?: string; runId?: string; toolCallId?: string };
  /** the secrets.json entry's name */
  provider: string;
  /** that entry's `type` */
  type: string;
  endpoint?: string;
  model: string;
  effort?: Effort;
  /** what the provider reports about the model (`Provider.info`, cached per provider and model); `{}` if nothing */
  info: ModelInfo;
  /** who started it: `input.source` / `RunOptions.source` ("user" by default) */
  source: string;
  /** a subrun's agent name (`SubrunOptions.agent`), e.g. for per-agent policy; none for top-level runs */
  agent?: string;
  /**
   * the top-level session's id: a top-level run's own session's (in a `--parent` child process, the parent chain's
   * root), a subrun's caller's root; none for a preview without a session
   */
  root?: string;
  cwd: string;
}

/** What `ctx.complete` takes: a request to any configured provider (default: the run's, else config's). */
export interface CompleteRequest {
  /** each declared tool's `prompt` is appended unless already in it, so a sent request's or a preview's can be reused */
  system?: string;
  messages: Message[];
  tools?: Tool[];
  provider?: string;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  temperature?: number;
  headers?: Record<string, string>;
  /** aborts this call (e.g. `AbortSignal.timeout(ms)`), as the run's signal also does */
  signal?: AbortSignal;
}

/** How a run ended: `run_end`'s payload and what `run` resolves with. */
export interface RunEnd {
  /** "preview": a `ctx.preview`'s end, so per-run state set up in `run_start` is cleaned up for previews too */
  source: "run" | "preview";
  /**
   * the run's history: its session's messages as they are at `run_end` (a run's requests are built from them as they
   * are then, so what was persisted mid-run, such as a compaction, shows); a preview's own
   */
  messages: Message[];
  error?: unknown;
  /** `by` is "user" (the run's `signal`) or the plugin that called `ctx.abort` */
  aborted?: { by: string; reason?: string };
}

/**
 * What every handler, tool and provider gets: the run it is part of, if any, and the agent's services. Outside a run
 * (`agent.ctx`, `init`, commands) it is the host ctx: no `run`, valid for the agent's life.
 */
export interface Ctx {
  /**
   * the plugin this ctx is bound to, by the name it was loaded under ("host" for the host's own): what its entries'
   * types start with (`${ctx.plugin}:<type>`) and, by convention, its key in `state.data`
   */
  readonly plugin: string;
  run?: RunInfo;
  /**
   * the run's session; outside a run (the host ctx), the agent's current one when it is used (`agent.setSession`), so a
   * ctx kept from `init` follows `/new`, except for the `message` of a send appended outside a run: the session it went
   * to. A preview may have none.
   */
  readonly session?: Session;
  /** the tool call this ctx acts for: a tool's own, and that of events its `complete`/`emit`/`runTool` cause */
  callId?: string;
  /** aborted with the run; never, outside one */
  signal: AbortSignal;
  /** the working directory: the run's (`run.cwd`), else the session's (`SessionState.cwd`), else the process's */
  readonly cwd: string;
  /**
   * aborts the run (outside one: the runs on the ctx's session, every run when it has none); `run_end.aborted.by` names
   * the caller's plugin
   */
  abort(reason?: string): void;
  /** whether a run is in progress on the ctx's session (when it has none: on any) */
  busy(): boolean;
  /**
   * the run's callable tools (`run_start.tools`); outside a run, the agent's: every loaded one, and those plugins pushed
   * here since (builtin:mcp's, once connected). Each run's `run_start.tools` starts from a copy of the agent's. Pushed tools
   * aren't in `mergePlugins`, so a `Plugin.tools` wrap can't reach them: replace one in place in this array instead.
   */
  readonly tools: Tool[];
  /**
   * runs a tool through the gate (`tool_call`, `tool_update`, `tool_result`); from a tool, as `<callId>/<n>`. `signal`
   * aborts this call alone (its `ToolCtx.signal` is it combined with the run's), e.g. a script's timeout
   */
  runTool(call: ToolCall, opts?: { signal?: AbortSignal }): Promise<ToolResult>;
  /** one provider call, through `request`/`response` (`source` = the caller's plugin), not streamed to the host */
  complete(req: CompleteRequest): Promise<AssistantMessage>;
  /** models of every configured provider */
  listModels(): Promise<{ provider: string; id: string }[]>;
  /**
   * the provider (secrets.json name) and model a run on the ctx's session would use, `opts` overriding its settings,
   * with the provider's `info` on the model; throws when either is missing or unknown
   */
  resolve(opts?: {
    provider?: string;
    model?: string;
  }): Promise<Pick<RunInfo, "provider" | "type" | "endpoint" | "model" | "info">>;
  /** fires `name` to every plugin, in load order (declare its payload by merging into `Events`) */
  emit<E extends keyof Events>(name: E, payload: Events[E]): Promise<void>;
  emit(name: string, payload: unknown): Promise<void>;
  /**
   * the request a run on `messages` would send, tool prompts included: fires `run_start`/`prompt`/`request`/`run_end`
   * with `source: "preview"`, nothing else
   */
  preview(messages: Message[], opts?: RunOptions): Promise<Preview>;
  /** secrets.json, e.g. to reuse a login through its owner's `auth` */
  secrets: SecretStore;
  /** the host's `fetch` (`LoadOptions.fetch`, default the global one); use it for every request, so hosts can stub it */
  fetch: typeof globalThis.fetch;
  /**
   * Adds a user message to the ctx's session (see `SendOptions.deliver`). Resolves with the `run_end` of the run it
   * started or steered, undefined for "context" (or when an `input` handler took it, or the agent closed first). From a
   * run's own ctx (its handlers and tools) "steer"/"after" resolve at once with undefined: that run, or one starting
   * after it, can't end while the sender waits. Throws once the agent is closed.
   */
  send(msg: string | UserInput, opts?: SendOptions): Promise<RunEnd | undefined>;
  /**
   * Asks the user (or whoever answers: see `AskEvent`) and resolves with the first answer; undefined when nobody answers
   * (no UI: fail closed), it is dismissed, or the run aborts. With `{ detailed: true }`, resolves with the `Answered`
   * instead: who answered, why, and a rich dialog's `value`. `signal` withdraws it (reason "aborted"), e.g. once the
   * caller learned the answer some other way.
   */
  ask(req: AskRequest, opts?: { signal?: AbortSignal; detailed?: false }): Promise<Answer | undefined>;
  ask(req: AskRequest, opts: { signal?: AbortSignal; detailed: true }): Promise<Answered>;
  /**
   * Whether project input at `path` (a project dir or file, resolved against `ctx.cwd`) may be used, e.g. config that
   * starts processes: true when it or a directory above it is in `~/.hortus/trust.json`; else, on an interactive host,
   * asks once (kind "trust", `data: { path }`, options "Trust" / "Not now"; one question per path at a time, for every
   * plugin) and saves a "Trust"; a refusal holds for the agent's life (asked again in a new process); false when
   * nobody can answer. `reason` is added to the question.
   */
  trust(path: string, opts?: { reason?: string }): Promise<boolean>;
  /** a line for the user (the TUI shows it in the transcript); fires `notify` */
  notify(text: string, level?: Notify["level"]): Promise<void>;
  /**
   * sets (text) or clears (none) the status entry `key` of the ctx's session (the TUI's status bar draws the shown
   * session's); `color` is a theme token name (e.g. "green"; default "dim"); fires `status`
   */
  status(key: string, text?: string | { text: string; color?: string }): Promise<void>;
  /** what hosts the agent (`LoadOptions.host`) */
  readonly host: Host;
  /**
   * this plugin's own state for this agent: the same object for all of its handlers, tools and commands, in and out of
   * runs (a tool's: the plugin in its `plugin`); keep per-agent connections and caches here, not in module state
   */
  readonly state: Record<string, unknown>;
  /** asks the host to shut down, which then runs `agent.close` (`session_close("exit")`, `close`) */
  exit(): void;
  /** the plugins taking part where the ctx is (a run's, which a subrun's filter may narrow; else every loaded one) */
  plugins(): PluginInfo[];
  /**
   * the sends waiting on the ctx's session: those joining its run at the next turn boundary, then those queued to start
   * runs after it (e.g. to deliver a message only when no person's input is waiting)
   */
  pending(): PendingSend[];
  /**
   * Starts a nested run (`ctx.run.depth` + 1, `parent` set) on a session of its own with `input` (a message, after
   * `opts.seed`; or messages to seed it with, run with no new input). It reuses the loaded plugins (nothing reloads or reconnects); its usage is added to the calling
   * tool's result (else to the session's `usage`). See `SubrunOptions`.
   */
  subrun(input: string | UserInput | Message[], opts?: SubrunOptions): SubRun;
}

/**
 * `ctx.state[key]`, typed: made with `init()` the first time (per agent, like `ctx.state` itself), e.g.
 * `const st = (ctx: Ctx) => stateOf(ctx, "st", (): State => ({ runs: new Map() }))`.
 */
export function stateOf<S>(ctx: Pick<Ctx, "state">, key: string, init: () => S): S {
  if (!(key in ctx.state)) ctx.state[key] = init();
  return ctx.state[key] as S;
}

/** A plugin as `ctx.plugins()` lists it. */
export interface PluginInfo {
  name: string;
  /** defined in code: core's `builtin:*` pieces and the host's (`LoadOptions.pieces`, the CLI's `cli:*`) */
  builtin: boolean;
  /** subrun filters (`plugins.only`/`disable`) and `LoadOptions.only` can't leave it out (`hortus.json` `required`) */
  required: boolean;
  /** the names it stands in for */
  replaces?: string[];
}

/** A `send` waiting on a session, as `ctx.pending()` lists it. */
export interface PendingSend {
  deliver: NonNullable<SendOptions["deliver"]>;
  /** who sent it: the sending plugin, or `SendOptions.source` ("user" for a host's own) */
  source: string;
  message: UserMessage;
}

/** What hosts the agent, as `ctx.host` tells plugins; a host may add fields of its own (the TUI adds `cli`). */
export interface Host {
  /** "tui", "headless", "rpc", or a host's own */
  kind: string;
  /** whether a person can answer an `ask` now */
  interactive: boolean;
  /**
   * asks will be shown to a person at some point (the TUI and `--rpc` from the start, before they turn `interactive`):
   * a plugin may hold a question back until `interactive` fires instead of giving up at `ready`
   */
  ui?: boolean;
}

/** One choice of an `ask`. */
export interface AskOption {
  label: string;
  description?: string;
}

/** What `ctx.ask` takes. */
export interface AskRequest {
  /** names a rich dialog (the TUI's `cli.asks[kind]`); others answer from the generic fields */
  kind?: string;
  question: string;
  options?: AskOption[];
  /** several options may be picked: the answer is the array of their labels */
  multi?: boolean;
  /** free text may be typed (instead of picking an option) */
  allowText?: boolean;
  /** masked input; hosts never log, save or show the answer */
  secret?: boolean;
  /** for a `kind`'s dialog */
  data?: unknown;
}

/** A picked option's label, typed text, or (`multi`) the picked labels. */
export type Answer = string | string[];

/** How an ask ended: `AskEvent.answered`, and `ctx.ask(req, { detailed: true })`. */
export interface Answered {
  /** undefined: nobody answered */
  answer?: Answer;
  /** a rich dialog's structured result (`resolve(answer, { value })`), beside its plain `answer` */
  value?: unknown;
  /** the plugin whose handler resolved it (the TUI's dialog: "@hortus/cli"); none when nobody did */
  by?: string;
  /**
   * "answered", "dismissed" (`resolve(undefined)`), a resolver's own (`resolve(undefined, { reason: "timeout" })`),
   * "aborted" (the run was) or "unanswered" (every handler settled without answering: no UI, or nobody held it)
   */
  reason: string;
}

/**
 * `ask`'s payload. Handlers run at once, without awaiting each other, and any may `resolve` (a remote approver, an
 * autopilot on a timeout, the TUI's dialog): the first call wins (`undefined` dismisses), then `signal` aborts so the
 * others stop and `answered` settles. A handler that may answer later keeps its returned promise pending until it does
 * (or `signal` aborts): once every handler has settled with no answer, the ask resolves with undefined. Each handler
 * gets its own copy, whose `resolve` names it as `Answered.by`; everything else is shared.
 */
export interface AskEvent extends AskRequest {
  signal: AbortSignal;
  /** `value`: a structured result beside the plain answer; `reason`: why, for an `undefined` one (default "dismissed") */
  resolve(answer: Answer | undefined, opts?: { value?: unknown; reason?: string }): void;
  answered: Promise<Answered>;
  /** a host calls it when it puts the ask in front of someone (the TUI: when its dialog comes on screen) */
  show(): void;
  /**
   * settles at the first `show()`, e.g. to start a countdown then. Nothing shows asks on a host that isn't
   * `ctx.host.interactive` (headless), so a handler that would only wait for it checks that first and doesn't wait.
   */
  shown: Promise<void>;
  /** someone is answering (the TUI's dialog: the first key), so racing handlers (an autopilot) should back off */
  engage(): void;
  /** settles at the first `engage()` */
  engaged: Promise<void>;
}

/** `notify`'s payload. */
export interface Notify {
  text: string;
  level: "info" | "warn" | "error";
}

/** One choice for a command's argument. */
export interface Candidate {
  /** the argument once chosen; the typed argument is matched against it and the label */
  value: string;
  /** shown in the menu instead of `value` */
  label?: string;
  /** dim text after the label */
  description?: string;
}

/** A `/name arg` command (`Plugin.commands`), run by any host with the plugin's host ctx. */
export interface Command {
  name: string;
  /** other names that run it, e.g. "clear" for "new" */
  aliases?: string[];
  description: string;
  /** argument hint shown in menus, e.g. "[provider/model]" */
  args?: string;
  /** every candidate for the argument; menus narrow them by what's typed */
  complete?(ctx: Ctx): Candidate[] | Promise<Candidate[]>;
  /**
   * false leaves it out of `agent.commands()` (so menus don't offer it and a same-named earlier plugin's shows), and
   * running it then throws; asked at every listing, e.g. a command a plugin setting turns off
   */
  enabled?(ctx: Ctx): boolean;
  /** returned text is shown to the user; a throw is shown as an error */
  run(arg: string, ctx: Ctx): string | void | Promise<string | undefined> | Promise<void>;
}

/** A command as `agent.commands()` lists it: bound to its plugin's host ctx. */
export interface AgentCommand extends Omit<Command, "run" | "complete" | "enabled"> {
  /** the plugin it comes from */
  plugin: string;
  run(arg: string): Promise<string | undefined>;
  complete?(): Promise<Candidate[]>;
}

/** A user message's fields, as `ctx.send` and `agent.run` take them. */
export type UserInput = Omit<UserMessage, "role" | "entryId">;

/** How `ctx.send` delivers its message; `model`/`provider`/`effort` apply only to a run it starts. */
export interface SendOptions {
  /**
   * "context" (default): appended at the run's next turn boundary (never forcing a model call), or at once when idle.
   * "steer": the same during a run, which then goes on even after a final answer; when idle, starts a run. "after":
   * starts a run once the current one ends. From a run's own `input`/`run_start`/`prompt` handlers every mode appends
   * before its first request (others' sends to a starting run wait for its first turn boundary); from `run_end` (or a
   * `turn_end` that stops) every mode acts as when idle; a preview never starts a run.
   */
  deliver?: "context" | "steer" | "after";
  model?: string;
  provider?: string;
  effort?: Effort;
  /** `input.source` of a run it starts (default: the sending plugin) */
  source?: string;
}

/** A tool's `ctx`: `Ctx` plus its own call. */
export interface ToolCtx extends Ctx {
  callId: string;
  /** the calling tool's call id, for a call another tool made through `ctx.runTool` (a codemode script's) */
  parentId?: string;
  /**
   * ends the run after this batch of calls, as a `turn_end` handler's `stop` (which `turn_end` handlers may still undo);
   * Pi's `terminate`. From a subrun's tool, ends that subrun
   */
  stop(): void;
  /**
   * extra environment variables for processes the tool starts (builtin:bash merges them into its child's): the
   * `tool_call` handlers' `env`, which `tool_gate` sees; a wrapper may pass more on as
   * `Default.execute(input, { ...ctx, env: { ...ctx.env, NAME: value } })` (part of the tool: no gate sees that)
   */
  env?: Record<string, string>;
  /**
   * Reports progress to the host as a `tool_update` event (e.g. for a progress bar); never sent to the model. The last
   * value passed (as its `tool_update` handlers left it) becomes the result's `details`, saved with it, so pass what the
   * finished call's block should show last; `undefined` last means none.
   */
  update(details: unknown): void;
}

/** What a run uses besides the history; `model`/`provider` override the config. */
export interface RunOptions {
  model?: string;
  provider?: string;
  /** passed as is, not defaulted from config: unset means the provider's default */
  effort?: Effort;
  /** aborts the run (`run_end.aborted.by` = "user"): the stream rejects, tools get it as `ctx.signal` */
  signal?: AbortSignal;
  /**
   * the session to run on (default: the agent's current one; none: a fresh in-memory one). One run per session at a
   * time: a run on a session that has one waits for it to end.
   */
  session?: Session;
  /** `input.source` (default "user") */
  source?: string;
  /** the working directory (`ctx.run.cwd`); default the session's, else the process's (recorded as the session's) */
  cwd?: string;
}

/** What `ctx.subrun` takes besides the child's input. */
export interface SubrunOptions {
  /** the child's whole system prompt in place of the one `prompt` builds (a sent request's or a preview's may be reused) */
  system?: string;
  /**
   * the names of the tools the child may call, checked at every call (tools pushed into its `ctx.tools` later too);
   * default all of its plugins'. Never more than the caller's own list: a grandchild gets at most its parent's
   */
  tools?: string[];
  /**
   * which plugins take part (handlers and tools, merged anew; default the caller's run's, else all): `only` and
   * `disable` by name (or a name it `replaces`; `only` always keeps the host's own `LoadOptions.extra`, less their tools:
   * its observers; a name ending in `*` matches by prefix); `extra` adds child-only ones. `required` plugins (gates) are
   * never filtered out. Providers (and provider wraps) are never filtered out either: a filtered-out plugin still
   * provides them
   */
  plugins?: { only?: string[]; disable?: string[]; extra?: Named[] };
  /** default the caller's run's, else its session's */
  model?: string;
  provider?: string;
  effort?: Effort;
  /** default the session's (a resumed child's), else the caller's `ctx.cwd`; recorded in the child's session */
  cwd?: string;
  /**
   * aborts the child (`aborted.by` "user"); aborting the caller's run (or tool call) aborts it too, a run of it woken
   * later included, until the caller's run ends
   */
  signal?: AbortSignal;
  /**
   * "memory" (default), "file" (a session file under the caller's session's children: `listSessions({ parent })`), or
   * a session that is new (no entries) or a child's (one made by a subrun, or a file in the caller's children's
   * directory) to resume; never the caller's own or the current session, or one with a run in progress (that would wait
   * for it): those throw
   */
  session?: "memory" | "file" | Session;
  /** `ctx.run.source` (default the calling plugin) */
  source?: string;
  /** the child's agent name (`ctx.run.agent`), e.g. what a policy plugin keys per-agent rules on */
  agent?: string;
  /** messages the child's session starts with, before `input` (which then fires `input` as usual) */
  seed?: Message[];
  /**
   * outlives the caller: its abort (run, tool call, Esc) doesn't reach the child, and its usage goes to the caller's
   * session, never to the calling tool's result; `parent` is still the caller. Closing the agent still aborts it
   */
  detached?: boolean;
}

/** A running subrun, returned before its first event. */
export interface SubRun {
  /** its run's id (`ctx.run.id` in its handlers) */
  id: string;
  session: Session;
  /** `ctx.send` to its session: "steer" reaches the running child; once it ended, "steer"/"after" start it again */
  send(msg: string | UserInput, opts?: SendOptions): Promise<RunEnd | undefined>;
  /** aborts its running run (`aborted.by` = the caller's plugin) */
  abort(reason?: string): void;
  /**
   * its `run_end` (undefined when an `input` handler took it); rejects only if the agent closed before it started
   * (`subrun` itself throws once the agent is closed)
   */
  done: Promise<RunEnd | undefined>;
}

/** Token counts of one completion; `input` includes `cacheRead` and `cacheWrite`. */
export interface Usage {
  input: number;
  output: number;
  /** read from the prompt cache */
  cacheRead: number;
  /** written to the prompt cache, which costs more than input; only where the provider reports it */
  cacheWrite?: number;
  /** in USD, from providers (or wrappers) that know their prices */
  cost?: number;
}

/** A message's size in tokens, estimated as chars/4 (an image ~1200 tokens). */
export function messageTokens(m: Message): number {
  const IMAGE = 4800;
  const chars =
    m.role === "user"
      ? m.content.length + (m.images?.length ?? 0) * IMAGE
      : m.role === "tool"
        ? m.results.reduce((n, r) => n + r.output.length + (r.images?.length ?? 0) * IMAGE, 0)
        : m.text.length + JSON.stringify(m.toolCalls).length;
  return chars / 4;
}

/**
 * The context `messages` make, in tokens: the last reply's usage (`input + output`: its whole request and answer),
 * plus `messageTokens` of what came after it. What builtin:compaction compares with the window and the CLI shows.
 */
export function contextTokens(messages: readonly Message[]): number {
  let i = messages.length - 1;
  while (i >= 0 && !(messages[i]?.role === "assistant" && (messages[i] as AssistantMessage).usage)) i--;
  const u = (messages[i] as AssistantMessage | undefined)?.usage;
  return (u ? u.input + u.output : 0) + Math.ceil(messages.slice(i + 1).reduce((n, m) => n + messageTokens(m), 0));
}

/** `a` plus `b` (either may be missing); `cacheWrite` and `cost` only when either has them. */
export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a || !b) return a ?? b;
  const opt = (k: "cacheWrite" | "cost") =>
    a[k] === undefined && b[k] === undefined ? {} : { [k]: (a[k] ?? 0) + (b[k] ?? 0) };
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    ...opt("cacheWrite"),
    ...opt("cost"),
  };
}

/** A user message from a plugin: sent to the model as text; hosts render it by `type`, or hide it. */
export interface MessageMeta {
  plugin: string;
  type: string;
  details?: unknown;
  /** false: never shown; true: shown by hosts even without a renderer for its type (the CLI's built-in plugin-message look) */
  display?: boolean;
}

export interface UserMessage {
  role: "user";
  content: string;
  images?: Image[];
  meta?: MessageMeta;
  /** the session entry holding it (set in session state and run histories; providers never send it) */
  entryId?: string;
}

export type Message =
  | UserMessage
  // raw: provider-native content replayed as-is to the same provider (e.g. Anthropic thinking blocks)
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      raw?: { provider: string; content: unknown };
      usage?: Usage;
      entryId?: string;
    }
  | { role: "tool"; results: ToolResult[]; entryId?: string };

export type AssistantMessage = Extract<Message, { role: "assistant" }>;

/** What a tool does with its input, by input key: for gates and policies, instead of guessing from names. */
export interface ToolEffects {
  /** keys holding paths (a string or string array) it reads */
  reads?: string[];
  /** keys holding paths it writes, creates or deletes */
  writes?: string[];
  /** keys holding shell commands it runs */
  exec?: string[];
  /**
   * keys holding source code it runs with the agent's own powers (a script in any language, or JS in `node:vm`, which
   * is no sandbox; builtin codemode's QuickJS scripts reach out only through gated `tools.*` calls, so it has none):
   * gates treat it as running anything (ask, else block)
   */
  code?: string[];
  /** it changes nothing (an MCP tool's `readOnlyHint`) */
  readOnly?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  /** what it touches (builtins and read-only MCP tools declare it); none: unknown */
  effects?: ToolEffects;
  /** JSON Schema of what `execute` returns as `value` (codemode declares it as the call's return type) */
  outputSchema?: Record<string, unknown>;
  /** validates the input (`z.looseObject({})` leaves it to the tool); declared as JSON Schema unless `jsonSchema` is set */
  inputSchema: z.ZodObject;
  /** declared to the model as is, in place of `inputSchema`'s (an MCP tool's schema, which zod can't always express) */
  jsonSchema?: Record<string, unknown>;
  execute: (input: never, ctx: ToolCtx) => Promise<unknown>;
  /** "codemode": callable (by `ctx.runTool`, codemode scripts) but never declared to the model; default "direct" */
  exposure?: "direct" | "codemode";
  /**
   * this tool runs other tools from scripts (builtin:codemode's `codemode`, Fabric's `fabric_exec`): while a run has one,
   * `exposure: "codemode"` tools stay hidden from the model; without one, builtin:mcp declares its tools directly
   */
  codemodeHost?: boolean;
  /** structured facts about the tool for plugins and hosts (e.g. `mcp: { server, tool, annotations }`); never sent */
  meta?: Record<string, unknown>;
  /** runs alone, after the batch's other calls finished */
  sequential?: boolean;
  /** provider-specific tool fields by provider API (`anthropic`, `openai`, `openai-responses`), sent as they are */
  providerOptions?: Record<string, Record<string, unknown>>;
  /**
   * system prompt text about this tool: core appends it to a request's `system` (after the `request` handlers ran) only
   * when that request declares the tool, so it comes and goes with the declaration; a codemode-only tool (never
   * declared) never sends it; a `system` that already contains it (one reused from a sent request) doesn't get it twice
   */
  prompt?: string;
  /** set by core: the plugin that provided it (a wrap keeps it; its `ctx.state` is that plugin's) */
  plugin?: string;
}

/** Wraps the same-named tool of earlier plugins (load order); it gets that tool and returns the one to use instead. */
export interface ToolWrap {
  name: string;
  wrap(Default: Tool): Tool;
  /** when no earlier plugin provides the tool (e.g. it is disabled), skip this wrap silently instead of reporting it */
  optional?: boolean;
}

/**
 * What `execute` may return to set the result's fields itself: text for the model (`output`), a structured `value` for
 * `ctx.runTool` callers (codemode scripts), images, and `isError` without throwing. Make it with `toolResult`.
 */
export interface ToolOutput {
  output: string;
  value?: unknown;
  images?: Image[];
  isError?: boolean;
}
const OUTPUT = Symbol("hortus.toolResult");
/** Marks `r` as a result form for `execute` to return (a plain object would be a `value`, its JSON the output). */
export const toolResult = (r: ToolOutput): ToolOutput => Object.assign({ ...r }, { [OUTPUT]: true });
/** Whether `v` was made by `toolResult`. */
export const isToolOutput = (v: unknown): v is ToolOutput =>
  typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[OUTPUT] === true;

export const tool = <S extends z.ZodObject>(
  t: Omit<Tool, "inputSchema" | "execute"> & {
    inputSchema: S;
    execute: (input: z.infer<S>, ctx: ToolCtx) => Promise<unknown>;
  },
): Tool => t;

/** The JSON Schema a tool is declared with: its `jsonSchema`, else `inputSchema`'s. */
export const toolSchema = (t: Pick<Tool, "inputSchema" | "jsonSchema">): Record<string, unknown> =>
  t.jsonSchema ?? z.toJSONSchema(t.inputSchema);

/** Thinking effort; "off" disables thinking. Unset means the provider's default. */
export const EFFORTS = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * `effort` as a model taking only `efforts` (`ModelInfo.efforts`; none: all) accepts it: as is when it does, "off" as
 * its lowest level, another level as the nearest it takes (lower first). Core fits every request's this way.
 */
export function fitEffort(effort: Effort | undefined, efforts: readonly Effort[] | undefined): Effort | undefined {
  if (!effort || !efforts?.length || efforts.includes(effort)) return effort;
  // the levels it takes, lowest first
  const levels = EFFORTS.filter((e) => e !== "off" && efforts.includes(e));
  if (effort === "off") return levels[0];
  const lower = levels.filter((e) => EFFORTS.indexOf(e) < EFFORTS.indexOf(effort));
  return lower.at(-1) ?? levels[0] ?? efforts[0];
}

export interface CompletionRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: Tool[];
  effort?: Effort;
  /**
   * most output tokens: core sets it from the provider's `info(model).maxOutput`, so a routing wrapper's limit reaches
   * the provider it delegates to. Providers that must send one (Anthropic) use it, else their own.
   */
  maxTokens?: number;
  /** sampling temperature, sent only when set (Anthropic takes one only with thinking off: effort "off") */
  temperature?: number;
  /** sent with this request only (e.g. a session id a wrapper reads from `ctx.session`) */
  headers?: Record<string, string>;
  /** aborts the stream; the provider rejects */
  signal?: AbortSignal;
}

/** What `response.meta` reports; built-in providers fill what their API returns. */
export interface ResponseMeta {
  /** "end", "tool_use", "max_tokens", else the API's own reason */
  stopReason?: string;
  responseId?: string;
  model?: string;
  /** HTTP status */
  status?: number;
  /** HTTP response headers, lowercase names */
  headers?: Record<string, string>;
}

/** What a provider reports while it completes; every one is optional to call. */
export interface CompleteCallbacks {
  /** streamed text delta */
  text?(delta: string): void;
  /** streamed reasoning delta */
  thinking?(delta: string): void;
  /** streamed tool-call arguments, as deltas that concatenate to the call's JSON input */
  toolInput?(delta: { id: string; name: string; partial: string }): void;
  /** the serialized provider payload sent (observe-only, for `response.payload`) */
  payload?(body: unknown): void;
  /** merged into `response.meta`; may be called more than once */
  meta?(meta: ResponseMeta): void;
}

export interface Provider {
  /**
   * Streams one assistant turn. `ctx` is the caller's (the run's, or a plugin's `ctx.complete`), so per-call values
   * (session ids for headers, quotas) come from it rather than module state shared by concurrent runs.
   */
  complete(req: CompletionRequest, callbacks?: CompleteCallbacks, ctx?: Ctx): Promise<AssistantMessage>;
  /** Model ids usable as CompletionRequest.model. */
  listModels(): Promise<string[]>;
  /** What the API reports about `model`; unknown fields are left out. */
  info?(model: string): Promise<ModelInfo>;
}

export interface ModelInfo {
  /** input context window in tokens */
  contextWindow?: number;
  /** most output tokens per reply */
  maxOutput?: number;
  /** efforts `model` accepts; otherwise every one is offered */
  efforts?: Effort[];
  /** whether it takes image input */
  images?: boolean;
}

/** What `ProviderDef.create` gets besides the secrets.json entry. */
export interface CreateOptions {
  /** the entry's name in secrets.json (what `config.provider` selects) */
  name: string;
  /** sent with every request */
  headers?: Record<string, string>;
  /** used for every request in place of the global `fetch` (the agent passes `LoadOptions.fetch`) */
  fetch?: typeof globalThis.fetch;
  /**
   * The entry now: re-read and passed through `auth` under the secrets.json lock (`ctx.secrets.get(name)`), so a
   * provider refreshing a token that expires mid-run (in its `fetch`) uses the same path as the run did.
   */
  auth?(opts?: { refresh?: boolean }): Promise<Secret | undefined>;
  /**
   * The registered provider defs (every plugin's wraps applied, except `"*"` ones, which wrap this provider already), so
   * a routing provider delegates to `providers.anthropic.create(...)` and other plugins' wraps still apply.
   */
  providers?: Record<string, ProviderDef>;
}

export interface ProviderDef {
  /** `entry` is the whole secrets.json entry (unknown fields included), with `${VAR}` expanded */
  create(entry: Secret, opts: CreateOptions): Provider;
  /**
   * The entry to use now, e.g. with a refreshed OAuth token (`refresh` forces one); hortus saves it when it changed.
   * Called by `ctx.secrets.get`, so once per run (when it resolves the provider), under the secrets.json lock, with
   * the entry as stored; `fetch` is the host's. A token that can expire mid-run is refreshed by the provider itself, in
   * its `fetch`, through `CreateOptions.auth` (as the oauth-wrap reference plugin does).
   */
  auth?(entry: Secret, opts: { refresh: boolean; fetch: typeof globalThis.fetch }): Promise<Secret>;
}

/**
 * Wraps the same-named provider type of earlier plugins; under `"*"`, every type (later ones too), outermost. `ctx` is
 * the wrapping plugin's host ctx (its `ctx.state` is the one its handlers get; `complete`'s own ctx is the caller's).
 */
export interface ProviderWrap {
  wrap(Default: ProviderDef, ctx: Ctx): ProviderDef;
  /** when no earlier plugin provides the type, skip this wrap silently instead of reporting it */
  optional?: boolean;
}

/** A context file the prompt includes (an AGENTS.md), as `run_start.context` lists it. */
export interface ContextFile {
  path: string;
  content: string;
}

/** An Agent Skills (agentskills.io) skill: the model is told its name and description, and reads `path` when it applies. */
export interface Skill {
  name: string;
  description: string;
  /** its SKILL.md; relative paths in it resolve against its directory */
  path: string;
}

/** `request`'s payload: one provider call, editable by handlers (for that call only). */
export interface RequestEvent extends Omit<CompletionRequest, "signal"> {
  id: string;
  /** "run", "preview", or the plugin whose `ctx.complete` it is */
  source: string;
  /** the secrets.json entry the call goes to (observe-only: changing it doesn't reroute the call) */
  readonly provider: string;
  /** that entry's `type` */
  readonly type: string;
}

/**
 * What `ctx.preview` returns: the request, plus what `prompt` saw: the context files and skills the run would load (after
 * `run_start`).
 */
export interface Preview extends RequestEvent {
  context: readonly ContextFile[];
  skills?: readonly Skill[];
}

/** A request as sent, frozen. */
export interface SentRequest extends Readonly<Omit<RequestEvent, "messages" | "tools">> {
  readonly messages: readonly Message[];
  readonly tools: readonly Tool[];
}

export interface ResponseEvent {
  /** the `request`'s */
  id: string;
  /** what was actually sent (after every `request` handler), frozen */
  request: SentRequest;
  /** the provider's serialized payload (observe-only), from providers that report it */
  payload?: unknown;
  /** the reply; a handler may change it before it is used */
  assistant?: AssistantMessage;
  error?: unknown;
  meta?: ResponseMeta;
  /** true re-sends the request (firing `request` again), once per call */
  retry?: boolean;
}

/**
 * `compact`'s payload: builtin:compaction is about to replace the session's messages before `firstKeptId` with a
 * summary. The first `summary` (and the first `details`) a handler sets is final, and skips the model call that
 * otherwise writes it; `cancel = true` stops the compaction.
 */
export interface CompactEvent {
  /** "threshold" (the context neared the window), "overflow" (the provider rejected it; retried after), "manual" */
  reason: "threshold" | "overflow" | "manual";
  /** `/compact <instructions>`'s, or a `compact_request`'s */
  instructions?: string;
  /** what the summary replaces, each with its `entryId` (from after the previous summary up to `firstKeptId`) */
  readonly messages: readonly Message[];
  /**
   * every message a cut may keep or summarize, each with its `entryId`: the session's from after the previous summary to
   * the end, as they were when the compaction started (a different cut picks `firstKeptId` among them)
   */
  readonly all: readonly Message[];
  /** the first message kept (an entry id among the session's messages); none: keep nothing. Moving it moves the cut */
  firstKeptId?: string;
  /** the summary the session starts with now, which the new one replaces (it should carry it forward) */
  previousSummary?: string;
  /** the estimated context before compacting, in tokens */
  tokensBefore: number;
  contextWindow?: number;
  summary?: string;
  /** saved with the entry, for the compactor that wrote `summary` (e.g. files it tracked) */
  details?: unknown;
  cancel?: boolean;
}

/** The data of a `builtin:compaction:compaction` entry. */
export interface CompactionData {
  summary: string;
  details?: unknown;
  /** where the kept messages start; none: nothing before the entry was kept */
  firstKeptId?: string;
  tokensBefore: number;
  /** what writing the summary cost (none when a `compact` handler supplied it) */
  usage?: Usage;
}

/** Whether `m` is the summary message a `builtin:compaction:compaction` entry starts the session's messages with. */
export const isSummary = (m: Message | undefined): boolean =>
  m?.role === "user" && m.meta?.plugin === "builtin:compaction" && m.meta.type === "summary";

/** A tool call as `tool_call`/`tool_result` see it: `parentId` is the calling tool's, for `ctx.runTool` calls. */
export type GatedCall = ToolCall & { parentId?: string };

/**
 * Payload of each event; handlers may mutate it, in load order. Extend it by declaration merging for `ctx.emit` buses:
 * `declare module "@hortus/core" { interface Events { "my:event": {...} } }`. Order of one run: `run_start → prompt →
 * (turn_start → request → response → message → [tool_call → tool_gate (per call)… → tool_update* → tool_result…] → message → turn_end → message*)* → run_end`
 * (the `message`s after `turn_end` are those sent or steered during the turn).
 */
export interface Events {
  /** once, after the plugins loaded (host ctx; keep it for timers and sockets: it follows the current session) */
  init: Record<string, never>;
  /** once, after every `init` handler finished (host ctx): for work that needs other plugins' `init` done */
  ready: Record<string, never>;
  /** a session became the current one: the first ("start"), or by `/new` or `/resume` */
  session_open: { session: Session; reason: "start" | "new" | "resume" };
  /**
   * the current session is being left (for `target` on "new"/"resume": the session being switched to); `cancel = true`
   * keeps it (ignored on "exit"). On "exit" (and in `close`) handlers may still `ctx.subrun` (and send to their
   * children) until the exit's handlers have finished
   */
  session_close: { session: Session; reason: "new" | "resume" | "exit"; target?: Session; cancel?: boolean };
  /**
   * a session is left for good: after `session_close`, once no handler cancelled it; or "child", a subrun's session is
   * done (no `session_close` before it): once its caller's run has ended and it runs no more, else (`detached`, or
   * started outside a run) at exit. End per-session work here; a child resumed later is done again
   */
  session_closed: { session: Session; reason: "new" | "resume" | "exit" | "child"; target?: Session };
  /** once, at exit, after `session_close`: flush and drop per-run state of runs cut off by the exit */
  close: Record<string, never>;
  /**
   * before a run started from text (a host's prompt, a `send` that starts a run); edits change the saved message,
   * `handled = true` starts no run. `ctx.run` is already the run's (unless its provider or model doesn't resolve)
   */
  input: { text: string; images?: Image[]; meta?: MessageMeta; source: string; handled: boolean };
  /** a question for the user from `ctx.ask`; see `AskEvent` */
  ask: AskEvent;
  /** a line for the user, from `ctx.notify` */
  notify: Notify;
  /**
   * a status entry set (`text`, `color`: a theme token name) or cleared, from `ctx.status`; `session`: the id of the
   * session it belongs to (a run's or a session ctx's), none from a host ctx (host-wide, whatever session is current)
   */
  status: { key: string; text?: string; color?: string; session?: string };
  /** the host wants the user's attention (the TUI: `reason: "ask"` when it shows a dialog); desktop notifiers hook it */
  attention: { reason: string };
  /**
   * fired by a host when a person can now answer asks (the TUI: once its UI is up, after `ready` and the first
   * `session_open`, when asks still fail closed); questions held back at startup are asked then
   */
  interactive: Record<string, never>;
  /** a run ended and no other is queued on its session (never for previews) */
  idle: { session: Session };
  /**
   * fired by `listSkills(ctx)` (builtin:skills' `run_start`, hosts listing skills): builtin:skills pushes those found on
   * disk, others may push, remove or replace any; one per name, the last one wins
   */
  skills: { skills: Skill[] };
  /**
   * fired by builtin:mcp once, at `ready` (so every plugin's `init` has finished), seeded with `mcp.json`'s servers:
   * plugins add theirs (`mcp.json` wins on a name clash)
   */
  mcp_servers: { servers: Record<string, McpServer> };
  /** builtin:compaction is about to compact a session (see `CompactEvent`) */
  compact: CompactEvent;
  /** builtin:compaction saved a compaction: `entry` is its `builtin:compaction:compaction` entry (`CompactionData`) */
  compacted: { entry: PluginEntry<CompactionData>; reason: CompactEvent["reason"] };
  /**
   * asks builtin:compaction to compact the emitter's session now (`reason: "manual"`, as `/compact [instructions]`);
   * the emit resolves once it is done, and `done` gets the saved entry, or none and why (cancelled, nothing to compact,
   * or failed: builtin:compaction's text, as `/compact` shows it)
   */
  compact_request: {
    instructions?: string;
    done?(entry: PluginEntry<CompactionData> | undefined, reason?: string): void;
  };
  /** once per run, before anything is sent: change the callable tools, model, provider or effort */
  run_start: {
    source: "run" | "preview";
    tools: Tool[];
    /** set by builtin:skills (`listSkills`) in its `run_start`; absent without it */
    skills?: Skill[];
    /** context files (AGENTS.md) for the prompt: builtin:prompt pushes them here and renders them in `prompt` */
    context: ContextFile[];
    readonly messages: readonly Message[];
    model: string;
    provider: string;
    effort?: Effort;
  };
  /** after `run_start`: pieces push system prompt parts, joined by blank lines */
  prompt: {
    system: string[];
    readonly tools: readonly Tool[];
    readonly skills?: readonly Skill[];
    readonly context: readonly ContextFile[];
  };
  /** before every provider call (`ctx.complete` too); edits apply to that call only, `messages` is a copy */
  request: RequestEvent;
  /** after every provider call, success or failure */
  response: ResponseEvent;
  /** streamed assistant text delta */
  text: string;
  /** streamed reasoning delta, when the provider exposes it */
  thinking: string;
  /** streamed tool-call arguments, when the provider streams them */
  tool_input: { id: string; name: string; partial: string };
  /**
   * before each call; `call` is a copy (input edits apply to execution only). The first `result` set is final and skips
   * execution; a throwing handler blocks the call with an error result. `env`: extra environment for processes the tool
   * starts (`ToolCtx.env`). Then `tool_gate` decides
   */
  tool_call: { call: GatedCall; result?: ToolResult; env?: Record<string, string> };
  /**
   * after every `tool_call` handler, for gates: `call`, `env` and `result` are what will run (frozen), `tool` the tool
   * it resolves to (none: unknown or not callable). `block = "<reason>"` (the error result's whole output) or a throw
   * (`Blocked by <plugin>: …`) blocks it, the first block final, replacing even a `result` a `tool_call` handler supplied
   * (fail closed). Not fired for calls the provider ran itself
   */
  tool_gate: {
    readonly call: Readonly<GatedCall>;
    readonly tool?: Tool;
    readonly env?: Readonly<Record<string, string>>;
    readonly result?: Readonly<ToolResult>;
    block?: string;
  };
  /**
   * a running tool call's progress, from its `ctx.update`; `call` is the one `tool_call` gave (what runs). Not saved,
   * except the last one's `details` after its handlers (edits included) as the result's `details`
   */
  tool_update: { call: GatedCall; details: unknown };
  /** after each call, including results a `tool_call` handler supplied; `result` may be replaced (or edited) */
  tool_result: { call: GatedCall; result: ToolResult };
  /** a new message in the run's history */
  message: Message;
  /** before each turn's first request (a run's, not a preview's); `index` counts from 0 */
  turn_start: { index: number };
  /** after each assistant message and its tool results; `stop` ends the run */
  turn_end: { assistant: AssistantMessage; results?: ToolResult[]; stop: boolean };
  /** once per run, however it ended; once per `ctx.preview` too (`source: "preview"`) */
  run_end: RunEnd;
}

/** method syntax, so a reducer may narrow its entry's `data` type (method parameters are bivariant) */
interface EntryReducer {
  reduce(entry: PluginEntry, state: SessionState, plugin: string): void;
}

export type Handlers = { [E in keyof Events]?: (payload: Events[E], ctx: Ctx) => void | Promise<void> };

/**
 * Default export of a plugin's entrypoint (see `hortus.json` in plugins.ts). A plain tool or provider named like an
 * earlier plugin's is a conflict (reported, and skipped); a wrap layers over it.
 */
export interface Plugin {
  providers?: Record<string, ProviderDef | ProviderWrap>;
  tools?: (Tool | ToolWrap)[];
  on?: Handlers;
  /**
   * replays this plugin's session entries (`session.appendEntry(`${ctx.plugin}:<type>`, data)`) by `<type>`, usually
   * into `state.data[plugin]` (`plugin`: the name it was loaded under, as `ctx.plugin`); a plugin that `replaces` another
   * replays its types too. Replace values in `state.data`, don't mutate them. A reducer may declare its entry's data:
   * `(e: PluginEntry<Todo[]>, state, plugin) => …`
   */
  entries?: Record<string, EntryReducer["reduce"]>;
  /**
   * `/name arg` commands; one named like an earlier plugin's replaces it (`agent.commands()`). A function is called with
   * the plugin's host ctx at every listing, for commands that come and go (one per MCP prompt)
   */
  commands?: Command[] | ((ctx: Ctx) => Command[]);
}
