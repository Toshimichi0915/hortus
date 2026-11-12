import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { loadConfig } from "./config.ts";
import {
  addUsage,
  type AgentCommand,
  type Answer,
  type Answered,
  type AskRequest,
  type AssistantMessage,
  type CompleteRequest,
  type CompletionRequest,
  type CreateOptions,
  type Ctx,
  type Effort,
  type Events,
  fitEffort,
  type GatedCall,
  type Host,
  type Image,
  isToolOutput,
  type Message,
  type ModelInfo,
  type Preview,
  type RequestEvent,
  type ResponseEvent,
  type RunEnd,
  type RunInfo,
  type RunOptions,
  type SendOptions,
  type SentRequest,
  type SubRun,
  type SubrunOptions,
  type Tool,
  type ToolCall,
  type ToolCtx,
  type ToolResult,
  type Usage,
  type UserInput,
  type UserMessage,
} from "./llm.ts";
import { isNamed, type LoadOptions, loadNamed, mergePlugins, type Named, providersOnly, takesPart } from "./plugins.ts";
import {
  addTrusted,
  expandSecret,
  isTrusted,
  loadSecrets,
  type SecretStore,
  trustFile,
  updateSecret,
} from "./secrets.ts";
import { childDir, memorySession, newSession, type Reducers, type Session, sessionLineage } from "./session.ts";
import { saveImage } from "./tools.ts";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isImage = (v: unknown): v is Image => (v as Image | undefined)?.type === "image";

/**
 * A tool's result from what its `execute` returned: a string as is, other values as JSON, an image or an array of
 * images attached (each one without a `path` saved to a temp file, named in the output so the model can refer to it).
 */
function toResult(id: string, output: unknown): ToolResult {
  // `toolResult(...)`: its fields as given, its images saved like returned ones
  if (isToolOutput(output)) {
    const { output: text, value, images, isError } = output;
    const saved = images?.length ? toResult(id, images) : undefined;
    return {
      id,
      output: [text, saved?.output].filter(Boolean).join("\n"),
      ...(saved?.images && { images: saved.images }),
      ...(value !== undefined && { value }),
      ...(isError && { isError }),
    };
  }
  const images =
    Array.isArray(output) && output.length && output.every(isImage) ? output : isImage(output) ? [output] : undefined;
  if (typeof output === "string") return { id, output };
  if (!images) return { id, output: JSON.stringify(output), value: output };
  const lines: string[] = [];
  const saved = images.map(({ text, ...image }) => {
    if (text) lines.push(text);
    if (image.path) return image;
    const path = saveImage(image);
    lines.push(`[Image saved to ${path}]`);
    return { ...image, path };
  });
  return { id, output: lines.join("\n"), images: saved };
}

/** Validates `call`'s input and runs `tool` with it; a throw or invalid input is an error result. */
async function execute(tool: Tool, call: ToolCall, ctx: ToolCtx): Promise<ToolResult> {
  const input = tool.inputSchema.safeParse(call.input);
  if (!input.success) return { id: call.id, output: `Invalid input: ${input.error.message}`, isError: true };
  try {
    return toResult(call.id, await tool.execute(input.data as never, ctx));
  } catch (e) {
    return { id: call.id, output: errorText(e), isError: true };
  }
}

/** A `send` waiting for a turn boundary or for its run to start. */
interface Pending {
  msg: UserMessage;
  deliver: NonNullable<SendOptions["deliver"]>;
  opts: SendOptions;
  /** `input.source` of the run it starts */
  source: string;
  resolve(end: RunEnd | undefined): void;
}

/** The plugins taking part in a run, and their merged tools and providers. */
interface Kit {
  plugins: Named[];
  providers: ReturnType<typeof mergePlugins>["providers"];
  innerProviders: ReturnType<typeof mergePlugins>["innerProviders"];
  /** a top-level run's start from the agent's (`ctx.tools` outside runs, which plugins push to), a child's from these */
  tools: Tool[];
}

/** What makes runs on a session subruns (`ctx.subrun`): every run on it, a woken one too, is a child. */
interface Child {
  kit: Kit;
  depth: number;
  parent: NonNullable<RunInfo["parent"]>;
  /** `SubrunOptions.agent` */
  agent?: string;
  /** the top-level session's id */
  root?: string;
  system?: string;
  /** the tool names it may call */
  tools?: string[];
  /** its runs' defaults */
  opts: Pick<RunOptions, "model" | "provider" | "effort">;
  /** the id its next run takes (the handle's), once */
  id?: string;
  /** its latest run */
  run?: RunState;
  /** where each run's usage goes when it ends */
  report(usage: Usage): void;
  /** created during `close` (by its handlers): its runs and sends go on until `finished` */
  late: boolean;
  /** fires its `session_closed("child")`, once per arming (listed in `childEnds` until its handlers finish); a call
   * while one is in flight returns that one */
  end(): Promise<void>;
  /** its `session_closed("child")` has fired: a later run (woken by `send`) re-arms it */
  ended?: boolean;
  ending?: Promise<void>;
  /** woken while `ending`: that end leaves it armed, to end again after this run */
  rearmed?: boolean;
  /** fires `end` if the session is done: its caller's run has ended and it runs no more */
  settle(): Promise<void>;
}

/** A run in progress (or a preview). */
interface RunState {
  id: string;
  kit: Kit;
  child?: Child;
  cwd: string;
  /** tokens its messages spent so far (replies, and tool results' own: their subruns') */
  usage?: Usage;
  /** set once its provider is resolved */
  info?: RunInfo;
  /** a tool called `ToolCtx.stop()`: the turn ends the run */
  stopped?: boolean;
  controller: AbortController;
  aborted?: RunEnd["aborted"];
  /** the callable set, `run_start.tools` */
  tools: Tool[];
  /** a preview may have none */
  session?: Session;
  preview: boolean;
  /**
   * "start" until its first request (its own sends join it at once), "end" from its last turn on (sends act as when
   * idle)
   */
  phase: "start" | "loop" | "end";
  /**
   * what its requests send, `run_end.messages`: a run's is its session's messages, re-read (`sync`) for `run_start`,
   * each request and `run_end`; a preview's is its own
   */
  history: Message[];
  /** sends delivered at the next turn boundary */
  inbox: Pending[];
  /** resolves with its `run_end` payload */
  ended: Promise<RunEnd>;
  end(e: RunEnd): void;
}

/**
 * A session's runs, one at a time: the one sends from outside reach, how many run or wait their turn, and the sends to
 * start after.
 */
interface Lane {
  run?: RunState;
  running: number;
  /** settles when the last run that took its turn ends: the next waits for it */
  tail: Promise<void>;
  /** runs handed to the host (`onWake`) that it hasn't started yet */
  waking: number;
  queue: Pending[];
}

const userMessage = (input: string | UserInput): UserMessage =>
  typeof input === "string" ? { role: "user", content: input } : { ...input, role: "user" };

/** Resolves when `p` settles or after `ms`, whichever is first. */
function within(p: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([p.catch(() => {}), timeout]).finally(() => clearTimeout(timer));
}

/** Where events come from: a run (none: the host) and the tool call acting, if any. */
interface Scope {
  run?: RunState;
  /** outside a run, the session its ctx has (default: the current one) */
  session?: Session;
  callId?: string;
  /** aborts it, with the run's: a `ctx.runTool` call's own `signal` (and its tool's nested calls') */
  signal?: AbortSignal;
  /** `ctx.runTool` calls made from `callId` so far (an object, so copies of the scope share it) */
  sub: { n: number };
  /** a tool call's subruns' usage, added to its result while it runs (`open`) */
  tally?: { usage?: Usage; open: boolean };
  /** fire-and-forget events (deltas, tool updates) in order; the first error is kept for `drain` to throw */
  queue: { pending: Promise<void>; error?: unknown };
}

const newQueue = (): Scope["queue"] => ({ pending: Promise.resolve() });
const never = new AbortController().signal;

/**
 * Loads config and plugins once (built-in pieces, `opts.pieces`, ~/.hortus/plugins, then `opts.extra`, less
 * `config.disabledPlugins`). `run` reports progress as events (see `Events`) to every plugin, so a plugin in `extra` is
 * how a caller observes a run. `opts.onError` gets load conflicts (default: throw, failing the load) and, once loaded,
 * throwing handlers and duplicate run tools (default: print to stderr); either way the run goes on.
 */
