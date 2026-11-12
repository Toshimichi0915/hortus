import {
  type CliPlugin,
  createStore,
  type EntryRenderer,
  type StoreApi,
  theme,
  usePluginCtx,
  useSession,
  useStore,
  useTheme,
} from "@hortus/cli";
import {
  type Command,
  type Ctx,
  type Effort,
  EFFORTS,
  type Message,
  type PluginEntry,
  type SessionState,
  type SubRun,
  type Usage,
} from "@hortus/core";
import { Box, Text } from "ink";
import type { ComponentType } from "react";

/**
 * Pi's pi-btw: `/btw <question>` asks a side question in a nested run (`ctx.subrun`, an in-memory child session seeded
 * with the main conversation) while the main run goes on; follow-ups continue that thread. The TUI shows the thread in a
 * panel above the input (focused: the prompt asks BTW, Esc aborts or dismisses, Alt+/ switches focus). The thread is kept
 * as hidden `btw:*` entries in the main session (never in the main agent's context), and `/btw:inject` or
 * `/btw:summarize` hands it to the main agent.
 */

export type Mode = "contextual" | "tangent" | "readonly";

export interface Exchange {
  question: string;
  answer: string;
  provider: string;
  model: string;
  effort?: Effort;
  usage?: Usage;
}

/** The thread on the session's branch, rebuilt from its `btw:*` entries. */
export interface Thread {
  mode: Mode;
  exchanges: Exchange[];
  /** `/btw:model` and `/btw:thinking` overrides; unset inherits the main thread's */
  model?: { provider: string; model: string };
  effort?: Effort;
}

const EMPTY: Thread = { mode: "contextual", exchanges: [] };
export const thread = (s: SessionState) => (s.data.btw as Thread | undefined) ?? EMPTY;
const threadOf = (ctx: Ctx) => (ctx.session ? thread(ctx.session.getState()) : EMPTY);

export const SYSTEM_PROMPT = [
  "You are having an aside conversation with the user, separate from their main working session.",
  "If main session messages are provided, they are for context only — that work is being handled by another agent.",
  "If no main session messages are provided, treat this as a fully contextless tangent thread and rely only on the user's words plus your general instructions.",
  "Focus on answering the user's side questions, helping them think through ideas, or planning next steps.",
  "Do not act as if you need to continue unfinished work from the main session unless the user explicitly asks you to prepare something for injection back to it.",
].join(" ");
const SUMMARIZE_PROMPT =
  "Summarize the side conversation concisely. Preserve key decisions, plans, insights, risks, and action items. Output only the summary.";
const CONTINUE_USER = "[The following is a separate side conversation. Continue this thread.]";
const CONTINUE_ASSISTANT = "Understood, continuing our side conversation.";

// ponytail: hortus has no grep/find/ls tools; read-only is just `read` (add them here when core has them)
const TOOLS: Record<Mode, string[]> = {
  contextual: ["read", "bash", "edit", "write"],
  tangent: ["read", "bash", "edit", "write"],
  readonly: ["read"],
};
const TITLES: Record<Mode, string> = { contextual: "BTW", tangent: "BTW tangent", readonly: "BTW · read-only" };

// ── Per-agent runtime (`ctx.state`) ───────────────────────────────────────────────────────────────────────────────

interface Runtime {
  /** the side thread's child run, kept for follow-ups until reset, dismissed or a setting changes */
  child?: SubRun;
  /** submissions run one at a time */
  queue: Promise<unknown>;
  /** bumped by resets: turns started before one drop their result */
  gen: number;
  /** the live UI state, which the panel draws */
  ui: StoreApi<Ui>;
}

const CLOSED: Ui = { open: false, focused: false, streaming: false, live: "", question: undefined, status: undefined };

const rtOf = (ctx: Ctx) => {
  const s = ctx.state as { rt?: Runtime };
  s.rt ??= { queue: Promise.resolve(), gen: 0, ui: createStore(() => CLOSED) };
  return s.rt;
};
/** this agent's BTW UI state */
export const uiOf = (ctx: Ctx) => rtOf(ctx).ui;
const getUi = (ctx: Ctx) => uiOf(ctx).getState();
const setUi = (ctx: Ctx, patch: Partial<Ui>) => uiOf(ctx).setState(patch);

const drop = (rt: Runtime) => {
  rt.child?.abort("dismissed");
  rt.child = undefined;
};

