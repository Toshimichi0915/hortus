import type { Agent, Message, Plugin, Session, ToolCall } from "@phi/core";
import { createStore } from "zustand/vanilla";
import { type Entry, entry, formatTool } from "./entry.ts";

/** What the TUI shows; written only by `createCli`, read through `useUi`. */
export interface UiState {
  entries: Entry[];
  /** streamed thinking and text not yet turned into entries */
  live: { thinking: string; text: string };
  /** messages of the running turn; appended to the session when the run ends */
  turn: Message[];
  busy: boolean;
  /** provider name and model the next run would use, plus the context window when the API reports it */
  status?: { name: string; model: string; window?: number };
  /** chars of the last copy, shown until the next submit */
  copied?: number;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The TUI's logic, without React: runs the agent on `session`, turns its events into transcript entries and keeps
 * `status` in step with the session's model and provider. `providers` are the names in secrets.json (for /provider);
 * `makeAgent` creates the agent with the run observer it's given.
 */
export async function createCli(
  session: Session,
  providers: string[],
  makeAgent: (observer: Plugin) => Promise<Agent>,
) {
  const { messages, model, provider } = session.getState();
  const ui = createStore<UiState>()(() => ({
    entries: [
      entry(
        "info",
        `Session: ${session.path} (${messages.length} messages)${provider ? ` · provider: ${provider}` : ""}${model ? ` · model: ${model}` : ""}`,
      ),
    ],
    live: { thinking: "", text: "" },
    turn: [],
    busy: false,
  }));
  const push = (...e: Entry[]) => ui.setState((s) => ({ entries: [...s.entries, ...e] }));
  // streamed-but-unfinished thinking and text become entries, then the live view resets
  const flush = () =>
    ui.setState(({ entries, live: { thinking, text } }) => ({
      entries: [
        ...entries,
        ...(thinking ? [entry("thinking", thinking)] : []),
        ...(text ? [entry("assistant", text)] : []),
      ],
      live: { thinking: "", text: "" },
    }));

  // pending tool blocks by call id, replaced by their result block when it arrives
  const calls = new Map<string, { call: ToolCall; entry: Entry }>();
  const agent = await makeAgent({
    on: {
      thinking: (delta) => ui.setState(({ live }) => ({ live: { ...live, thinking: live.thinking + delta } })),
      text: (delta) => ui.setState(({ live }) => ({ live: { ...live, text: live.text + delta } })),
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

  // re-resolved whenever the session's model or provider changes
  let seq = 0;
  async function refreshStatus() {
    const n = ++seq;
    const { model, provider } = session.getState();
    try {
      const r = await agent.resolve({ model, provider });
      // a newer change won; don't overwrite it with a stale result
      if (n !== seq) return;
      ui.setState({ status: { name: r.name, model: r.model } });
      const window = await r.provider.contextWindow?.(r.model).catch(() => undefined);
      if (n === seq) ui.setState({ status: { name: r.name, model: r.model, window } });
    } catch {
      if (n === seq) ui.setState({ status: undefined });
    }
  }
  session.subscribe((s, prev) => {
    if (s.model !== prev.model || s.provider !== prev.provider) void refreshStatus();
  });
  void refreshStatus();

  let aborter: AbortController | undefined;
  async function run(value: string) {
    const cmd = value.trim().match(/^\/model(?:\s+(\S+))?$/);
    if (cmd) {
      if (!cmd[1]) return push(entry("info", `Model: ${session.getState().model ?? "(config default)"}`));
      await session.setModel(cmd[1]);
      return push(entry("info", `Model set to ${cmd[1]}`));
    }
    const pcmd = value.trim().match(/^\/provider(?:\s+(\S+))?$/);
    if (pcmd) {
      if (!pcmd[1]) return push(entry("info", `Provider: ${session.getState().provider ?? "(config default)"}`));
      if (!providers.includes(pcmd[1]))
        return push(entry("error", `Unknown provider: ${pcmd[1]} (${providers.join(", ")})`));
      await session.setProvider(pcmd[1]);
      return push(entry("info", `Provider set to ${pcmd[1]}`));
    }
    const turn: Message[] = [{ role: "user", content: value }];
    // blank rows pad the message's background, as pi does
    ui.setState((s) => ({ busy: true, turn, entries: [...s.entries, entry("user", `\n${value}\n`)] }));
    const abort = new AbortController();
    aborter = abort;
    try {
      const { messages, model, provider } = session.getState();
      await agent.run([...messages, ...turn], { model, provider, signal: abort.signal }).catch((e) => {
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

  return {
    session,
    ui,
    plugins: agent.plugins,
    /** starts `value` as a command or the next turn; false (the prompt keeps its input) when blank or still running */
    submit: (value: string) => {
      if (!value.trim() || ui.getState().busy) return false;
      ui.setState({ copied: undefined });
      run(value).catch((e) => push(entry("error", errorText(e))));
      return true;
    },
    abort: () => aborter?.abort(),
    setCopied: (chars: number) => ui.setState({ copied: chars }),
    /** adds an error entry to the transcript */
    report: (text: string) => push(entry("error", text)),
  };
}

export type Cli = Awaited<ReturnType<typeof createCli>>;
