import {
  type Agent,
  type AgentCommand,
  type AskEvent,
  type Ctx,
  EFFORTS,
  type Effort,
  type Host,
  type LoadOptions,
  listSkills,
  loadConfig,
  type Message,
  parseSkillMessage,
  type RunEnd,
  type RunOptions,
  type Session,
  type SessionEntry,
  saveConfig,
  type ToolCall,
  type UserMessage,
} from "@hortus/core";
import type { Key } from "ink";
import { createStore } from "zustand/vanilla";
import type { CliPlugin } from "./api.ts";
import { findCommand, parseCommand, skillCommand } from "./commands.ts";
import { type Entry, entry, type TextEntry, type ToolEntry, toolEntry, withSiblings } from "./entry.ts";
import { applyTheme, dark, type Theme } from "./themes.ts";

/** What the TUI shows; written only by `createCli`, read through `useUi`. */
export interface UiState {
  /** the session shown and run on (the agent's current one); swapped by `setSession` (e.g. /new) */
  session: Session;
  entries: Entry[];
  /**
   * streamed thinking and text not yet turned into entries; `startedAt` / `endedAt`: the thinking's first delta, and the
   * first text or tool call after it (epoch ms)
   */
  live: { thinking: string; text: string; startedAt?: number; endedAt?: number };
  busy: boolean;
  /** effort of the next run: the session's, else config.json's; undefined = the provider's default */
  effort?: Effort;
  /** provider name and model the next run would use, plus its context window and efforts when the API reports them */
  status?: { name: string; model: string; window?: number; efforts?: Effort[] };
  /** chars of the last copy, shown until the next submit */
  copied?: number;
  /** the prompt's text (`cli.setInput`) */
  input: string;
  /** the prompt's caret, a code-point index into `input`; undefined = at its end */
  caret?: number;
  /**
   * the shown session's status entries by key, from `status` events (`ctx.status` on that session, or on none: the
   * host's), the shown session's winning; the built-in status bar draws them
   */
  statuses: Record<string, Status>;
  /** pending asks the TUI shows, one at a time (the first), in the prompt slot */
  asks: AskEvent[];
  /** whether tool blocks show everything (Ctrl+O) */
  expanded: boolean;
  /** the current theme's name */
  theme: string;
  /** set by `ctx.exit()`: the TUI exits */
  exiting: boolean;
}

/** A status entry (`ctx.status`): its text, and the theme token it's drawn in (default `dim`). */
export interface Status {
  text: string;
  color?: string;
}

/** Whether the shown model takes `effort`; true while unknown (still loading, or not reported by the API). */
export const supports = (s: UiState, effort: Effort) => s.status?.efforts?.includes(effort) ?? true;

/** The effort runs use: the one set, unless the model doesn't take it (kept from another model) and would reject it. */
export const runEffort = (s: UiState) => (s.effort && supports(s, s.effort) ? s.effort : undefined);

/**
 * A user message's transcript entry; a skill's instructions (see `expandSkill`) show as just its name. A plugin's
 * message (`meta`) is an entry of kind `<plugin>:<type>`, shown when its `display` is true (drawn by the built-in
 * plugin-message look unless a plugin renders it), or when `shown(kind)` (a plugin renders it) and it isn't false.
 */
function userEntry(m: UserMessage, shown: (kind: string) => boolean) {
  const { content: text, meta } = m;
  const saved = { message: m, ...(m.entryId && { entryId: m.entryId }) };
  if (meta) {
    const kind = `${meta.plugin}:${meta.type}` as const;
    return meta.display === true || (meta.display !== false && shown(kind))
      ? entry(kind, text, meta, saved)
      : undefined;
  }
  const skill = parseSkillMessage(text);
  // blank rows pad the message's background, as pi does
  return entry(
    "user",
    `\n${skill ? `[skill] ${skill.name}${skill.request ? `\n\n${skill.request}` : ""}` : text}\n`,
    undefined,
    saved,
  );
}