// ── Live UI state ────────────────────────────────────────────────────────────────────────────────────────────────

export interface Ui {
  open: boolean;
  focused: boolean;
  streaming: boolean;
  /** the question being answered, and what has streamed of the answer (and tool calls) so far */
  question?: string;
  live: string;
  status?: string;
}

// ── The side thread ──────────────────────────────────────────────────────────────────────────────────────────────

const isNote = (m: Message) => m.role === "user" && m.meta?.plugin === "btw" && m.meta.type === "note";
const strip = (m: Message): Message => {
  const { entryId: _, ...rest } = m;
  return rest as Message;
};

/** The child's seed: the main conversation (not for tangents, BTW notes left out), then the thread so far. */
function seed(state: SessionState, t: Thread, mode: Mode): Message[] {
  const out = mode === "tangent" ? [] : state.messages.filter((m) => !isNote(m)).map(strip);
  if (t.exchanges.length) {
    const said = (text: string): Message => ({ role: "assistant", text, toolCalls: [] });
    out.push({ role: "user", content: CONTINUE_USER }, said(CONTINUE_ASSISTANT));
    for (const e of t.exchanges) out.push({ role: "user", content: e.question }, said(e.answer));
  }
  return out;
}

/** The provider, model and effort BTW uses: its overrides, else the main thread's (an unusable model override warns). */
async function settings(ctx: Ctx, t: Thread, warn = false) {
  let resolved: Awaited<ReturnType<Ctx["resolve"]>> | undefined;
  let note: string | undefined;
  if (t.model)
    try {
      resolved = await ctx.resolve(t.model);
    } catch (e) {
      note = `Configured BTW model ${t.model.provider}/${t.model.model} is unavailable (${message(e)}). Falling back to the main model.`;
      if (warn) await ctx.notify(note, "warn");
    }
  resolved ??= await ctx.resolve();
  // unset: the subrun takes the main session's
  const effort = t.effort;
  return {
    provider: resolved.provider,
    model: resolved.model,
    effort,
    source: t.model && !note ? "override" : "main",
    note,
  };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tui = (ctx: Ctx) => ctx.host.kind === "tui";

async function reset(ctx: Ctx, mode: Mode = "contextual") {
  const rt = rtOf(ctx);
  rt.gen++;
  drop(rt);
  setUi(ctx, { live: "", question: undefined, status: undefined, streaming: false });
  await ctx.session?.appendEntry("btw:reset", { mode });
}

/** Asks `question` in the side thread (one at a time); resolves with the status line it ends on. */
function ask(ctx: Ctx, question: string, save: boolean, mode: Mode): Promise<string | undefined> {
  const rt = rtOf(ctx);
  const gen = rt.gen;
  const turn = rt.queue.then(() => (gen === rt.gen ? execute(ctx, rt, gen, question, save, mode) : undefined));
  rt.queue = turn.catch(() => {});
  return turn;
}

async function execute(ctx: Ctx, rt: Runtime, gen: number, question: string, save: boolean, mode: Mode) {
  const main = ctx.session;
  if (!main) throw new Error("There is no session for a BTW thread");
  const t = thread(main.getState());
  const set = await settings(ctx, t, true);
  if (gen !== rt.gen) return;
  const wasBusy = ctx.busy();
  setUi(ctx, { open: tui(ctx) || getUi(ctx).open, streaming: true, question, live: "", status: "⏳ streaming..." });
  try {
    let end: Awaited<SubRun["done"]>;
    if (rt.child) end = await rt.child.send(question, { deliver: "steer" });
    else {
      rt.child = ctx.subrun(question, {
        seed: seed(main.getState(), t, mode),
        tools: TOOLS[mode],
        provider: set.provider,
        model: set.model,
        ...(set.effort && { effort: set.effort }),
      });
      end = await rt.child.done;
    }
    if (gen !== rt.gen) return;
    if (end?.error !== undefined) throw end.error;
    if (end?.aborted) return status(ctx, "⏹ Aborted. Press Esc again to dismiss BTW.");
    const last = end?.messages.at(-1);
    if (last?.role !== "assistant") throw new Error("BTW request finished without a response.");
    const exchange: Exchange = {
      question,
      answer: last.text,
      provider: set.provider,
      model: set.model,
      ...(set.effort && { effort: set.effort }),
      ...(last.usage && { usage: last.usage }),
    };
    setUi(ctx, { question: undefined, live: "" }); // the entry shows it from here on
    await main.appendEntry("btw:entry", exchange);
    if (!(save || !tui(ctx))) return status(ctx, "Ready for a follow-up. Hidden BTW thread updated.");
    await ctx.send(
      { content: noteText(exchange), meta: { plugin: "btw", type: "note", details: exchange } },
      { deliver: "context" },
    );
    const done = !tui(ctx)
      ? wasBusy
        ? "BTW response queued to display after the current turn finishes."
        : "Displayed BTW response in the session."
      : wasBusy
        ? "BTW note queued to save after the current turn finishes."
        : "Saved BTW note to the session.";
    return status(ctx, done);
  } catch (e) {
    if (gen !== rt.gen) return;
    drop(rt);
    status(ctx, "Request failed. Thread preserved for retry or follow-up.");
    throw e;
  }
}

function status(ctx: Ctx, text: string) {
  setUi(ctx, { streaming: false, question: undefined, live: "", status: text });
  return text;
}

const noteText = (e: Pick<Exchange, "question" | "answer">) =>
  `**Question**\n\n${e.question}\n\n**Answer**\n\n${e.answer}`;
const formatThread = (t: Thread) =>
  t.exchanges.map((e) => `User: ${e.question.trim()}\nAssistant: ${e.answer.trim()}`).join("\n\n---\n\n");

/** `--save` (first) and the question. */
export function parseArgs(arg: string) {
  const m = arg.trim().match(/^--save(?:\s+([\s\S]*))?$/);
  return m ? { save: true, question: (m[1] ?? "").trim() } : { save: false, question: arg.trim() };
}

/**
 * `/btw`, `/btw:tangent`, `/btw:ask`: asks in `mode` (switching mode clears the thread first). In the TUI it returns at
 * once and the panel shows the turn; elsewhere it waits and shows the answer as a session note.
 */
function entry(mode: Mode, fresh = false): Command["run"] {
  return async (arg, ctx) => {
    const { question, save } = parseArgs(arg);
    if (!question && !tui(ctx)) throw new Error("Pass the question inline: the BTW composer needs the TUI");
    if (fresh || threadOf(ctx).mode !== mode) await reset(ctx, mode);
    if (!question) {
      setUi(ctx, { open: true, focused: true, ...(fresh && { status: "Started a fresh BTW thread." }) });
      return fresh ? "Started a fresh BTW thread." : undefined;
    }
    if (!tui(ctx)) return ask(ctx, question, save, mode);
    setUi(ctx, { open: true, focused: true });
    ask(ctx, question, save, mode).catch((e) => ctx.notify(message(e), "error"));
  };
}

/** Sends `content` to the main agent: a turn now, or after the running one. */
const toMain = (ctx: Ctx, content: string) => void ctx.send(content, { deliver: "after" }).catch(() => {});

async function handoff(ctx: Ctx, arg: string, summarize: boolean) {
  await rtOf(ctx).queue;
  const t = threadOf(ctx);
  if (!t.exchanges.length) {
    await ctx.notify(`No BTW thread to ${summarize ? "summarize" : "inject"}.`, "warn");
    return;
  }
  setUi(ctx, { status: summarize ? "⏳ summarizing..." : "⏳ injecting into the main session..." });
  let body = formatThread(t);
  try {
    if (summarize) {
      const set = await settings(ctx, t, true);
      const reply = await ctx.complete({
        system: SUMMARIZE_PROMPT,
        messages: [{ role: "user", content: body }],
        provider: set.provider,
        model: set.model,
        effort: "off",
      });
      body = reply.text;
    }
  } catch (e) {
    setUi(ctx, { status: "Summarize failed. Thread preserved for retry or injection." });
    throw e;
  }
  const what = summarize ? "a summary of a side conversation I had" : "a side conversation I had";
  toMain(
    ctx,
    arg.trim()
      ? `Here is ${what}. ${arg.trim()}\n\n${body}`
      : `Here is ${what}${summarize ? "" : " for additional context"}:\n\n${body}`,
  );
  const n = t.exchanges.length;
  await reset(ctx);
  setUi(ctx, { open: false, focused: false });
  return `Injected BTW ${summarize ? "summary" : "thread"} (${n} exchange${n === 1 ? "" : "s"}).`;
}

const commands: Command[] = [
  {
    name: "btw",
    aliases: ["side"],
    args: "[--save] <question>",
    description:
      "Ask a side question while the main run goes on (continues the BTW thread; --save keeps a visible note)",
    run: entry("contextual"),
  },
  {
    name: "btw:tangent",
    args: "[--save] <question>",
    description: "Ask in a contextless BTW tangent (no main-session conversation)",
    run: entry("tangent"),
  },
  {
    name: "btw:ask",
    args: "[--save] <question>",
    description: "Ask a read-only side question (main-session context, read tool only)",
    run: entry("readonly"),
  },
  {
    name: "btw:new",
    args: "[question]",
    description: "Start a fresh BTW thread with main-session context, optionally asking right away",
    run: entry("contextual", true),
  },
  {
    name: "btw:clear",
    description: "Dismiss BTW and clear its thread",
    run: async (_, ctx) => {
      await reset(ctx);
      setUi(ctx, { open: false, focused: false });
      return "Cleared BTW thread.";
    },
  },
  {
    name: "btw:inject",
    args: "[instructions]",
    description: "Send the BTW thread to the main agent as a user message, then clear it",
    run: (arg, ctx) => handoff(ctx, arg, false),
  },
  {
    name: "btw:summarize",
    args: "[instructions]",
    description: "Summarize the BTW thread, send the summary to the main agent, then clear it",
    run: (arg, ctx) => handoff(ctx, arg, true),
  },
  {
    name: "btw:model",
    args: "[<provider>/<model> | clear]",
    description: "Show, set, or clear the BTW-only model",
    complete: async (ctx) => [
      { value: "clear" },
      ...(await ctx.listModels()).map((m) => ({ value: `${m.provider}/${m.id}` })),
    ],
    run: async (arg, ctx) => {
      const session = ctx.session;
      if (!session) throw new Error("There is no session");
      const a = arg.trim();
      if (!a) {
        const s = await settings(ctx, thread(session.getState()));
        const source =
          s.source === "override"
            ? "override"
            : thread(session.getState()).model
              ? "inherited fallback"
              : "inherits main thread";
        return `BTW model: ${s.provider}/${s.model} (${source}).${s.note ? ` ${s.note}` : ""}`;
      }
      let value: Thread["model"] | null = null;
      if (a !== "clear") {
        const i = a.indexOf("/");
        if (i <= 0) throw new Error("Usage: /btw:model [<provider>/<model> | clear]");
        value = { provider: a.slice(0, i), model: a.slice(i + 1) };
        await ctx.resolve(value); // throws for an unknown provider or model
      }
      await session.appendEntry("btw:model", value);
      drop(rtOf(ctx));
      return value
        ? `BTW model override set to ${value.provider}/${value.model}.`
        : "BTW model override cleared. BTW now inherits the main thread model.";
    },
  },
  {
    name: "btw:thinking",
    args: "[<level> | clear]",
    description: "Show, set, or clear the BTW-only thinking effort",
    complete: () => [{ value: "clear" }, ...EFFORTS.map((value) => ({ value }))],
    run: async (arg, ctx) => {
      const session = ctx.session;
      if (!session) throw new Error("There is no session");
      const a = arg.trim();
      const t = thread(session.getState());
      if (!a)
        return `BTW thinking: ${t.effort ?? session.getState().effort ?? "auto"} (${t.effort ? "override" : "inherits main thread"}).`;
      if (a !== "clear" && !EFFORTS.includes(a as Effort))
        throw new Error(`Usage: /btw:thinking [${EFFORTS.join(" | ")} | clear]`);
      await session.appendEntry("btw:thinking", a === "clear" ? null : a);
      drop(rtOf(ctx));
      return a === "clear"
        ? "BTW thinking override cleared. BTW now inherits the main thread thinking level."
        : `BTW thinking override set to ${a}.`;
    },
  },
];

// ── TUI ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Esc while streaming aborts the BTW turn; otherwise it dismisses BTW (the thread stays for later). */
function onEscape(ctx: Ctx) {
  const rt = rtOf(ctx);
  if (getUi(ctx).streaming && rt.child) {
    rt.child.abort("esc");
    return;
  }
  rt.gen++;
  drop(rt);
  setUi(ctx, CLOSED);
}

const cliPart: NonNullable<CliPlugin["cli"]> = {
  keys: (input, key, _cli, ctx) => {
    const ui = getUi(ctx);
    if (!ui.open) return;
    if (key.meta && input === "/") {
      setUi(ctx, { focused: !ui.focused });
      return true;
    }
    if (ui.focused && key.escape) {
      onEscape(ctx);
      return true;
    }
  },
  submit: (value, Default, cli, ctx) => {
    const ui = getUi(ctx);
    if (!ui.open || !ui.focused || !value.trim() || value.startsWith("/")) return Default(value);
    cli.setInput("");
    ask(ctx, value.trim(), false, threadOf(ctx).mode).catch((e) => ctx.notify(message(e), "error"));
    return true;
  },
  aboveInput: Panel,
  entries: {
    "btw:note": {
      Render: ({ entry }) => (
        <Box flexDirection="column">
          <Text bold color={theme.accent}>
            [BTW]
          </Text>
          <Text color={theme.customMessageText}>{entry.text.trim()}</Text>
        </Box>
      ),
      text: ({ entry }) => `[BTW]\n${entry.text.trim()}`,
    } satisfies EntryRenderer,
  },
};

/** The side thread above the input while BTW is open: its last exchanges, the live turn and the status line. */
function Panel({ Default }: { Default: ComponentType }) {
  const s = useStore(uiOf(usePluginCtx()));
  const t = useSession((st) => st.data.btw as Thread | undefined) ?? EMPTY;
  useTheme();
  if (!s.open) return <Default />;
  const shown = t.exchanges.slice(-3);
  const hint = s.focused
    ? `Enter asks BTW · Alt+/ main prompt · Esc ${s.streaming ? "abort" : "dismiss"}`
    : "Alt+/ focus BTW";
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={s.focused ? theme.accent : theme.border}
        paddingX={1}
        marginTop={1}
      >
        <Text bold color={theme.accent}>
          {TITLES[t.mode]}
        </Text>
        {t.exchanges.length > shown.length && (
          <Text color={theme.dim}>{`(${t.exchanges.length - shown.length} earlier)`}</Text>
        )}
        {shown.map((e, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: exchanges are positional
          <Box key={i} flexDirection="column">
            <Text color={theme.dim}>{`› ${e.question}`}</Text>
            <Text color={theme.text}>{e.answer}</Text>
          </Box>
        ))}
        {s.question && <Text color={theme.dim}>{`› ${s.question}`}</Text>}
        {s.live && <Text color={theme.text}>{s.live}</Text>}
        {s.status && <Text color={theme.dim}>{s.status}</Text>}
        <Text color={theme.dim}>{hint}</Text>
      </Box>
      <Default />
    </Box>
  );
}

