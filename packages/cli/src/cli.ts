import {
  type Agent,
  EFFORTS,
  type Effort,
  loadConfig,
  type Message,
  type Plugin,
  saveConfig,
  type Session,
  type ToolCall,
} from "@hortus/core";
import { createStore } from "zustand/vanilla";
import type { CliPlugin } from "./api.ts";
import { builtinCommands, type Command, findCommand, parseCommand } from "./commands.ts";
import { type Entry, entry, formatTool } from "./entry.ts";

/** What the TUI shows; written only by `createCli`, read through `useUi`. */
export interface UiState {
  /** the session shown and run on; swapped by `setSession` (e.g. /new) */
  session: Session;
  entries: Entry[];
  /** streamed thinking and text not yet turned into entries */
  live: { thinking: string; text: string };
  /** messages of the running turn; appended to the session when the run ends */
  turn: Message[];
  busy: boolean;
  /** effort of the next run; undefined = the provider's default */
  effort?: Effort;
  /** provider name and model the next run would use, plus its context window and efforts when the API reports them */
  status?: { name: string; model: string; window?: number; efforts?: Effort[] };
  /** chars of the last copy, shown until the next submit */
  copied?: number;
}

/** Whether the shown model takes `effort`; true while unknown (still loading, or not reported by the API). */
export const supports = (s: UiState, effort: Effort) => s.status?.efforts?.includes(effort) ?? true;

/** The effort runs use: the one set, unless the model doesn't take it (kept from another model) and would reject it. */
export const runEffort = (s: UiState) => (s.effort && supports(s, s.effort) ? s.effort : undefined);

/** Transcript entries for messages already in the session, so a resumed one shows as it was left. */
export function replay(messages: Message[]): Entry[] {
  const out: Entry[] = [];
  const calls = new Map<string, ToolCall>();
  for (const m of messages) {
    if (m.role === "user") out.push(entry("user", `\n${m.content}\n`));
    else if (m.role === "assistant") {
      if (m.text) out.push(entry("assistant", m.text));
      for (const c of m.toolCalls) calls.set(c.id, c);
    } else
      for (const r of m.results) {
        const c = calls.get(r.id);
        if (c) out.push(entry(r.isError ? "toolError" : "toolOk", formatTool(c, r)));
      }
  }
  return out;
}