/** A session plugin entry's transcript entry (kind: its type), when a plugin renders that kind. */
const pluginEntry = (e: SessionEntry, shown: (kind: string) => boolean) =>
  e.type.includes(":") && shown(e.type)
    ? entry(e.type as `${string}:${string}`, "", undefined, { entryId: e.id, data: (e as { data: unknown }).data })
    : undefined;

/**
 * Transcript entries for messages already in the session, so a resumed one shows as it was left. Plugin messages
 * (`meta`) show when `display` is true, else only when `shown(<plugin>:<type>)`: when a plugin renders that kind. Plugin
 * entries of `branch` (the session's `entries()`) that a plugin renders show after the message written before them (or
 * the entry a shown message comes from, a compaction's summary)
 * (those before every message shown come first; those after a message no longer shown, e.g. compacted, don't show).
 */
export function replay(
  messages: Message[],
  shown: (kind: string) => boolean = () => false,
  branch: SessionEntry[] = [],
): Entry[] {
  // rendered plugin entries by the message entry written before them ("" = none)
  const after = new Map<string, Entry[]>();
  // a shown message's entry need not be a "message" one: a compaction's summary has the compaction entry's id. Past
  // one, entries go after the latest shown message written so far: the kept messages' last, else the summary
  const index = new Map(messages.map((m, i) => [m.entryId, i]));
  let latest = -1;
  let last = "";
  for (const e of branch) {
    const i = index.get(e.id);
    if (i !== undefined) latest = Math.max(latest, i);
    if (e.type === "message") last = e.id;
    else if (i !== undefined) last = messages[latest]?.entryId ?? e.id;
    const p = pluginEntry(e, shown);
    if (p) after.set(last, [...(after.get(last) ?? []), p]);
  }
  const out: Entry[] = [...(after.get("") ?? [])];
  const batches = new Map<string, ToolCall[]>();
  const calls = new Map<string, ToolCall>();
  for (const m of messages) {
    if (m.role === "user") {
      const e = userEntry(m, shown);
      if (e) out.push(e);
    } else if (m.role === "assistant") {
      if (m.text)
        out.push(entry("assistant", m.text, undefined, { message: m, ...(m.entryId && { entryId: m.entryId }) }));
      for (const c of m.toolCalls) {
        calls.set(c.id, c);
        batches.set(c.id, m.toolCalls);
        // one the provider ran itself has its result already, and no tool message answers it
        if (c.result) out.push(toolEntry(c, c.result));
      }
    } else
      for (const r of m.results) {
        const c = calls.get(r.id);
        if (c) out.push(toolEntry(c, r));
      }
    if (m.entryId) out.push(...(after.get(m.entryId) ?? []));
  }
  return withSiblings(out, batches);
}