export default {
  commands,
  entries: {
    entry: (e: PluginEntry<Exchange>, s) => {
      const t = thread(s);
      s.data.btw = { ...t, exchanges: [...t.exchanges, e.data] };
    },
    reset: (e: PluginEntry<{ mode: Mode }>, s) => {
      s.data.btw = { ...thread(s), mode: e.data.mode, exchanges: [] };
    },
    model: (e: PluginEntry<Thread["model"] | null>, s) => {
      const { model: _, ...t } = thread(s);
      s.data.btw = e.data ? { ...t, model: e.data } : t;
    },
    thinking: (e: PluginEntry<Effort | null>, s) => {
      const { effort: _, ...t } = thread(s);
      s.data.btw = e.data ? { ...t, effort: e.data } : t;
    },
  },
  on: {
    // the child gets BTW's instructions after the main thread's
    prompt: (p, ctx) => {
      if (ctx.run?.depth && ctx.session && ctx.session === rtOf(ctx).child?.session) p.system.push(SYSTEM_PROMPT);
    },
    // BTW notes are for the user: never in the main agent's context
    request: (p) => {
      p.messages = p.messages.filter((m) => !isNote(m));
    },
    text: (delta, ctx) => {
      if (ctx.session && ctx.session === rtOf(ctx).child?.session) setUi(ctx, { live: getUi(ctx).live + delta });
    },
    tool_call: (p, ctx) => {
      const { live } = getUi(ctx);
      if (ctx.session && ctx.session === rtOf(ctx).child?.session)
        setUi(ctx, { live: `${live}${live && !live.endsWith("\n") ? "\n" : ""}→ ${p.call.name}\n` });
    },
    // a session switch (or branch) restores that session's thread: entries are replayed, the child starts anew
    session_open: (_, ctx) => {
      const rt = rtOf(ctx);
      rt.gen++;
      drop(rt);
      setUi(ctx, CLOSED);
    },
    close: (_, ctx) => drop(rtOf(ctx)),
  },
  cli: cliPart,
} satisfies CliPlugin;