/** UI state for showing `session` from its start: its file and settings, then its messages so far. */
function show(session: Session) {
  const { messages, model, provider } = session.getState();
  return {
    session,
    entries: [
      entry(
        "info",
        `Session: ${session.path} (${messages.length} messages)${provider ? ` · provider: ${provider}` : ""}${model ? ` · model: ${model}` : ""}`,
      ),
      ...replay(messages),
    ],
    live: { thinking: "", text: "" },
    turn: [],
    copied: undefined,
  };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The TUI's logic, without React: runs the agent on `session` or a `/name arg` command, turns its events into
 * transcript entries and keeps `status` in step with the session's model and provider. `makeAgent` creates the agent
 * with the run observer it's given.
 */
export async function createCli(session: Session, makeAgent: (observer: Plugin) => Promise<Agent>) {
  const ui = createStore<UiState>()(() => ({ ...show(session), busy: false, effort: undefined }));
  void loadConfig().then(
    ({ effort }) => ui.setState({ effort }),
    () => {},
  );
  const push = (...e: Entry[]) => ui.setState((s) => ({ entries: [...s.entries, ...e] }));
  // Deltas reach `live` at most once a frame: every store change renders synchronously (useSyncExternalStore), and a
  // fast stream of back-to-back sync renders trips React's nested-update limit while Ink's useBoxMetrics has updates
  // pending.
  let pending = { thinking: "", text: "" };
  let timer: NodeJS.Timeout | undefined;
  const take = () => {
    clearTimeout(timer);
    timer = undefined;
    const p = pending;
    pending = { thinking: "", text: "" };
    return p;
  };
  const stream = (key: "thinking" | "text", delta: string) => {
    pending[key] += delta;
    timer ??= setTimeout(() => {
      const p = take();
      ui.setState(({ live }) => ({ live: { thinking: live.thinking + p.thinking, text: live.text + p.text } }));
    }, 1000 / 30);
  };
  // streamed-but-unfinished thinking and text become entries, then the live view resets
  const flush = () => {
    const p = take();
    ui.setState(({ entries, live }) => {
      const thinking = live.thinking + p.thinking;
      const text = live.text + p.text;
      return {
        entries: [
          ...entries,
          ...(thinking ? [entry("thinking", thinking)] : []),
          ...(text ? [entry("assistant", text)] : []),
        ],
        live: { thinking: "", text: "" },
      };
    });
  };

  // pending tool blocks by call id, replaced by their result block when it arrives
  const calls = new Map<string, { call: ToolCall; entry: Entry }>();
  const agent = await makeAgent({
    on: {
      thinking: (delta) => stream("thinking", delta),
      text: (delta) => stream("text", delta),
      tool_call: (call) => {
        const e = entry("tool", formatTool(call));
        calls.set(call.id, { call, entry: e });
        push(e);
      },
      message: (message) => {
        if (message.role === "tool") {
          const done = new Map<Entry, Entry>();
          for (const r of message.results) {
            const c = calls.get(r.id);
            if (!c) continue;
            done.set(c.entry, { ...c.entry, kind: r.isError ? "toolError" : "toolOk", text: formatTool(c.call, r) });
            calls.delete(r.id);
          }
          ui.setState((s) => ({ entries: s.entries.map((e) => done.get(e) ?? e) }));
        }
        // an assistant message closes the streamed thinking and text
        flush();
        ui.setState((s) => ({ turn: [...s.turn, message] }));
      },
    },
  });

  // later plugins win, so a command can be replaced by name (like tools)
  const commands = [
    ...new Map(
      [...builtinCommands, ...(agent.plugins as CliPlugin[]).flatMap((p) => p.cli?.commands ?? [])].map((c) => [
        c.name,
        c,
      ]),
    ).values(),
  ];

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
      const [window, efforts] = await Promise.all([
        r.provider.contextWindow?.(r.model).catch(() => undefined),
        r.provider.efforts?.(r.model).catch(() => undefined),
      ]);
      if (n === seq) ui.setState({ status: { name: r.name, model: r.model, window, efforts } });
    } catch {
      if (n === seq) ui.setState({ status: undefined });
    }
  }
  const watch = (session: Session) =>
    session.subscribe((s, prev) => {
      if (s.model !== prev.model || s.provider !== prev.provider) void refreshStatus();
    });
  let unwatch = watch(session);
  ui.subscribe((s, prev) => {
    if (s.session === prev.session) return;
    unwatch();
    unwatch = watch(s.session);
    void refreshStatus();
  });
  void refreshStatus();

  let aborter: AbortController | undefined;
  async function run(value: string) {
    const { session } = ui.getState();
    const turn: Message[] = [{ role: "user", content: value }];
    // blank rows pad the message's background, as pi does
    ui.setState((s) => ({ busy: true, turn, entries: [...s.entries, entry("user", `\n${value}\n`)] }));
    const abort = new AbortController();
    aborter = abort;
    try {
      const { messages, model, provider } = session.getState();
      await agent
        .run([...messages, ...turn], { model, provider, effort: runEffort(ui.getState()), signal: abort.signal })
        .catch((e) => {
          if (!abort.signal.aborted) throw e;
        });
      if (abort.signal.aborted) {
        // the partial reply stays on screen but not in history; completed messages are kept
        flush();
        // error entries get no separator row, so the leading newline adds one; the next turn adds the one below
        push(entry("error", "\nInterrupted"));
      }
      // the turn moves into session.messages in one tick, so the usage line never counts it twice
      const saved = session.append(ui.getState().turn);
      ui.setState({ turn: [] });
      await saved;
    } catch (e) {
      flush();
      push(entry("error", errorText(e)));
    }
    ui.setState({ busy: false });
  }

  // not busy meanwhile, so a command can start a turn with `submit`
  async function command(c: Command, arg: string) {
    try {
      const text = await c.run(arg, cli);
      if (text) push(entry("info", text));
    } catch (e) {
      push(entry("error", errorText(e)));
    }
  }

  // saves run one after another, so the last effort set is the one left in config.json
  let saving = Promise.resolve();
  const setEffort = (effort: Effort | undefined) => {
    ui.setState({ effort });
    saving = saving
      .then(async () => saveConfig({ ...(await loadConfig()), effort }))
      .catch((e) => push(entry("error", `Couldn't save effort: ${errorText(e)}`)));
  };

  const cli = {
    ui,
    agent,
    /** the session shown, `ui`'s `session` */
    get session() {
      return ui.getState().session;
    },
    /** the built-ins and every plugin's `cli.commands`, one per name */
    commands,
    /**
     * starts `value` as a command or the next turn; false (the prompt keeps its input) when blank, still running or an
     * unknown command
     */
    submit: (value: string) => {
      if (!value.trim() || ui.getState().busy) return false;
      const cmd = parseCommand(value.trim());
      const c = cmd && findCommand(commands, cmd.name);
      if (cmd && !c) {
        push(entry("error", `Unknown command: /${cmd.name}`));
        return false;
      }
      ui.setState({ copied: undefined });
      (c ? command(c, cmd?.arg ?? "") : run(value)).catch((e) => push(entry("error", errorText(e))));
      return true;
    },
    abort: () => aborter?.abort(),
    /** sets the effort of the next runs (undefined = provider default) and saves it to config.json */
    setEffort,
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
    setCopied: (chars: number) => ui.setState({ copied: chars }),
    /** adds an error entry to the transcript */
    report: (text: string) => push(entry("error", text)),
    /** shows `session` in place of the current one: the transcript restarts from its messages, and runs go to it */
    setSession: (session: Session) => {
      // the running turn would end up split between the two
      if (ui.getState().busy) throw new Error("Can't switch sessions while a turn is running");
      ui.setState(show(session));
    },
  };
  return cli;
}

export type Cli = Awaited<ReturnType<typeof createCli>>;