export async function createAgent(opts: LoadOptions = {}) {
  const config = await loadConfig();
  const fetch = opts.fetch ?? globalThis.fetch;
  const onError = opts.onError ?? ((_: string, e: Error) => console.error(e.message));
  const plugins = await loadNamed(undefined, {
    ...opts,
    disabled: [...(config.disabledPlugins ?? []), ...(opts.disabled ?? [])],
  });
  // merged once the host ctx can be bound (provider wraps get their plugin's), right before `init`
  let base!: Kit;
  /** the agent's tools: `ctx.tools` outside runs, which plugins push to */
  let allTools!: Tool[];
  /** the merged tools as loaded, before plugins pushed any into the agent's: what an unfiltered child starts from */
  let loadedTools!: Tool[];
  /** `--parent`'s place in the session tree: top-level runs are its children */
  const lineage = opts.parent ? { session: opts.parent, ...(await sessionLineage(opts.parent)) } : undefined;
  const hostExtra = new Set((opts.extra ?? []).map((n) => n.name));
  const providerDef = (type: string, kit = base) =>
    Object.hasOwn(kit.providers, type) ? kit.providers[type] : undefined;

  /** secrets.json, for providers and for plugins reusing a login (see `SecretStore`) */
  const secrets: SecretStore = {
    async get(name, { refresh = false } = {}) {
      const entry = (await loadSecrets())[name];
      const auth = entry && providerDef(entry.type)?.auth;
      const fresh = auth ? await updateSecret(name, (e) => e && auth(e, { refresh, fetch })) : entry;
      return fresh && expandSecret(fresh);
    },
    update: updateSecret,
    async find(type) {
      return Object.entries(await loadSecrets()).flatMap(([name, e]) =>
        e?.type === type ? [{ name, entry: expandSecret(e) }] : [],
      );
    },
  };
  const createOptions = (name: string, kit = base): CreateOptions => ({
    name,
    fetch,
    auth: (o) => secrets.get(name, o),
    providers: kit.innerProviders,
  });
  /** Provider name, model and provider instance a run with `opts` (and `kit`'s providers) would use; throws if any is missing. */
  async function resolve(opts: Pick<RunOptions, "model" | "provider"> = {}, kit = base) {
    // read per run, like secrets, so a default `/model` saved mid-session applies to the next new session
    const config = await loadConfig();
    const name = opts.provider ?? config.provider;
    if (!name) throw new Error("No provider selected. Set 'provider' in ~/.hortus/config.json or use /model");
    // read per run so a key set mid-session (or a refreshed token) applies
    const secret = await secrets.get(name);
    if (!secret) throw new Error(`No API key for ${name}. Add it to ~/.hortus/secrets.json`);
    const def = providerDef(secret.type, kit);
    if (!def) throw new Error(`Unknown provider type: ${secret.type} (${Object.keys(kit.providers).join(", ")})`);
    const provider = def.create(secret, createOptions(name, kit));
    // config.model belongs to config.provider, so it doesn't carry over to another provider
    const model = opts.model ?? (name === config.provider ? config.model : undefined);
    if (!model) throw new Error("No model selected. Set 'model' in ~/.hortus/config.json or use /model");
    return { name, model, provider, type: secret.type, endpoint: secret.endpoint };
  }
  type Target = Awaited<ReturnType<typeof resolve>>;

  /** Models of every provider in secrets.json whose type is a known plugin provider (other entries are plugins'). */
  async function listModels() {
    const lists = await Promise.allSettled(
      Object.keys(await loadSecrets()).map(async (name) => {
        const secret = await secrets.get(name);
        const def = secret && providerDef(secret.type);
        if (!secret || !def) return [];
        return (await def.create(secret, createOptions(name)).listModels()).map((id) => ({ provider: name, id }));
      }),
    );
    // a provider whose listing fails is skipped, so one bad key doesn't hide the others' models
    return lists.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  const host: Host = opts.host ?? { kind: "headless", interactive: false };
  const exit = () => (opts.onExit ? opts.onExit() : void close());
  const active = new Set<RunState>();
  const hostScope: Scope = { sub: { n: 0 }, queue: newQueue() };
  /** the session runs and the host ctx use by default (`setSession`) */
  let current: Session | undefined;
  /** set by `close`: no more runs or sends, but subruns (and sends to their sessions) until `finished` */
  let closed = false;
  /** set once `close`'s handlers have finished (or timed out): nothing runs from then on */
  let finished = false;
  /** whether a run or send on `session` is refused now: once closing, only `late` children's go on, until `finished` */
  const shut = (session?: Session) => finished || (closed && !(session && children.get(session)?.late));
  /** every run (from its `input` to its `idle`), so `close` can wait for them */
  const running = new Set<Promise<unknown>>();
  const lanes = new WeakMap<Session, Lane>();
  /** sessions whose runs are subruns */
  const children = new WeakMap<Session, Child>();
  /** the `end` of every child not done yet, for `close` */
  const childEnds = new Set<() => Promise<void>>();
  /** the session a scope's ctx has: its run's, else its own, else the current one */
  const sessionOf = (scope: Scope) => (scope.run ? scope.run.session : (scope.session ?? current));
  /** the plugins taking part where `scope` is: its run's, else its (child) session's, else all */
  const kitOf = (scope: Scope) => scope.run?.kit ?? (scope.session && children.get(scope.session)?.kit) ?? base;
  /** `tools` less those `run`'s child may not call: checked wherever a call finds its tool, as `ctx.tools` is mutable */
  const allowed = (run: RunState | undefined, tools: Tool[]) => {
    const only = run?.child?.tools;
    return only ? tools.filter((t) => only.includes(t.name)) : tools;
  };
  /**
   * `tools` as `who`'s ctx shows it: a tool it adds without a `plugin` gets `who` (in place), so the tool shares its
   * plugin's `ctx.state` (a plugin pushing its own `tool()` constant back)
   */
  const proxies = new WeakMap<Tool[], Map<string, Tool[]>>();
  const stamping = (tools: Tool[], who: string): Tool[] => {
    if (who === "host") return tools;
    const byWho = proxies.get(tools) ?? new Map<string, Tool[]>();
    proxies.set(tools, byWho);
    let p = byWho.get(who);
    if (!p) {
      p = new Proxy(tools, {
        set(target, key, value) {
          if (typeof key === "string" && /^\d+$/.test(key) && value && typeof value === "object" && !value.plugin)
            value.plugin = who;
          return Reflect.set(target, key, value);
        },
      });
      byWho.set(who, p);
    }
    return p;
  };
  /** `ctx.state`, per plugin */
  const states = new Map<string, Record<string, unknown>>();
  const stateOf = (who: string) => {
    const st = states.get(who) ?? {};
    states.set(who, st);
    return st;
  };
  const laneOf = (session: Session) => {
    const lane = lanes.get(session) ?? { running: 0, waking: 0, queue: [], tail: Promise.resolve() };
    lanes.set(session, lane);
    return lane;
  };

  // each plugin's entry types under its own name, and under every name it stands in for (its own name wins)
  const reducers: Reducers = {};
  for (const { name, plugin, replaces = [] } of plugins)
    for (const [type, fn] of Object.entries(plugin.entries ?? {}))
      for (const prefix of [...replaces, name])
        reducers[`${prefix}:${type}`] = (entry, state) => {
          try {
            fn(entry, state, name);
          } catch (e) {
            onError(name, new Error(`Plugin ${name}'s ${type} entry failed: ${errorText(e)}`, { cause: e }));
          }
        };

  /**
   * Runs every plugin's `event` handler in load order, each with its own ctx. A throw goes to `onThrow` (default: to
   * `onError`, naming the plugin and event) and the next handler runs; `after` runs after each handler.
   */
  async function emit(
    scope: Scope,
    event: string,
    payload: unknown,
    onThrow?: (plugin: string, e: unknown) => void,
    after?: () => void,
  ) {
    for (const { name, plugin } of kitOf(scope).plugins) {
      const handler = (plugin.on as Record<string, ((p: unknown, ctx: Ctx) => unknown) | undefined> | undefined)?.[
        event
      ];
      if (!handler) continue;
      try {
        await handler(payload, bind(scope, name));
      } catch (e) {
        if (onThrow) onThrow(name, e);
        else onError(name, new Error(`Plugin ${name}'s ${event} handler failed: ${errorText(e)}`, { cause: e }));
      }
      after?.();
    }
  }
  /**
   * Emits after the events queued before it, without waiting (stream deltas, tool updates). Its handlers get a scope
   * with a queue of their own, so their `ctx.complete`/`ctx.runTool` don't wait for themselves.
   */
  const queue = (scope: Scope, event: string, payload: unknown) => {
    const q = scope.queue;
    q.pending = q.pending
      .then(() => emit({ ...scope, queue: newQueue() }, event, payload))
      .catch((e) => {
        q.error ??= e;
      });
  };
  /** Waits for `scope`'s queued events, then throws (once) the first error among them (only a throwing `onError`). */
  async function drain(scope: Scope) {
    const q = scope.queue;
    await q.pending;
    const { error } = q;
    q.error = undefined;
    if (error !== undefined) throw error;
  }

  const stop = (run: RunState, aborted: NonNullable<RunEnd["aborted"]>) => {
    if (run.controller.signal.aborted) return;
    run.aborted = aborted;
    run.controller.abort(new Error(aborted.reason ?? `Aborted by ${aborted.by}`));
  };

  /** The running runs on `scope`'s session (a run's, else the host scope's, else the current one); all without one. */
  const ours = (scope: Scope) => {
    const session = sessionOf(scope);
    return [...active].filter((r) => !session || r.session === session);
  };

  /** The ctx `who` (a plugin, or the host) gets in `scope`. */
  function bind(scope: Scope, who: string, stateKey = who): Ctx {
    const { run } = scope;
    const cwd = () => run?.cwd ?? sessionOf(scope)?.getState().cwd ?? process.cwd();
    return {
      plugin: who,
      get run() {
        return run?.info;
      },
      get session() {
        return sessionOf(scope);
      },
      get cwd() {
        return cwd();
      },
      callId: scope.callId,
      signal: scope.signal ?? run?.controller.signal ?? never,
      abort: (reason) => {
        for (const r of run ? [run] : ours(scope)) stop(r, { by: who, ...(reason !== undefined && { reason }) });
      },
      busy: () => ours(scope).length > 0,
      // a restricted child's are pruned to its allow-list on every read, so what handlers build from them (a
      // request's tools, a tool's description) offers nothing it can't call
      get tools() {
        const only = run?.child?.tools;
        if (run && only)
          for (let i = run.tools.length; i--; ) if (!only.includes(run.tools[i]?.name ?? "")) run.tools.splice(i, 1);
        return stamping(run?.tools ?? allTools, who);
      },
      runTool: (call, o) => runTool(scope, call, o?.signal),
      complete: (req) => complete(scope, who, req),
      listModels,
      resolve: async (o = {}) => {
        const settings = sessionOf(scope)?.getState();
        const t = await resolve(
          { model: o.model ?? settings?.model, provider: o.provider ?? settings?.provider },
          kitOf(scope),
        );
        const { name: provider, type, endpoint, model } = t;
        return { provider, type, ...(endpoint !== undefined && { endpoint }), model, info: await modelInfo(t, model) };
      },
      emit: (name: string, payload: unknown) => emit(scope, name, payload),
      plugins: () =>
        kitOf(scope).plugins.flatMap((n) =>
          takesPart(n)
            ? [
                {
                  name: n.name,
                  builtin: !!n.builtin,
                  required: !!n.required,
                  ...(n.replaces && { replaces: [...n.replaces] }),
                },
              ]
            : [],
        ),
      pending: () => {
        const session = sessionOf(scope);
        const lane = session && lanes.get(session);
        return [...(lane?.run?.inbox ?? []), ...(lane?.queue ?? [])].map((p) => ({
          deliver: p.deliver,
          source: p.source,
          message: p.msg,
        }));
      },
      preview: (messages, o) => preview(messages, o),
      secrets,
      fetch,
      send: (msg, o) => send(scope, who, msg, o),
      ask: (async (req: AskRequest, o?: { signal?: AbortSignal; detailed?: boolean }) => {
        const a = await ask(scope, req, o?.signal);
        return o?.detailed ? a : a.answer;
      }) as Ctx["ask"],
      trust: async (path, o) => trust(scope, resolvePath(cwd(), path), o?.reason),
      notify: (text, level = "info") => emit(scope, "notify", { text, level }),
      status: (key, text) => {
        // the scope's own session (a host ctx has none, not the current one): what the status belongs to
        const session = (scope.run?.session ?? scope.session)?.id;
        return emit(scope, "status", {
          key,
          ...(typeof text === "string" ? { text } : text),
          ...(session && { session }),
        });
      },
      host,
      state: stateOf(stateKey),
      exit,
      subrun: (input, o) => subrun(scope, who, input, o),
    };
  }

  /**
   * `ctx.ask`: every `ask` handler at once, each with its own copy of the payload (its `resolve` names it); the first
   * `resolve` wins, else "unanswered" once all have settled.
   */
  async function ask(scope: Scope, req: AskRequest, signal?: AbortSignal): Promise<Answered> {
    const controller = new AbortController();
    let settle!: (a: Answered) => void;
    const answered = new Promise<Answered>((r) => {
      settle = r;
    });
    const end = (a: Answered) => {
      if (controller.signal.aborted) return;
      controller.abort();
      settle(a);
    };
    const resolveAs =
      (by: string) =>
      (answer: Answer | undefined, o: { value?: unknown; reason?: string } = {}) =>
        end({
          ...(answer !== undefined && { answer }),
          ...(o.value !== undefined && { value: o.value }),
          by,
          reason: answer !== undefined ? "answered" : (o.reason ?? "dismissed"),
        });
    // aborting the run dismisses its asks
    const runSignal = scope.signal ?? scope.run?.controller.signal;
    const aborted = () => end({ reason: "aborted" });
    runSignal?.addEventListener("abort", aborted);
    signal?.addEventListener("abort", aborted);
    if (runSignal?.aborted || signal?.aborted) aborted();
    const once = () => {
      let fire!: () => void;
      return { promise: new Promise<void>((r) => (fire = r)), fire: () => fire() };
    };
    const shown = once();
    const engaged = once();
    const payload: Omit<Events["ask"], "resolve"> = {
      ...req,
      signal: controller.signal,
      answered,
      show: shown.fire,
      shown: shown.promise,
      engage: engaged.fire,
      engaged: engaged.promise,
    };
    // "unanswered" once every handler has settled without answering
    let pending = 0;
    let started = false;
    const check = () => {
      if (started && pending === 0) end({ reason: "unanswered" });
    };
    for (const { name, plugin } of kitOf(scope).plugins) {
      const h = plugin.on?.ask;
      if (!h) continue;
      const p: Events["ask"] = { ...payload, resolve: resolveAs(name) };
      pending++;
      // called in load order without waiting on each other; a sync answer is seen by the handlers after it
      void (async () => h(p, bind(scope, name)))()
        .catch((e) => onError(name, new Error(`Plugin ${name}'s ask handler failed: ${errorText(e)}`, { cause: e })))
        .finally(() => {
          pending--;
          check();
        });
    }
    started = true;
    check();
    try {
      return await answered;
    } finally {
      runSignal?.removeEventListener("abort", aborted);
      signal?.removeEventListener("abort", aborted);
    }
  }

  /** `ctx.trust`'s questions by path: one at a time for everyone; a refusal stays for the agent's life */
  const trustAsks = new Map<string, Promise<boolean>>();
  async function trust(scope: Scope, path: string, reason?: string): Promise<boolean> {
    const real = await realpath(path).catch(() => path);
    if (await isTrusted(real)) return true;
    const known = trustAsks.get(real);
    if (known) return known;
    if (!host.interactive) return false;
    const asked = ask(scope, {
      kind: "trust",
      question: `Trust ${real}?${reason ? ` ${reason}` : ""}\nIts project files may configure what runs on this machine.`,
      options: [
        { label: "Trust", description: `remembered in ${trustFile()}` },
        { label: "Not now", description: "ask again in a new hortus" },
      ],
      data: { path: real },
    }).then(async (a) => {
      if (a.answer === "Trust") await addTrusted(real);
      // nobody saw it (unanswered, aborted): ask again next time
      else if (a.reason !== "answered" && a.reason !== "dismissed") trustAsks.delete(real);
      return a.answer === "Trust";
    });
    trustAsks.set(real, asked);
    return asked;
  }

  /** Adds `msg` to `scope`'s run (never a preview): saved to its session and announced as a `message`. */
  async function add(scope: Scope, msg: Message): Promise<Message> {
    const run = scope.run as RunState;
    run.usage = addUsage(run.usage, usageOf(msg));
    const [saved = msg] = await (run.session as Session).append([msg]);
    await emit(scope, "message", saved);
    return saved;
  }

  /** A run's history made its session's messages as they are now (a preview's is its own). */
  const sync = (run: RunState) => {
    if (!run.preview && run.session) run.history.splice(0, Infinity, ...run.session.getState().messages);
  };

  /** Appends `msg` to `session` outside any run (announced as a `message` to a host ctx on that session). */
  async function appendIdle(session: Session, msg: Message) {
    const [saved] = await session.append([msg]);
    if (saved) await emit({ ...hostScope, session }, "message", saved);
  }

  /** `ctx.send`; see `SendOptions` for what each `deliver` does when. */
  async function send(scope: Scope, who: string, input: string | UserInput, opts: SendOptions = {}) {
    const { run } = scope;
    const session = run ? run.session : (scope.session ?? current);
    if (shut(session)) throw new Error("The agent is closed: nothing can be sent");
    const msg = userMessage(input);
    // a preview never starts a run, and keeps what joins it to itself
    if (run?.preview) {
      if (run.phase === "start") run.history.push(msg);
      else if (session) await deliver(session, undefined, msg, { ...opts, deliver: "context" }, who);
      return undefined;
    }
    if (!session) throw new Error("There is no session to send to");
    return deliver(session, run, msg, opts, who);
  }

  /**
   * Delivers `msg` to `session`'s run `own` (the sender's: its sends resolve at once, as awaiting a run this run waits
   * for would deadlock) or else the one running on it, else as when idle.
   */
  async function deliver(
    session: Session,
    own: RunState | undefined,
    msg: UserMessage,
    opts: SendOptions,
    who: string,
  ): Promise<RunEnd | undefined> {
    const lane = laneOf(session);
    // ponytail: between a run's end and a queued run's start (the host holding its `onWake`) there's no run to steer,
    // so a steer then queues a run of its own; give the woken run an inbox from its wake if that matters
    const target = own ?? lane.run;
    const mode = opts.deliver ?? "context";
    if (own?.phase === "start") {
      await add({ run: own, sub: { n: 0 }, queue: newQueue() }, msg);
      return undefined;
    }
    // another sender's sends wait for the first boundary of a run that is still starting
    if (target && target.phase !== "end" && mode !== "after")
      return new Promise((resolve) => {
        target.inbox.push({ msg, deliver: mode, opts, source: opts.source ?? who, resolve });
        if (mode === "context" || own) resolve(undefined);
      });
    if (mode === "context") {
      await appendIdle(session, msg);
      return undefined;
    }
    return new Promise((resolve) => {
      lane.queue.push({ msg, deliver: mode, opts, source: opts.source ?? who, resolve });
      if (!lane.running && !lane.waking) next(session, lane);
      if (own) resolve(undefined);
    });
  }

  /**
   * Starts the first run queued on `session`, through the host's `onWake` if it has one; false if none is queued. Once
   * closed, starts none: the queued sends resolve with undefined.
   */
  function next(session: Session, lane: Lane): boolean {
    if (shut(session)) for (const p of lane.queue.splice(0)) p.resolve(undefined);
    const p = lane.queue.shift();
    if (!p) return false;
    lane.waking++;
    let started = false;
    const start = async (hostOpts: RunOptions = {}) => {
      if (started) throw new Error("This run has already started");
      started = true;
      lane.waking--;
      const { model, provider, effort } = p.opts;
      const end = await execRun(p.msg, {
        ...hostOpts,
        ...(model !== undefined && { model }),
        ...(provider !== undefined && { provider }),
        ...(effort !== undefined && { effort }),
        session,
        source: p.source,
      }).catch((e) => {
        p.resolve(undefined);
        throw e;
      });
      p.resolve(end);
      return end;
    };
    if (opts.onWake) opts.onWake(start, session);
    else void start().catch((e) => onError("host", new Error(`A run failed to start: ${errorText(e)}`)));
    return true;
  }

  /**
   * Makes `session` the current one: `session_close` for the one before (`target`: `session`; its handlers may cancel,
   * then false), then `session_open` ("start" for the first).
   */
  async function setSession(session: Session, reason: "new" | "resume" = "new"): Promise<boolean> {
    session.replay(reducers);
    const prev = current;
    if (prev) {
      const p: Events["session_close"] = { session: prev, reason, target: session };
      await emit(hostScope, "session_close", p);
      if (p.cancel) return false;
      await emit(hostScope, "session_closed", { session: prev, reason, target: session });
    }
    current = session;
    await emit(hostScope, "session_open", { session, reason: prev ? reason : "start" });
    return true;
  }

  /**
   * Exit: aborts every run and waits for its `run_end`, then fires `session_close("exit")` and `close`, each wait cut
   * off after `timeout` ms. `send` throws from then on; their handlers may still start subruns (and send to them), which
   * are aborted once they have finished.
   */
  let closing: Promise<void> | undefined;
  function close({ timeout = 3000 } = {}) {
    closing ??= (async () => {
      closed = true;
      for (const r of active) stop(r, { by: "host", reason: "exit" });
      await within(Promise.all(running), timeout);
      await within(
        (async () => {
          if (current) {
            await emit(hostScope, "session_close", { session: current, reason: "exit" });
            await emit(hostScope, "session_closed", { session: current, reason: "exit" });
          }
          // children not done yet (detached ones, those started outside a run, or still running)
          for (const end of [...childEnds]) await end();
          await emit(hostScope, "close", {});
        })(),
        timeout,
      );
      // subruns the handlers started (and left running, or cut off by the timeout)
      finished = true;
      for (const r of active) stop(r, { by: "host", reason: "exit" });
    })();
    return closing;
  }

  // once per provider and model (OpenAI-type info pages through the whole model list); a failed lookup reads as none
  // ponytail: cached for the agent's life, even a failure; key it with a TTL if limits change or lookups flake
  const infos = new Map<string, Promise<ModelInfo>>();
  const modelInfo = ({ name, provider }: Target, model: string) => {
    const key = `${name}/${model}`;
    let m = infos.get(key);
    if (!m) {
      m = Promise.resolve(provider.info?.(model)).then(
        (i) => i ?? {},
        () => ({}),
      );
      infos.set(key, m);
    }
    return m;
  };

  /**
   * Fills `maxTokens` (unless set) from the provider's `info` and fits `effort` to its `efforts`, fires `request`, then answers unanswered calls (see
   * `answered`) and appends the `prompt` of each tool it declares to `system` (unless it already ends with them: callers
   * reuse a sent request's or a preview's); what it returns is what to send.
   */
  async function request(
    scope: Scope,
    source: string,
    target: Target,
    fields: Omit<CompletionRequest, "signal">,
  ): Promise<RequestEvent> {
    // a run's own request is built from its session's messages, re-read (a retry too) so what was persisted meanwhile
    // (a reducer rewriting them) applies
    const { run } = scope;
    if (run && fields.messages === run.history) sync(run);
    const info = await modelInfo(target, fields.model);
    const maxTokens = fields.maxTokens ?? info.maxOutput;
    const effort = fitEffort(fields.effort, info.efforts);
    const r: RequestEvent = {
      id: randomUUID(),
      source,
      provider: target.name,
      type: target.type,
      ...fields,
      ...(maxTokens !== undefined && { maxTokens }),
      ...(effort !== undefined && { effort }),
      // deep, so in-place edits don't reach the run's history (or the caller's); tools are shared defs. Without
      // results' `details`: providers never send them, and they may not be cloneable (a function, say)
      messages: structuredClone(fields.messages.map(withoutDetails)),
      tools: [...fields.tools],
    };
    await emit(scope, "request", r);
    // after the handlers, so messages one set are answered too
    r.messages = answered(r.messages);
    // already there only if `system` ends with exactly this block (a reused request's), not merely quotes a prompt
    const block = r.tools.flatMap((t) => (t.prompt ? [t.prompt] : [])).join("\n\n");
    if (block && r.system !== block && !r.system?.endsWith(`\n\n${block}`))
      r.system = [r.system, block].filter(Boolean).join("\n\n");
    return r;
  }

  /**
   * The one path to a provider (runs and `ctx.complete`): `request`, the call, then `response`, which may ask for one
   * retry. `stream` emits its deltas (`text`, `thinking`, `tool_input`), as a run does.
   */
  async function call(
    scope: Scope,
    source: string,
    target: Target,
    fields: Omit<CompletionRequest, "signal">,
    stream: boolean,
    /** the caller's own (`CompleteRequest.signal`), with the run's */
    own?: AbortSignal,
  ): Promise<{ assistant: AssistantMessage; sent: SentRequest }> {
    const signals = [scope.signal ?? scope.run?.controller.signal, own].filter((x) => x !== undefined);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    for (let retried = false; ; retried = true) {
      const r = await request(scope, source, target, fields);
      const sent = Object.freeze({
        ...r,
        messages: Object.freeze([...r.messages]),
        tools: Object.freeze([...r.tools]),
      });
      const response: ResponseEvent = { id: r.id, request: sent };
      const { id: _, source: __, provider: ___, type: ____, ...req } = sent;
      try {
        response.assistant = await target.provider.complete(
          { ...req, messages: [...sent.messages], tools: [...sent.tools], ...(signal && { signal }) },
          {
            ...(stream && {
              text: (d) => queue(scope, "text", d),
              thinking: (d) => queue(scope, "thinking", d),
              toolInput: (d) => queue(scope, "tool_input", d),
            }),
            payload: (body) => {
              response.payload = body;
            },
            meta: (m) => {
              response.meta = { ...response.meta, ...m };
            },
          },
          bind(scope, target.name),
        );
      } catch (e) {
        response.error = e;
        // the SDKs' API errors carry the HTTP status and headers
        const { status, headers } = (e ?? {}) as {
          status?: unknown;
          headers?: ConstructorParameters<typeof Headers>[0];
        };
        if (typeof status === "number")
          response.meta = {
            ...response.meta,
            status,
            ...(headers && { headers: Object.fromEntries(new Headers(headers)) }),
          };
      }
      // the deltas' handlers run before `response`
      await scope.queue.pending;
      await emit(scope, "response", response);
      if (response.retry && !retried && !signal?.aborted) continue;
      await drain(scope);
      if (response.error !== undefined || !response.assistant) throw response.error;
      return { assistant: response.assistant, sent };
    }
  }

  /** `ctx.complete`: one call to the run's provider and model (else config's), or the ones `req` names. */
  async function complete(scope: Scope, who: string, req: CompleteRequest): Promise<AssistantMessage> {
    const { provider, model, system = "", tools = [], signal, ...rest } = req;
    const run = scope.run?.info;
    const target = await resolve(
      { provider: provider ?? run?.provider, model: model ?? (provider ? undefined : run?.model) },
      kitOf(scope),
    );
    return (await call(scope, who, target, { ...rest, model: target.model, system, tools }, false, signal)).assistant;
  }

  /**
   * `tool_call` for `call` (the call to run, a copy, and the result a handler set; a throwing handler blocks it), then,
   * unless the provider ran it (`tools` undefined), `tool_gate` on the final call, frozen: a block there is final.
   */
  async function gate(scope: Scope, call: GatedCall, tools?: Tool[], preset?: ToolResult) {
    const payload: Events["tool_call"] = {
      call: { ...call, input: structuredClone(call.input) },
      ...(preset && { result: preset }),
    };
    // the first result set is final: later handlers see it, but what they do to it is undone
    let final = preset;
    await emit(
      scope,
      "tool_call",
      payload,
      (plugin, e) => {
        final ??= { id: call.id, output: `Blocked by ${plugin}: ${errorText(e)}`, isError: true };
      },
      () => {
        if (final) payload.result = final;
        else final = payload.result;
      },
    );
    if (!tools) return payload;
    // what runs is exactly what the gates saw: a copy no mutator still holds, frozen
    const frozen = Object.freeze({ ...payload.call, input: deepFreeze(structuredClone(payload.call.input)) });
    const env = payload.env && Object.freeze({ ...payload.env });
    // the tool that runs: a `tool_call` handler may have renamed the call
    const tool = allowed(scope.run, tools).find((t) => t.name === frozen.name);
    const g: Events["tool_gate"] = {
      call: frozen,
      ...(tool && { tool }),
      ...(env && { env }),
      ...(payload.result && { result: Object.freeze({ ...payload.result }) }),
    };
    let block: string | undefined;
    await emit(
      scope,
      "tool_gate",
      g,
      (plugin, e) => {
        block ??= `Blocked by ${plugin}: ${errorText(e)}`;
      },
      () => {
        if (block !== undefined) g.block = block;
        else if (typeof g.block === "string") block = g.block;
      },
    );
    return {
      call: frozen,
      ...(env && { env }),
      ...(block !== undefined
        ? { result: { id: call.id, output: block, isError: true } }
        : payload.result && { result: payload.result }),
    };
  }

  /** A gated call's result (the one a handler set, else its tool's from `tools`), then `tool_result`. */
  async function finish(
    scope: Scope,
    { call, result: preset, env }: Events["tool_call"],
    tools: Tool[],
  ): Promise<ToolResult> {
    let result = preset;
    const tool = allowed(scope.run, tools).find((t) => t.name === call.name);
    // aborted while gating or before its turn (a sequential call): not run
    if (!result && (scope.signal ?? scope.run?.controller.signal)?.aborted)
      result = { id: call.id, output: "Aborted", isError: true };
    if (!result && !tool) result = { id: call.id, output: `Unknown tool: ${call.name}`, isError: true };
    // the last update, which its handlers may still change: its `details` are saved
    let last: Events["tool_update"] | undefined;
    let durationMs: number | undefined;
    if (!result && tool) {
      const tally: NonNullable<Scope["tally"]> = { open: true };
      const child: Scope = {
        run: scope.run,
        ...(scope.session && { session: scope.session }),
        callId: call.id,
        sub: { n: 0 },
        queue: scope.queue,
        tally,
        ...(scope.signal && { signal: scope.signal }),
      };
      const ctx: ToolCtx = Object.assign(bind(child, tool.plugin ?? tool.name, tool.plugin ?? `\0tool:${tool.name}`), {
        callId: call.id,
        ...(call.parentId !== undefined && { parentId: call.parentId }),
        ...(env && { env: { ...env } }),
        update: (details: unknown) => {
          last = { call, details };
          queue(scope, "tool_update", last);
        },
        stop: () => {
          if (scope.run) scope.run.stopped = true;
        },
      });
      // the tool gets its own copy of the frozen input the gates saw
      const started = performance.now();
      result = await execute(tool, { ...call, input: structuredClone(call.input) }, ctx);
      durationMs = Math.round(performance.now() - started);
      result = { ...result, durationMs };
      // its subruns' usage: on its result, or for a nested call (whose result isn't saved), on its caller's
      tally.open = false;
      if (tally.usage && scope.tally?.open) scope.tally.usage = addUsage(scope.tally.usage, tally.usage);
      else if (tally.usage) result = { ...result, usage: addUsage(result.usage, tally.usage) };
    }
    await scope.queue.pending;
    // before handlers can change it in place
    const output = (result as ToolResult).output;
    const done: Events["tool_result"] = { call, result: result as ToolResult };
    if (last?.details !== undefined) done.result = { ...done.result, details: last.details };
    await emit(scope, "tool_result", done);
    // a handler's replacement keeps the call's id (else no tool_result answers the call); one that isn't a result is
    // ignored
    const { value, ...ok } = done.result && typeof done.result === "object" ? done.result : (result as ToolResult);
    const keepValue = value !== undefined && ok.output === output;
    // images a handler added are saved like returned ones, so the transcript and session can name them
    const unsaved = ok.images?.filter((i) => !i.path) ?? [];
    if (unsaved.length) {
      const saved = toResult(call.id, unsaved);
      let n = 0;
      ok.images = ok.images?.map((i) => (i.path ? i : (saved.images?.[n++] ?? i)));
      ok.output = [ok.output, saved.output].filter(Boolean).join("\n");
    }
    // `value` is the tool's own: once a handler changed the output (a redaction, say), a `ctx.runTool` caller gets that
    return {
      ...ok,
      ...(keepValue && { value }),
      ...(durationMs !== undefined && { durationMs }),
      id: call.id,
    };
  }

  /**
   * `ctx.runTool`: gated like a model's call; from a tool, its id is `<callId>/<n>` with `parentId` = `callId`. `signal`
   * aborts this call (and its tool's own nested calls) along with whatever already aborts `scope`.
   */
  async function runTool(scope: Scope, call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    if (signal) {
      const outer = scope.signal ?? scope.run?.controller.signal;
      scope = { ...scope, signal: outer ? AbortSignal.any([outer, signal]) : signal };
    }
    const c: GatedCall = scope.callId
      ? { ...call, id: `${scope.callId}/${++scope.sub.n}`, parentId: scope.callId }
      : call;
    const callable = scope.run?.tools ?? allTools;
    if (scope.run) return finish(scope, await gate(scope, c, callable), callable);
    // outside a run, a call has a queue of its own, whose error (a throwing onError) only its caller gets
    const own: Scope = { ...scope, queue: newQueue() };
    const result = await finish(own, await gate(own, c, callable), callable);
    await drain(own);
    return result;
  }

  /**
   * A turn's tool calls: every one through `tool_call` first, then the parallel ones together and the `sequential` ones
   * alone, after them. Model calls reach only the tools `declared` in that request.
   */
  async function runCalls(scope: Scope, calls: ToolCall[], declared: Tool[]): Promise<ToolResult[]> {
    const gated: Events["tool_call"][] = [];
    for (const c of calls) gated.push(await gate(scope, c, declared));
    const alone = (g: Events["tool_call"]) => !g.result && declared.find((t) => t.name === g.call.name)?.sequential;
    // a model's call keeps no `value`: it is for ctx.runTool callers, and the result is saved
    const run = async (g: Events["tool_call"]) => {
      const { value: _, ...r } = await finish(scope, g, declared);
      return r;
    };
    const results = await Promise.all(gated.map((g) => (alone(g) ? undefined : run(g))));
    for (const [i, g] of gated.entries()) if (alone(g)) results[i] = await run(g);
    return results as ToolResult[];
  }

  const newRun = (
    session: Session | undefined,
    preview: boolean,
    history: Message[],
    cwd: string,
    child?: Child,
  ): RunState => {
    let end!: (e: RunEnd) => void;
    const ended = new Promise<RunEnd>((resolve) => {
      end = resolve;
    });
    const id = child?.id ?? randomUUID();
    if (child) child.id = undefined;
    return {
      id,
      kit: child?.kit ?? base,
      ...(child && { child }),
      cwd,
      controller: new AbortController(),
      tools: [],
      ...(session && { session }),
      preview,
      phase: "start",
      history,
      inbox: [],
      ended,
      end,
    };
  };
  /** the top-level session of `session`'s tree: a child's caller's root, else `--parent`'s root, else its own id */
  const rootOf = (session?: Session) => (session && children.get(session)?.root) ?? lineage?.root ?? session?.id;
  const runInfo = async (run: RunState, t: Target, source: string, effort?: Effort): Promise<RunInfo> => ({
    id: run.id,
    depth: run.child?.depth ?? (lineage ? lineage.depth + 1 : 0),
    ...(run.child
      ? { parent: run.child.parent, ...(run.child.agent !== undefined && { agent: run.child.agent }) }
      : lineage && { parent: { session: lineage.session } }),
    ...(rootOf(run.session) !== undefined && { root: rootOf(run.session) }),
    provider: t.name,
    type: t.type,
    ...(t.endpoint !== undefined && { endpoint: t.endpoint }),
    model: t.model,
    ...(effort && { effort }),
    info: await modelInfo(t, t.model),
    source,
    cwd: run.cwd,
  });

  /**
   * Sets `run.info` from the provider and model `opts` (else the session's settings) resolve to; `known` is a target
   * already resolved for the same settings (`execRun`'s, before `input`), reused.
   */
  async function identify(run: RunState, opts: RunOptions, known?: { target: Target; key: string }) {
    const settings = run.session?.getState();
    const want = { model: opts.model ?? settings?.model, provider: opts.provider ?? settings?.provider };
    // an explicit `effort: undefined` (the host's "provider default") wins over the session's
    const effort = "effort" in opts ? opts.effort : settings?.effort;
    const key = JSON.stringify([want.model, want.provider, effort]);
    const target = known?.key === key ? known.target : await resolve(want, run.kit);
    run.info = await runInfo(run, target, opts.source ?? "user", effort);
    return { target, key, effort };
  }

  /**
   * `run_start` (re-resolving a changed provider or model) and `prompt`: what every request of a run shares.
   * Model, provider and effort come from `opts`, else the session's.
   */
  async function begin(
    scope: Scope,
    opts: RunOptions,
    source: "run" | "preview",
    known?: { target: Target; key: string },
  ) {
    const run = scope.run as RunState;
    const identified = await identify(run, opts, known);
    let { target } = identified;
    const { effort } = identified;
    const who = opts.source ?? "user";
    run.tools = [...run.kit.tools];
    sync(run);
    const start: Events["run_start"] = {
      source,
      tools: run.tools,
      context: [],
      messages: Object.freeze([...run.history]),
      model: target.model,
      provider: target.name,
      ...(effort && { effort }),
    };
    await emit(scope, "run_start", start);
    const names = new Set<string>();
    const only = run.child?.tools;
    run.tools = start.tools.filter((t) => {
      if (only && !only.includes(t.name)) return false;
      if (!names.has(t.name)) return names.add(t.name);
      onError(t.plugin ?? t.name, new Error(`run_start.tools has two tools named ${t.name}; the later one is dropped`));
      return false;
    });
    if (start.provider !== target.name || start.model !== target.model)
      target = await resolve({ provider: start.provider, model: start.model }, run.kit);
    run.info = await runInfo(run, target, who, start.effort);
    // what plugins added to `run_start` reaches `prompt` and the preview too
    const prompt: Events["prompt"] = {
      ...start,
      system: [],
      tools: Object.freeze([...run.tools]),
      context: Object.freeze(start.context),
    };
    await emit(scope, "prompt", prompt);
    return {
      target,
      prompt,
      fields: {
        model: target.model,
        system: run.child?.system ?? prompt.system.join("\n\n"),
        tools: declared(run.tools),
        ...(start.effort && { effort: start.effort }),
      },
    };
  }

  /**
   * `ctx.preview`: the request a run on `messages` would send first, without sending it; `run_end` still fires. Its
   * session (for settings and sends) is `opts.session`, else the current one.
   */
  async function preview(messages: Message[], opts: RunOptions = {}): Promise<Preview> {
    const session = opts.session ?? current;
    const scope: Scope = {
      run: newRun(session, true, [...messages], opts.cwd ?? session?.getState().cwd ?? process.cwd()),
      sub: { n: 0 },
      queue: newQueue(),
    };
    const run = scope.run as RunState;
    const end: RunEnd = { source: "preview", messages: run.history };
    try {
      const { target, fields, prompt } = await begin(scope, opts, "preview");
      run.phase = "loop";
      const { system: _, tools: __, ...seen } = prompt;
      return { ...seen, ...(await request(scope, "preview", target, { ...fields, messages: run.history })) };
    } catch (e) {
      end.error = e;
      throw e;
    } finally {
      run.phase = "end";
      await emit(scope, "run_end", end);
    }
  }

  /**
   * A run on `opts.session` (else the current session, else a new in-memory one), once the run before it on that
   * session has ended: `input` and the user message when there is `input`, then the loop. Undefined when an `input` handler took it; never rejects once started (a failure
   * is `error`). When it ends, the next send queued on the session starts, else `idle` fires.
   */
  async function execRun(input: string | UserInput | undefined, opts: RunOptions): Promise<RunEnd | undefined> {
    const session = opts.session ?? current ?? memorySession();
    if (shut(session)) throw new Error("The agent is closed: no run can start");
    session.replay(reducers);
    const lane = laneOf(session);
    const child = children.get(session);
    if (child) opts = { ...child.opts, ...opts };
    // woken after its end fired (or while its handlers run): it ends again once this run is done
    if (child && (child.ended || child.ending)) {
      child.ended = false;
      child.rearmed = true;
      childEnds.add(child.end);
    }
    const state = newRun(session, false, [], opts.cwd ?? session.getState().cwd ?? process.cwd(), child);
    if (child) child.run = state;
    const scope: Scope = { run: state, sub: { n: 0 }, queue: newQueue() };
    // one run per session at a time: this one waits for the one before (a second would see the first's calls in
    // flight as unanswered, and each the other's messages)
    lane.running++;
    const before = lane.tail;
    let turn!: () => void;
    lane.tail = new Promise((resolve) => {
      turn = resolve;
    });
    let ran = false;
    let idle = false;
    const done = (async () => {
      await before;
      lane.run = state;
      try {
        if (shut(session)) throw new Error("The agent is closed: no run can start");
        let msg: UserMessage | undefined;
        // so `input` handlers see `ctx.run`; a failure is the loop's to report
        const known = input !== undefined ? await identify(state, opts).catch(() => undefined) : undefined;
        if (input !== undefined) {
          const { images, meta, ...rest } = userMessage(input);
          const p: Events["input"] = {
            text: rest.content,
            ...(images && { images }),
            ...(meta && { meta }),
            source: opts.source ?? "user",
            handled: false,
          };
          await emit(scope, "input", p);
          if (p.handled) return undefined;
          msg = {
            ...rest,
            content: p.text,
            ...(p.images?.length ? { images: p.images } : {}),
            ...(p.meta && { meta: p.meta }),
          };
        }
        // the session keeps the working directory its first run had
        if (session.getState().cwd === undefined) await session.setCwd(state.cwd);
        if (msg) await add(scope, msg);
        ran = true;
        return await loop(scope, opts, known);
      } finally {
        if (lane.run === state) lane.run = undefined;
        state.phase = "end";
        // what missed its last boundary, or an `input` handler took it: what others sent while it started
        await leftover(state);
        // only now, so a send meanwhile queues behind it rather than starting a run itself
        lane.running--;
        turn();
        idle = !next(session, lane) && ran;
      }
    })();
    // after the run has settled, so an idle handler awaiting a run it starts doesn't wait on this one (its host's
    // `onWake` may start runs only once this one is done); still tracked, so `close` waits for it
    const tracked = done
      .catch(() => {})
      .then(async () => {
        if (idle && !closed && !lane.running && !lane.waking)
          await emit({ ...hostScope, session }, "idle", { session });
        await children.get(session)?.settle();
      })
      .catch(() => {});
    running.add(tracked);
    void tracked.then(() => running.delete(tracked));
    return done;
  }

  /** Sends that missed `run`'s last boundary: context is saved, the rest start runs after it. */
  async function leftover(run: RunState) {
    const session = run.session as Session;
    for (const p of run.inbox.splice(0)) {
      if (p.deliver === "context") await appendIdle(session, p.msg).catch(() => {});
      else laneOf(session).queue.push(p);
    }
  }

  /**
   * The tool loop on `scope`'s run until the model stops calling tools (or a `turn_end` handler stops it), saving each
   * message as it completes and delivering sends at turn boundaries. Resolves with `run_end`'s payload, also when it
   * failed (`error`) or was aborted.
   */
  async function loop(scope: Scope, opts: RunOptions, known?: { target: Target; key: string }): Promise<RunEnd> {
    const state = scope.run as RunState;
    const end: RunEnd = { source: "run", messages: state.history };
    const onAbort = () => stop(state, { by: "user" });
    opts.signal?.addEventListener("abort", onAbort);
    if (opts.signal?.aborted) onAbort();
    active.add(state);
    // one starting as `close` finished (a subrun its handlers left) missed its abort
    if (finished) stop(state, { by: "host", reason: "exit" });
    try {
      const { target, fields } = await begin(scope, opts, "run", known);
      state.phase = "loop";
      for (let index = 0; !state.controller.signal.aborted; index++) {
        await emit(scope, "turn_start", { index });
        const { assistant: reply, sent } = await call(
          scope,
          "run",
          target,
          // from the run's tools now: one a tool or handler pushed into `ctx.tools` mid-run is declared from then on
          { ...fields, tools: declared(allowed(state, state.tools)), messages: state.history },
          true,
        );
        // a call the provider ran itself is only shown: gated and reported (before its message, which keeps the
        // result its handlers left), not run or answered
        for (const c of reply.toolCalls)
          if (c.result) c.result = await finish(scope, await gate(scope, c, undefined, c.result), []);
        const assistant = (await add(scope, reply)) as AssistantMessage;
        const results = await runCalls(
          scope,
          assistant.toolCalls.filter((c) => !c.result),
          [...sent.tools],
        );
        if (results.length) await add(scope, { role: "tool", results });
        await drain(scope);
        // a tool's `ctx.stop()` ends the run here, unless a turn_end handler says otherwise
        const turn: Events["turn_end"] = {
          assistant,
          ...(results.length > 0 && { results }),
          stop: !results.length || !!state.stopped,
        };
        state.stopped = false;
        await emit(scope, "turn_end", turn);
        // the turn boundary: sends so far join the history, and a steer keeps the run going; unless the run was
        // stopped (aborted, or by a handler while tools still ran), when they are left for after it, as when idle
        if (!state.controller.signal.aborted && !(turn.stop && turn.results))
          for (const p of state.inbox.splice(0)) {
            await add(scope, p.msg);
            if (p.deliver === "steer") {
              turn.stop = false;
              void state.ended.then(p.resolve);
            }
          }
        if (turn.stop) break;
      }
    } catch (e) {
      if (!state.controller.signal.aborted) end.error = e;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      active.delete(state);
      state.phase = "end";
      await leftover(state);
      sync(state);
      if (state.aborted) end.aborted = state.aborted;
      if (state.child && state.usage) state.child.report(state.usage);
      await emit(scope, "run_end", end);
      state.end(end);
    }
    return end;
  }

  /** `ctx.subrun` from `scope` (by `who`); see `SubrunOptions`. */
  function subrun(scope: Scope, who: string, input: string | UserInput | Message[], o: SubrunOptions = {}): SubRun {
    const parent = scope.run;
    // while closing, only close's handlers start subruns: not the runs it aborted
    if (finished || (closed && parent?.controller.signal.aborted))
      throw new Error("The agent is closed: no run can start");
    const from = sessionOf(scope);
    let session: Session;
    if (o.session === undefined || o.session === "memory") session = memorySession();
    else if (o.session === "file") session = newSession(childDir(from?.id ?? "detached"));
    else session = o.session;
    // one run per session: a child on the caller's session (or any busy one) would wait for a run that waits for it;
    // and every run on a child's session is a child, so only a new session or a child's (resumed) is taken
    const childOf = from && session.path !== undefined && dirname(session.path) === childDir(from.id);
    if (
      session === from ||
      session === current ||
      laneOf(session).running ||
      !(children.has(session) || childOf || session.entries().length === 0)
    )
      throw new Error("A subrun needs a new session or a child's, with no run in progress");
    const settings = from?.getState();
    const caller = parent?.info;
    const provider = o.provider ?? caller?.provider ?? settings?.provider;
    const model = o.model ?? (o.provider ? undefined : (caller?.model ?? settings?.model));
    const effort = "effort" in o ? o.effort : caller ? caller.effort : settings?.effort;
    const { tally } = scope;
    // a child calls no tool its caller couldn't (a grandchild included)
    const inherited = (parent?.child ?? (from && children.get(from)))?.tools;
    const tools = inherited ? (o.tools ?? inherited).filter((n) => inherited.includes(n)) : o.tools;
    // a child is done once its caller's run has ended and it runs no more; detached or started outside a run, at exit
    let due = false;
    const child: Child = {
      end: () => {
        if (child.ending) return child.ending;
        if (!childEnds.has(child.end)) return Promise.resolve();
        child.rearmed = false;
        child.ending = emit({ ...hostScope, session }, "session_closed", { session, reason: "child" })
          .catch(() => {})
          .then(() => {
            child.ending = undefined;
            // woken meanwhile: still armed, and ends again once that run is done (now, if it already is)
            if (child.rearmed) return child.settle();
            childEnds.delete(child.end);
            child.ended = true;
          });
        return child.ending;
      },
      settle: () => {
        const lane = laneOf(session);
        return due && !lane.running && !lane.waking ? child.end() : Promise.resolve();
      },
      kit: childKit(kitOf(scope), o.plugins),
      depth: (caller?.depth ?? (lineage ? lineage.depth + 1 : 0)) + 1,
      ...(o.agent !== undefined && { agent: o.agent }),
      ...(rootOf(from) !== undefined && { root: rootOf(from) }),
      parent: {
        ...(from && { session: from.id }),
        ...(parent && { runId: parent.id }),
        ...(scope.callId && { toolCallId: scope.callId }),
      },
      ...(o.system !== undefined && { system: o.system }),
      ...(tools && { tools }),
      opts: {
        ...(provider !== undefined && { provider }),
        ...(model !== undefined && { model }),
        ...(effort !== undefined && { effort }),
      },
      id: randomUUID(),
      late: closed,
      report: (usage) => {
        if (tally?.open && !o.detached) tally.usage = addUsage(tally.usage, usage);
        else
          from
            ?.addUsage(usage)
            .catch((e) => onError(who, new Error(`Saving a subrun's usage failed: ${errorText(e)}`)));
      },
    };
    const id = child.id as string;
    // a resumed child is done anew: only its latest subrun's end fires
    const before = children.get(session);
    if (before) childEnds.delete(before.end);
    children.set(session, child);
    childEnds.add(child.end);
    if (parent && !o.detached)
      void parent.ended.then(() => {
        due = true;
        return child.settle();
      });
    const cwd = o.cwd ?? session.getState().cwd ?? bind(scope, who).cwd;
    const failed = (e: unknown) => onError(who, new Error(`Saving a subrun's session failed: ${errorText(e)}`));
    if (session.getState().cwd !== cwd) session.setCwd(cwd).catch(failed);
    const seed = [...(o.seed ?? []), ...(Array.isArray(input) ? input : [])];
    if (seed.length) session.append(seed).catch(failed);
    const done = execRun(Array.isArray(input) ? undefined : input, {
      session,
      source: o.source ?? who,
      ...(o.signal && { signal: o.signal }),
    });
    // aborting the caller aborts the child: its run now, or one woken while the caller runs. A `ctx.runTool` call's
    // own signal (a script runner's, aborted when the script ends) counts only while that call runs: a child outliving it
    // stays, until the run is aborted. A detached child ignores the caller's abort
    const outer = o.detached ? undefined : (scope.signal ?? parent?.controller.signal);
    const onOuter = () => {
      if (!child.run) return;
      if (scope.signal && parent && !parent.controller.signal.aborted && tally && !tally.open) return;
      stop(child.run, parent?.aborted ?? { by: "user" });
    };
    if (outer?.aborted) onOuter();
    outer?.addEventListener("abort", onOuter);
    void (parent?.ended ?? done).finally(() => outer?.removeEventListener("abort", onOuter)).catch(() => {});
    return {
      id,
      session,
      send: (msg, so = {}) => {
        if (shut(session)) throw new Error("The agent is closed: nothing can be sent");
        return deliver(session, undefined, userMessage(msg), so, who);
      },
      abort: (reason) => {
        if (child.run) stop(child.run, { by: who, ...(reason !== undefined && { reason }) });
      },
      done,
    };
  }

  /**
   * The plugins a child of a run on `from` has: `from`'s, filtered (`only` keeps the host's own `extra`, less their
   * tools; one filtered out keeps only its providers, so every provider and provider wrap stays), plus its `extra`,
   * merged anew (so dropping a tool wrapper peels its wrap; conflicts were reported at load); unfiltered, the tools as
   * loaded (never ones pushed since).
   */
  function childKit(from: Kit, f: SubrunOptions["plugins"]): Kit {
    if (!f) return from === base ? { ...base, tools: loadedTools } : from;
    const list = [
      ...from.plugins.flatMap((n): Named[] => {
        // a `required` one (a gate) stays whatever the filter says; one already filtered out stays so
        if (n.required || !takesPart(n)) return [n];
        if (f.disable && isNamed(n, f.disable)) return providersOnly(n);
        if (!f.only || isNamed(n, f.only)) return [n];
        if (!hostExtra.has(n.name)) return providersOnly(n);
        const { tools: _, ...plugin } = n.plugin;
        return [{ ...n, plugin }];
      }),
      ...(f.extra ?? []),
    ];
    return { plugins: list, ...mergePlugins(list, () => {}, wrapCtx) };
  }

  /** a provider wrap's ctx: its plugin's host ctx */
  const wrapCtx = (plugin: string) => bind(hostScope, plugin);
  const merged = mergePlugins(plugins, opts.onError, wrapCtx);
  /** what threw already, reported once: `commands()` runs on every render of a host's prompt */
  const reported = new Set<string>();
  /** `fn()`, or undefined when it throws (skipped, reported to `onError` once per plugin and `what`) */
  const guarded = <T>(plugin: string, what: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      if (reported.has(`${plugin}\0${what}`)) return;
      reported.add(`${plugin}\0${what}`);
      onError(plugin, new Error(`Plugin ${plugin}'s ${what} failed: ${errorText(e)}`, { cause: e }));
    }
  };
  base = { plugins, ...merged };
  allTools = merged.tools;
  loadedTools = [...allTools];

  await emit(hostScope, "init", {});
  await emit(hostScope, "ready", {});
  return {
    providers: base.providers,
    plugins,
    /** the host ctx: no `run`, valid for the agent's life; for the host's own requests and plugins' commands */
    ctx: bind(hostScope, "host"),
    resolve: (o?: Pick<RunOptions, "model" | "provider">) => resolve(o),
    listModels,
    /**
     * Runs on `opts.session` (else the current session, else a new in-memory one; after the run already on it ends),
     * starting with `input` as a user message when given (through `input`; undefined if a handler took it). Resolves
     * with `run_end`'s payload, also when aborted; rejects with the error if it failed.
     */
    run: async (input?: string | UserInput, opts: RunOptions = {}) => {
      const end = await execRun(input, opts);
      if (end?.error !== undefined) throw end.error;
      return end;
    },
    /** the host ctx bound to `plugin` (its `send`s' source, its `abort`'s `by`), e.g. for a host's plugin hooks */
    ctxOf: (plugin: string) => bind(hostScope, plugin),
    /**
     * every plugin's enabled commands, one per name (a later plugin's replaces an earlier one's), bound to its host ctx
     */
    commands: (): AgentCommand[] => [
      ...new Map(
        plugins.flatMap(({ name, plugin }) =>
          (
            guarded(name, "commands", () =>
              typeof plugin.commands === "function" ? plugin.commands(bind(hostScope, name)) : plugin.commands,
            ) ?? []
          ).flatMap((c): [string, AgentCommand][] => {
            const { run, complete, enabled, ...rest } = c;
            const on = () =>
              guarded(name, `/${c.name} enabled()`, () => enabled?.call(c, bind(hostScope, name)) !== false) ?? false;
            if (!on()) return [];
            return [
              [
                c.name,
                {
                  ...rest,
                  plugin: name,
                  run: async (arg) => {
                    if (!on()) throw new Error(`/${c.name} is turned off`);
                    return (await run.call(c, arg, bind(hostScope, name))) || undefined;
                  },
                  ...(complete && { complete: async () => complete.call(c, bind(hostScope, name)) }),
                },
              ],
            ];
          }),
        ),
      ).values(),
    ],
    /** the current session: what runs and the host ctx use by default */
    session: () => current,
    setSession,
    close,
  };
}