/** UI state for showing `session` from its start: its file and settings, then its messages so far. */
function show(session: Session, defaultEffort: Effort | undefined, shown?: (kind: string) => boolean) {
  const { messages, model, provider, effort = defaultEffort } = session.getState();
  return {
    session,
    entries: [
      entry(
        "info",
        `Session: ${session.path} (${messages.length} messages)${provider ? ` · provider: ${provider}` : ""}${model ? ` · model: ${model}` : ""}`,
      ),
      ...replay(messages, shown, session.entries()),
    ],
    live: { thinking: "", text: "" },
    effort,
    copied: undefined,
  };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The terminal around the TUI, as `cli.suspend` hands it over; the App registers Ink's. */
export interface Terminal {
  /** Ink's `suspendTerminal`: leaves the alternate screen and raw mode while `fn` runs, then redraws */
  suspend(fn: () => Promise<void>): Promise<void>;
  write(data: string): void;
}

/** OSC 52: asks the terminal to put `text` on the system clipboard. */
export const osc52 = (text: string) => `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;

/** SGR mouse reporting: button presses, drags and wheel (1002) in SGR encoding (1006) */
export const MOUSE_ON = "\x1b[?1002h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1002l\x1b[?1006l";

/**
 * The TUI's logic, without React: makes `session` the agent's current one, runs the agent on it or a `/name arg`
 * command, turns its events into transcript entries and keeps `status` in step with the session's model and provider.
 * `makeAgent` creates the agent with the options it's given: the run observer in `extra`, an `onError` showing load
 * conflicts as error lines, an `onWake` queueing the runs plugins start like submits, `host` (`tui`, with this `cli`)
 * and `onExit`.
 */
export async function createCli(session: Session, makeAgent: (opts: LoadOptions) => Promise<Agent>) {
  // config.json's effort: a session's own (set on its branch) wins
  let defaultEffort: Effort | undefined;
  // plugin messages of these kinds have a renderer, so they show (set once the plugins have loaded)
  let rendered = new Set<string>();
  const shown = (kind: string) => rendered.has(kind);
  // the shown session's last entry the transcript has (its plugin entries after it are added as they come)
  let seen: string | null = null;
  const ui = createStore<UiState>()(() => ({
    ...show(session, undefined),
    // the session's own entries come once the plugins have loaded (their renderers decide which messages show)
    entries: [],
    busy: false,
    input: "",
    statuses: {},
    asks: [],
    expanded: false,
    theme: "dark",
    exiting: false,
  }));
  const push = (...e: Entry[]) => ui.setState((s) => ({ entries: [...s.entries, ...e] }));
  // Deltas reach the store at most once a frame: every store change renders synchronously (useSyncExternalStore), and
  // a fast stream of back-to-back sync renders trips React's nested-update limit while Ink's useBoxMetrics has updates
  // pending.
  interface Pending {
    thinking: string;
    text: string;
    /** streamed tool input by call id, in order */
    inputs: Map<string, { name: string; partial: string }>;
  }
  const none = (): Pending => ({ thinking: "", text: "", inputs: new Map() });
  let pending = none();
  let timer: NodeJS.Timeout | undefined;
  const take = () => {
    clearTimeout(timer);
    timer = undefined;
    const p = pending;
    pending = none();
    return p;
  };
  // the streamed thinking's start and end (see `UiState.live`)
  let thought: { startedAt?: number; endedAt?: number } = {};
  const thinkingEnds = () => {
    if (thought.startedAt !== undefined) thought.endedAt ??= Date.now();
  };
  /** `p` applied: text to `live` (or, `final`, into entries); a call's first streamed input closes the text before it */
  const apply = (p: Pending, final: boolean) =>
    ui.setState(({ entries, live }) => {
      let out = entries;
      let thinking = live.thinking + p.thinking;
      let text = live.text + p.text;
      const close = () => {
        if (thinking) thinkingEnds();
        out = [
          ...out,
          ...(thinking ? [entry("thinking", thinking, undefined, thought)] : []),
          ...(text ? [entry("assistant", text)] : []),
        ];
        thinking = "";
        text = "";
        thought = {};
      };
      for (const [id, { name, partial }] of p.inputs) {
        const i = out.findIndex((e) => e.kind === "tool" && !e.result && e.call.id === id);
        const at = out[i] as ToolEntry | undefined;
        if (at) out = out.map((e) => (e === at ? { ...at, partial: (at.partial ?? "") + partial } : e));
        else {
          close();
          out = [...out, { ...toolEntry({ id, name, input: undefined }), partial }];
        }
      }
      if (final) close();
      return { entries: out, live: { thinking, text, ...(thinking ? thought : {}) } };
    });
  const schedule = () => {
    timer ??= setTimeout(() => apply(take(), false), 1000 / 30);
  };
  const stream = (key: "thinking" | "text", delta: string) => {
    if (key === "thinking") thought.startedAt ??= Date.now();
    else thinkingEnds();
    pending[key] += delta;
    schedule();
  };
  // streamed-but-unfinished thinking and text become entries, then the live view resets
  const flush = () => apply(take(), true);

  type Start = (opts: RunOptions) => Promise<RunEnd | undefined>;
  // runs plugins asked for (`onWake`) while one was running, started one after another
  const waiting: Start[] = [];
  let aborter: AbortController | undefined;

  // each call's assistant message's calls, for its block's `siblings`
  const batches = new Map<string, ToolCall[]>();
  // a running call's block (one without a result yet), replaced by `f(block)`; its message's blocks learn of it
  const updateTool = (id: string, f: (e: ToolEntry) => ToolEntry) =>
    ui.setState((s) => ({
      entries: withSiblings(
        s.entries.map((e) => (e.kind === "tool" && !e.result && e.call.id === id ? f(e) : e)),
        batches,
        new Set([id]),
      ),
    }));
  // set as createCli returns: asks show from then on
  let started = false;
  // the ctx each shown ask came with, to announce it (`attention`) once it's the one on screen
  const askCtx = new WeakMap<AskEvent, Ctx>();
  const attention = (ask: AskEvent | undefined) => {
    if (!ask) return;
    ask.show();
    void askCtx.get(ask)?.emit("attention", { reason: "ask" });
  };
  // status entries by session id ("" = none)
  const statusBy = new Map<string, Record<string, Status>>();
  const statusesOf = (s: Session) => ({ ...statusBy.get(""), ...statusBy.get(s.id) });
  // only the shown session's top-level events reach the transcript (runs on others, e.g. an embedder's, and subruns
  // (depth > 0) don't: a plugin renders those itself)
  const isShown = (ctx: Ctx) => ctx.session === ui.getState().session && !ctx.run?.depth;
  const observer: CliPlugin = {
    on: {
      // a run's request starts its reply over: after a `response.retry`, the failed attempt's deltas are dropped
      request: ({ source }, ctx) => {
        if (source !== "run" || !isShown(ctx)) return;
        take();
        thought = {};
        ui.setState({ live: { thinking: "", text: "" } });
      },
      thinking: (delta, ctx) => {
        if (isShown(ctx)) stream("thinking", delta);
      },
      text: (delta, ctx) => {
        if (isShown(ctx)) stream("text", delta);
      },
      tool_input: ({ id, name, partial }, ctx) => {
        if (!isShown(ctx)) return;
        thinkingEnds();
        const p = pending.inputs.get(id) ?? { name, partial: "" };
        p.partial += partial;
        pending.inputs.set(id, p);
        schedule();
      },
      // calls a tool makes through ctx.runTool (`parentId`) are part of its block, not blocks of their own
      tool_call: ({ call }, ctx) => {
        if (call.parentId || !isShown(ctx)) return;
        // a call the provider ran itself comes before its message: the text streamed before it goes first
        flush();
        // one whose input streamed has its block already
        const streamed = ui.getState().entries.some((e) => e.kind === "tool" && !e.result && e.call.id === call.id);
        if (!streamed) push(toolEntry(call));
        updateTool(call.id, ({ partial: _, ...e }) => ({ ...e, call }));
      },
      tool_update: ({ call, details }, ctx) => {
        if (isShown(ctx)) updateTool(call.id, (e) => ({ ...e, details }));
      },
      tool_result: ({ call, result }, ctx) => {
        if (!call.parentId && isShown(ctx)) updateTool(call.id, (e) => ({ ...e, result, details: result.details }));
      },
      message: (message, ctx) => {
        if (!isShown(ctx)) return;
        // an assistant message closes the streamed thinking and text
        flush();
        if (message.role === "assistant") {
          const all = message.toolCalls;
          for (const c of all) batches.set(c.id, all);
          const saved = { message, ...(message.entryId && { entryId: message.entryId }) };
          ui.setState((s) => {
            // the text just streamed is this message's
            const text = [...s.entries].reverse().find((e) => e.kind === "assistant");
            const entries =
              message.text && text?.kind === "assistant" && !text.message && text.text === message.text
                ? s.entries.map((e) => (e === text ? { ...text, ...saved } : e))
                : s.entries;
            // blocks pushed before it (streamed input, provider-run calls) learn their siblings now
            return { entries: withSiblings(entries, batches, new Set(all.map((c) => c.id))) };
          });
        }
        // the user's own, and plugins' sends, as they join the session (assistant text was streamed already)
        if (message.role === "user") {
          const e = userEntry(message, shown);
          if (e) push(e);
        }
      },
      notify: ({ text, level }) => push(entry(level, text)),
      // kept per session (none: a host ctx's, host-wide), so a subrun's or another session's never shows on the shown one
      status: ({ key, text, color, session }) => {
        const id = session ?? "";
        const { [key]: _, ...rest } = statusBy.get(id) ?? {};
        statusBy.set(id, text === undefined ? rest : { ...rest, [key]: { text, ...(color && { color }) } });
        ui.setState((s) => ({ statuses: statusesOf(s.session) }));
      },
      // one dialog at a time; an ask an earlier handler answered at once (a policy) never shows
      // until createCli returns (plugins' init, the first session_open), there's no App to show it: not held, so a
      // startup ask fails closed unless another handler answers
      ask: (p, ctx) => {
        if (p.signal.aborted || !started) return;
        askCtx.set(p, ctx);
        ui.setState((s) => ({ asks: [...s.asks, p] }));
        if (ui.getState().asks[0] === p) attention(p);
        // shown (`show()`) when it comes on screen; the shown one's first key engages it (the dialogs call `engage()`)
        // pending until anyone answers (the dialog, or another handler), so the ask waits for the dialog
        return new Promise<void>((resolve) =>
          p.signal.addEventListener(
            "abort",
            () => {
              const was = ui.getState().asks[0];
              ui.setState((s) => ({ asks: s.asks.filter((a) => a !== p) }));
              const next = ui.getState().asks[0];
              if (next !== was) attention(next);
              resolve();
            },
            { once: true },
          ),
        );
      },
    },
  };
  // `cli` once it's built, for commands' `cliOf(ctx)`; not interactive until createCli returns (no App shows asks yet)
  const host: Host & { cli?: Cli } = { kind: "tui", interactive: false, ui: true };
  const agent = await makeAgent({
    extra: [{ name: "@hortus/cli", plugin: observer }],
    onError: (_, e) => push(entry("error", e.message)),
    // a run on a session not shown (an embedder's) is none of the prompt's business: started at once, with its own effort
    onWake: (start, s) => {
      if (s !== ui.getState().session)
        void start().catch((e) => push(entry("error", `A run failed to start: ${errorText(e)}`)));
      else if (ui.getState().busy) waiting.push(start);
      else void run(start);
    },
    host,
    onExit: () => ui.setState({ exiting: true }),
  });
  const cliPlugins = agent.plugins.map((p) => ({ name: p.name, cli: (p.plugin as CliPlugin).cli }));
  rendered = new Set(
    cliPlugins.flatMap(({ cli }) => Object.keys(cli?.entries ?? {}).filter((k) => !k.startsWith("tool:"))),
  );
  // themes by name; later plugins win
  const themes: Record<string, Partial<Theme>> = Object.assign({}, ...cliPlugins.map(({ cli }) => cli?.themes ?? {}));
  const setTheme = (name: string) => {
    const t = Object.hasOwn(themes, name) ? themes[name] : name === "dark" ? dark : undefined;
    if (!t) throw new Error(`Unknown theme: ${name} (${Object.keys(themes).join(", ") || "none registered"})`);
    applyTheme(t);
    ui.setState({ theme: name });
  };

  // before the first frame, so it starts in the configured theme
  const { effort, theme } = await loadConfig().catch(() => ({ effort: undefined, theme: undefined }));
  defaultEffort = effort;
  ui.setState((s) => ({ effort: s.session.getState().effort ?? effort }));
  if (theme) {
    try {
      setTheme(theme);
    } catch (e) {
      push(entry("error", errorText(e)));
    }
  }
  await agent.setSession(session);
  // the session's messages (replayed with the plugins' reducers by now), before what loading and opening reported
  seen = session.leafId;
  ui.setState((s) => ({ entries: [...show(session, undefined, shown).entries, ...s.entries] }));

  // every plugin's commands (core's merge: later plugins win by name), listed anew at every read (plugins add, remove
  // and turn off commands at any time); skills are listed again whenever a prompt has been handled, and come last, so
  // their `/<name>` aliases lose to every command's
  let skills: AgentCommand[] = [];
  const refreshSkills = async () => {
    skills = (await listSkills(agent.ctx)).map((s) => skillCommand(s, cli));
  };

  // re-resolved whenever the session, or its model or provider, changes
  let seq = 0;
  async function refreshStatus() {
    const n = ++seq;
    const { model, provider } = ui.getState().session.getState();
    try {
      const r = await agent.resolve({ model, provider });
      // a newer change won; don't overwrite it with a stale result
      if (n !== seq) return;
      ui.setState({ status: { name: r.name, model: r.model } });
      const info = await r.provider.info?.(r.model).catch(() => undefined);
      if (n === seq)
        ui.setState({ status: { name: r.name, model: r.model, window: info?.contextWindow, efforts: info?.efforts } });
    } catch {
      if (n === seq) ui.setState({ status: undefined });
    }
  }
  const watch = (session: Session) =>
    session.subscribe((s, prev) => {
      if (s.model !== prev.model || s.provider !== prev.provider) void refreshStatus();
      // set outside the CLI too (a plugin's `ctx.session.setEffort`)
      if (s.effort !== prev.effort) ui.setState({ effort: s.effort ?? defaultEffort });
      // plugin entries appended since, that a plugin renders; ponytail: `entries()` copies the branch on every new entry
      // (O(n) each), a session event for appended entries if long sessions make it show
      if (session.leafId === seen) return;
      const branch = session.entries();
      const at = seen === null ? -1 : branch.findIndex((e) => e.id === seen);
      const known = seen === null || at >= 0;
      seen = session.leafId;
      if (!known) return;
      const added = branch.slice(at + 1).flatMap((e) => pluginEntry(e, shown) ?? []);
      if (added.length) push(...added);
    });
  let unwatch = watch(session);
  ui.subscribe((s, prev) => {
    if (s.session === prev.session) return;
    unwatch();
    unwatch = watch(s.session);
    void refreshStatus();
  });
  void refreshStatus();

  // plugins' `cli.keys`, later plugins first; the first to return true takes the key
  const ctxOf = (name: string) => agent.ctxOf?.(name) ?? agent.ctx;
  const keyHooks = cliPlugins
    .flatMap(({ name, cli: c }) => (c?.keys ? [{ name, keys: c.keys, ctx: ctxOf(name) }] : []))
    .reverse();
  const keys = (input: string, key: Key): boolean =>
    keyHooks.some(({ name, keys, ctx }) => {
      try {
        return keys(input, key, cli, ctx) === true;
      } catch (e) {
        push(entry("error", `Plugin ${name}'s keys failed: ${errorText(e)}`));
        return false;
      }
    });

  /** One run on the current session: core saves each message as it completes; this shows how it ended. */
  async function run(start: Start) {
    ui.setState({ busy: true });
    const abort = new AbortController();
    aborter = abort;
    try {
      const end = await start({ effort: runEffort(ui.getState()), signal: abort.signal });
      if (end?.error !== undefined) throw end.error;
      if (end?.aborted) {
        // the partial reply stays on screen but not in history; completed messages are kept
        flush();
        // error entries get no separator row, so the leading newline adds one; the next turn adds the one below
        push(entry("error", "\nInterrupted"));
      }
    } catch (e) {
      flush();
      push(entry("error", errorText(e)));
    }
    ui.setState({ busy: false });
    const next = waiting.shift();
    if (next) await run(next);
  }

  // runs beside a turn; returned text is an info line, a throw an error line
  async function command(c: AgentCommand, arg: string) {
    try {
      const text = await c.run(arg);
      if (text) push(entry("info", text));
    } catch (e) {
      push(entry("error", errorText(e)));
    }
  }

  // the session's effort changes at once (its writes keep their order); config saves run one after another, so the
  // last value set is the one left in config.json (the next sessions' default)
  let saving = Promise.resolve();
  const save = (patch: object, what: string) => {
    saving = saving
      .then(async () => saveConfig({ ...(await loadConfig()), ...patch }))
      .catch((e) => push(entry("error", `Couldn't save ${what}: ${errorText(e)}`)));
  };
  const setEffort = (effort: Effort | undefined) => {
    ui.setState({ effort });
    defaultEffort = effort;
    ui.getState()
      .session.setEffort(effort)
      .catch((e) => push(entry("error", `Couldn't save effort: ${errorText(e)}`)));
    save({ effort }, "effort");
  };

  // set by the App: Ink's terminal, for `suspend`; and the transcript's scroller
  let terminal: Terminal | undefined;
  let scroller: ((to: number | "top" | "bottom") => void) | undefined;

  const cli = {
    ui,
    agent,
    /** the session shown, `ui`'s `session` */
    get session() {
      return ui.getState().session;
    },
    /**
     * every plugin's enabled commands (`agent.commands()`, the `cli:*` pieces first, listed anew at each read), then one
     * per skill (see `skillCommand`)
     */
    get commands(): AgentCommand[] {
      return [...(agent.commands?.() ?? []), ...skills];
    },
    /** themes by name (every plugin's `cli.themes`) */
    themes,
    /**
     * starts `value` as a command or the next turn, and clears the prompt; false (the prompt keeps its input) when
     * blank, an unknown command, or a turn while one runs (commands run beside it). Plugins' `cli.submit` wrap it.
     */
    submit: (value: string): boolean => submit(value),
    /** the built-in submit, under the plugins' wrappers */
    submitDefault: (value: string) => {
      if (!value.trim()) return false;
      const cmd = parseCommand(value.trim());
      const c = cmd && findCommand(cli.commands, cmd.name);
      if (cmd && !c) {
        push(entry("error", `Unknown command: /${cmd.name}`));
        return false;
      }
      if (!c && ui.getState().busy) return false;
      ui.setState({ copied: undefined, input: "", caret: undefined });
      (c ? command(c, cmd?.arg ?? "") : run((o) => agent.run(value, o)))
        .then(refreshSkills)
        .catch((e) => push(entry("error", errorText(e))));
      return true;
    },
    /** replaces the prompt's text, the caret at `caret` (a code-point index; default the end) */
    setInput: (input: string, opts: { caret?: number } = {}) => ui.setState({ input, caret: opts.caret }),
    /** whether a plugin's `cli.keys` took the key (the built-in prompt asks before handling it) */
    keys,
    /** puts `text` on the system clipboard (OSC 52) and shows how much was copied */
    copy: (text: string) => {
      terminal?.write(osc52(text));
      ui.setState({ copied: text.length });
    },
    abort: () => aborter?.abort(),
    /**
     * scrolls the built-in transcript: by `rows` (negative: up), or to its "top" or "bottom" (which follows new output
     * again)
     */
    scroll: (to: number | "top" | "bottom") => scroller?.(to),
    /** called by the built-in transcript with its scroller */
    attachScroll: (fn: ((to: number | "top" | "bottom") => void) | undefined) => {
      scroller = fn;
    },
    /**
     * exit: `agent.close` (aborts the running turn, whose completed messages are saved already, then `session_close` and
     * `close` (builtin:mcp stops its servers there), within its timeout); the caller should then exit the process, as a tool may ignore
     * its `ctx.signal`; also waits for config.json saves (`/theme`, `/effort`, `/model`) still queued
     */
    close: async () => {
      await agent.close();
      await saving;
    },
    /** sets the effort of the next runs (undefined = provider default) and saves it to config.json */
    setEffort,
    /** sets the shown session's model and saves it to config.json (the next sessions' default) */
    setModel: async (model: string, provider: string) => {
      save({ provider, model }, "model");
      await ui.getState().session.setModel(model, provider);
    },
    /** next effort the model takes after the set one: default, then EFFORTS in order, then default again */
    cycleEffort: () => {
      const s = ui.getState();
      const all = [undefined, ...EFFORTS];
      const at = all.indexOf(s.effort);
      for (let i = 1; i <= all.length; i++) {
        const next = all[(at + i) % all.length];
        if (!next || supports(s, next)) return setEffort(next);
      }
    },
    /** switches to the theme `name` (of `themes`) at once and saves it to config.json; throws for an unknown one */
    setTheme: (name: string) => {
      setTheme(name);
      save({ theme: name }, "theme");
    },
    /** flips whether tool blocks show everything */
    toggleExpanded: () => ui.setState((s) => ({ expanded: !s.expanded })),
    /** adds an error entry to the transcript */
    report: (text: string) => push(entry("error", text)),
    /** adds a UI-only entry (not saved): a kind with a renderer (`cli.entries`), or a text kind such as "info" */
    push: (e: Pick<TextEntry, "kind" | "text" | "meta" | "data">) =>
      push(entry(e.kind, e.text, e.meta, e.data === undefined ? undefined : { data: e.data })),
    /**
     * Runs `fn` with the terminal handed back (alternate screen left, raw mode and mouse reporting off), e.g. for an
     * editor or a pager as a child process; then takes it back and redraws, also when `fn` throws.
     */
    suspend: async <T>(fn: () => T | Promise<T>): Promise<T> => {
      if (!terminal) return fn();
      const t = terminal;
      let out: T | undefined;
      await t.suspend(async () => {
        t.write(MOUSE_OFF);
        try {
          out = await fn();
        } finally {
          t.write(MOUSE_ON);
        }
      });
      return out as T;
    },
    /** called by the App with Ink's terminal */
    attach: (t: Terminal | undefined) => {
      terminal = t;
    },
    /**
     * makes `session` the current one (`agent.setSession`, firing `session_close`/`session_open` with `reason`) and shows
     * it: the transcript restarts from its messages, and runs go to it. False when a `session_close` handler cancelled.
     */
    setSession: async (session: Session, reason: "new" | "resume" = "new") => {
      // the running turn would end up split between the two
      if (ui.getState().busy) throw new Error("Can't switch sessions while a turn is running");
      if (!(await agent.setSession(session, reason))) return false;
      seen = session.leafId;
      ui.setState({ ...show(session, defaultEffort, shown), statuses: statusesOf(session) });
      return true;
    },
  };
  host.cli = cli;
  // plugins' `cli.submit`, in load order (later plugins outermost)
  let submit: (value: string) => boolean = cli.submitDefault;
  for (const { name, cli: c } of cliPlugins) {
    const wrap = c?.submit;
    if (!wrap) continue;
    const Default = submit;
    const ctx = ctxOf(name);
    submit = (value) => wrap(value, Default, cli, ctx);
  }
  void refreshSkills().catch((e) => push(entry("error", `Listing skills failed: ${errorText(e)}`)));
  for (const { name, cli: c } of cliPlugins)
    if (c?.init)
      try {
        await c.init(cli, ctxOf(name));
      } catch (e) {
        push(entry("error", `Plugin ${name}'s init failed: ${errorText(e)}`));
      }
  started = true;
  host.interactive = true;
  // asks show from now on (the App draws those queued before it mounts): questions held back at startup can be asked
  void agent.ctx.emit("interactive", {});
  return cli;
}

/** The TUI's controller (`createCli`'s result): what `cli.init`, `cli.keys`, `cliOf(ctx)` and the hooks get. */
export interface Cli extends Awaited<ReturnType<typeof createCli>> {}