export type Agent = Awaited<ReturnType<typeof createAgent>>;

/** The tools a request declares: only "direct" ones; the others are callable (`ctx.runTool`) only. */
const declared = (tools: Tool[]) => tools.filter((t) => (t.exposure ?? "direct") === "direct");

/** The tokens `m` spent: a reply's own, and its (or a tool message's) results' (their subruns'). */
function usageOf(m: Message): Usage | undefined {
  const results =
    m.role === "tool" ? m.results : m.role === "assistant" ? m.toolCalls.flatMap((c) => c.result ?? []) : [];
  return results.reduce((u, r) => addUsage(u, r.usage), m.role === "assistant" ? m.usage : undefined);
}

/** `v` frozen, and everything in it. */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

const omitDetails = ({ details: _, durationMs: __, ...r }: ToolResult): ToolResult => r;
/** `m` without its tool results' `details` and `durationMs`, never sent (the provider-executed calls' ones too). */
function withoutDetails(m: Message): Message {
  if (m.role === "tool") return { ...m, results: m.results.map(omitDetails) };
  if (m.role === "assistant" && m.toolCalls.some((c) => c.result))
    return { ...m, toolCalls: m.toolCalls.map((c) => (c.result ? { ...c, result: omitDetails(c.result) } : c)) };
  return m;
}

/**
 * `messages` with every call the model left to us answered: one no tool message after its assistant message answers
 * (a run cut off mid-tool: crash, kill) gets an `Interrupted` error result there, as providers reject unanswered calls;
 * results answering no call of the message before (a plugin's rewrite of the history cut it away) are left out, as
 * providers reject those too; consecutive tool messages after one assistant message merge into one. Only for the request: the session keeps them as they are.
 */
function answered(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Message;
    if (m.role === "tool") continue; // answers no assistant message right before it
    out.push(m);
    if (m.role !== "assistant") continue;
    let next: Message | undefined;
    const results: ToolResult[] = [];
    for (let n = messages[i + 1]; n?.role === "tool"; n = messages[++i + 1]) {
      next ??= n;
      results.push(...n.results.filter((r) => m.toolCalls.some((c) => c.id === r.id && !c.result)));
    }
    const open = m.toolCalls.filter((c) => !c.result && !results.some((r) => r.id === c.id));
    results.push(...open.map((c) => ({ id: c.id, output: "Interrupted", isError: true })));
    if (results.length) out.push({ ...next, role: "tool", results });
  }
  return out;
}
