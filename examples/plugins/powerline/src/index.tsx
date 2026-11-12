import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Cli,
  type CliPlugin,
  cliOf,
  runEffort,
  type Span,
  theme,
  useSession,
  useShallow,
  useTheme,
  useUi,
} from "@hortus/cli";
import { type Ctx, listSessions, type Message, readSession, type Usage } from "@hortus/core";
import { Box, type Key, Text, useWindowSize } from "ink";
import { type ComponentType, useEffect, useState, useSyncExternalStore } from "react";
import {
  CURRENCIES,
  type Currency,
  dataDir,
  type PowerlineConfig,
  PRESET_NAMES,
  parseConfig,
  readRaw,
  saveRaw,
} from "./config.ts";
import { gitHost, gitStatus, invalidateGit, mightChangeBranch, onGitUpdate } from "./git.ts";
import {
  formatTokens,
  icons,
  isNotification,
  layout,
  mergeOptions,
  PRESETS,
  paint,
  rows,
  type SegmentContext,
  type Tokens,
  width,
} from "./segments.ts";
import { generateBatch, hasVibeFile, loadVibes, parseGenerateArgs, vibes } from "./vibes.ts";

// ── State ──────────────────────────────────────────────────────────────────

interface Welcome {
  model: string;
  provider: string;
  sessions: { name: string; ago: string }[];
  contextFiles: number;
  skills: number;
  tokens?: number;
  until: number;
}

interface State {
  enabled: boolean;
  cfg: PowerlineConfig;
  /** the editor text Alt+S put aside */
  stash: string | null;
  /** last stashed prompts, newest first (saved) */
  history: string[];
  lastPrompt: string;
  /** a prompt held for `sendDelayMs` */
  pending?: { text: string; deadline: number; timer: NodeJS.Timeout };
  /** texts sent while busy, waiting for the auto follow-up router */
  routing: { text: string; restored: boolean }[];
  vibe?: string;
  welcome?: Welcome;
  startTime: number;
  /** bumped when something outside the stores changed (git, currency rates) */
  tick: number;
}

const fresh = (): State => ({
  enabled: true,
  cfg: parseConfig(readRaw()),
  stash: null,
  history: readHistory(),
  lastPrompt: "",
  routing: [],
  startTime: Date.now(),
  tick: 0,
});
// ponytail: one TUI per process, so state is module-level (reset by `init`); key it by Cli if a host ever runs two
let st: State;
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => {
  st = { ...st, ...patch };
  for (const f of subs) f();
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
const useSt = <T,>(select: (s: State) => T) => useSyncExternalStore(subscribe, () => select(st));
const bump = () => set({ tick: st.tick + 1 });
onGitUpdate(() => st && bump());

/** the TUI and its ctx bound as this plugin, from `cli.init` */
let tui: { cli: Cli; ctx: Ctx } | undefined;

const vibe = vibes(
  () => st.cfg.vibe,
  (v) => set({ vibe: v }),
);

// ── Stash history and prompts ──────────────────────────────────────────────

const historyPath = () => join(dataDir(), "stash-history.json");
function readHistory(): string[] {
  try {
    const v = JSON.parse(readFileSync(historyPath(), "utf8")).history;
    return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string" && !!e.trim()).slice(0, 12) : [];
  } catch {
    return [];
  }
}
async function pushHistory(text: string) {
  if (st.history[0] === text) return;
  set({ history: [text, ...st.history.filter((h) => h !== text)].slice(0, 12) });
  await mkdir(dataDir(), { recursive: true });
  writeFileSync(historyPath(), `${JSON.stringify({ version: 1, history: st.history }, null, 2)}\n`);
}

const preview = (text: string, max = 72) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Up to `limit` distinct user prompts from the newest sessions that ran in `cwd` (this project), newest first. */
export async function recentPrompts(cwd: string, limit = 50) {
  const out: string[] = [];
  for (const s of (await listSessions()).filter((s) => s.cwd === cwd).slice(0, 50)) {
    const { messages } = await readSession(s.path);
    for (const m of [...messages].reverse()) {
      if (m.role !== "user" || m.meta) continue;
      const text = m.content.replace(/\s+/g, " ").trim();
      if (text && !out.includes(text)) out.push(text);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

async function pick(ctx: Ctx, question: string, items: string[]) {
  const labels = items.map((t, i) => `#${i + 1} ${preview(t)}`);
  const a = await ctx.ask({ question, options: labels.map((label) => ({ label })) });
  const i = typeof a === "string" ? labels.indexOf(a) : -1;
  return i === -1 ? undefined : items[i];
}

async function insertPrompt(ctx: Ctx, cli: Cli, text: string) {
  const current = cli.ui.getState().input;
  if (!current.trim()) {
    cli.setInput(text);
    return "Inserted prompt";
  }
  const a = await ctx.ask({
    question: "Insert prompt",
    options: [{ label: "Replace" }, { label: "Append" }, { label: "Cancel" }],
  });
  if (a === "Replace") {
    cli.setInput(text);
    return "Replaced editor with prompt";
  }
  if (a === "Append") {
    cli.setInput(`${current}${current.endsWith("\n") || text.startsWith("\n") ? "" : "\n"}${text}`);
    return "Appended prompt";
  }
}

async function openHistory(ctx: Ctx) {
  const cli = cliOf(ctx);
  let source = "project";
  if (st.history.length) {
    const a = await ctx.ask({
      question: "Prompt history",
      options: [
        { label: "Stashed prompts", description: `${st.history.length} saved` },
        { label: "Recent project prompts", description: "load on demand" },
      ],
    });
    if (!a) return;
    source = a === "Stashed prompts" ? "stash" : "project";
  }
  if (source === "project") {
    const prompts = await recentPrompts(ctx.cwd);
    if (!prompts.length) return st.history.length ? "No recent project prompts" : "No prompt history yet";
    const text = await pick(ctx, "Recent project prompts", prompts);
    return text && insertPrompt(ctx, cli, text);
  }
  const text = await pick(ctx, "Stash history", st.history);
  if (!text) return;
  const a = await ctx.ask({ question: "Stashed prompt", options: [{ label: "Insert" }, { label: "Cancel" }] });
  return a === "Insert" ? insertPrompt(ctx, cli, text) : undefined;
}

// ── /reply ─────────────────────────────────────────────────────────────────

interface Quote {
  id: string;
  role: "user" | "assistant";
  text: string;
}
function quotes(messages: readonly Message[]): Quote[] {
  const out: Quote[] = [];
  for (const m of [...messages].reverse()) {
    if (out.length >= 200) break;
    const text = m.role === "user" && !m.meta ? m.content.trim() : m.role === "assistant" ? m.text.trim() : "";
    if (text && m.entryId && m.role !== "tool") out.push({ id: m.entryId, role: m.role, text });
  }
  return out;
}
export function formatQuote(q: Quote) {
  const cut = q.text.length > 6000;
  const body = (cut ? q.text.slice(0, 6000).trimEnd() : q.text)
    .split(/\r?\n/)
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
  const lines = [`Quoted previous ${q.role} message ${q.id} for reference only:`, "", body];
  if (cut) lines.push("", `> [Quote truncated from ${q.text.length.toLocaleString()} characters.]`);
  lines.push("", "My reply:", "");
  return lines.join("\n");
}

async function reply(arg: string, ctx: Ctx) {
  const cli = cliOf(ctx);
  const all = quotes(ctx.session?.getState().messages ?? []);
  if (!all.length) {
    await ctx.notify("No user or assistant messages are available to quote.", "warn");
    return;
  }
  const query = arg.trim().replace(/^#/, "").toLowerCase();
  let q: Quote | undefined;
  if (query) {
    const hits = all.filter((c) => c.id.toLowerCase().startsWith(query));
    if (hits.length !== 1) {
      await ctx.notify(
        hits.length
          ? `Message id "${query}" matches ${hits.length} messages. Type more of the id.`
          : `No quotable message matches id "${query}".`,
        "warn",
      );
      return;
    }
    q = hits[0];
  } else {
    const shown = all.slice(0, 80);
    const labels = shown.map((c) => `${c.id.slice(0, 8)} ${c.role}: ${preview(c.text, 220)}`);
    const a = await ctx.ask({ question: "Reply to previous message", options: labels.map((label) => ({ label })) });
    q = shown[typeof a === "string" ? labels.indexOf(a) : -1];
  }
  if (!q) return;
  // the caret after the quote, before the draft
  const quote = formatQuote(q);
  cli.setInput(`${quote}${cli.ui.getState().input}`, { caret: [...quote].length });
  return `Inserted quote from ${q.role} message ${q.id}.`;
}

// ── Sending: delay, steer, follow-up ───────────────────────────────────────

const JEV = "https://api.typesafe.ai/v1/systemone";

/** Asks TypeSafe's Jev whether a message sent while the agent works can wait until it finishes. */
export async function canWaitAsFollowUp(
  fetch: typeof globalThis.fetch,
  apiKey: string,
  state: { currentTask: string; agentLatestText: string; newMessage: string },
) {
  const res = await fetch(JEV, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(1500),
    body: JSON.stringify({
      model: "jev-latest",
      state: {
        current_task: state.currentTask || "Unknown",
        agent_latest_text: state.agentLatestText || "None yet",
        new_message: state.newMessage,
      },
      questions: {
        route: {
          type: "choice",
          instructions:
            "A coding agent is busy with `current_task`. Should `new_message` be delivered now as steering for that task, or queued until the task finishes?",
          criteria: {
            steer:
              "The message changes, constrains, corrects, adds scope to, or gives information about the task the agent is doing right now, so the agent should see it before its next step. Includes messages that mix a change to the current task with a later request.",
            follow_up:
              "The message is a separate request or question that does not change how the current task should be done, so it can wait until the current task finishes.",
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Jev returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const route = ((await res.json()) as { answers?: { route?: { choice?: unknown; confidence?: unknown } } }).answers
    ?.route;
  if ((route?.choice !== "steer" && route?.choice !== "follow_up") || typeof route.confidence !== "number")
    throw new Error("Jev returned an unexpected route answer");
  return route.choice === "follow_up" && route.confidence >= 0.8;
}

const lastAssistantText = (messages: readonly Message[]) => {
  for (const m of [...messages].reverse())
    if (m.role === "assistant" && m.text.trim()) return m.text.trim().slice(0, 200);
};

/** Sends `text` now: steering while a run works (or a follow-up, when the router says it can wait), else a new run. */
async function deliver(text: string) {
  if (!tui) return;
  const { cli, ctx } = tui;
  let deliver: "steer" | "after" = "steer";
  if (cli.ui.getState().busy && st.cfg.autoFollowUp) {
    const apiKey = process.env.TYPESAFE_API_KEY?.trim();
    if (!apiKey) await ctx.notify("Auto follow-up needs TYPESAFE_API_KEY; sent as steering", "warn");
    else {
      const routing = { text, restored: false };
      set({ routing: [...st.routing, routing] });
      try {
        const wait = await canWaitAsFollowUp(ctx.fetch, apiKey, {
          currentTask: st.lastPrompt,
          agentLatestText: lastAssistantText(cli.session.getState().messages) ?? "",
          newMessage: text,
        });
        if (wait) deliver = "after";
      } catch (e) {
        await ctx.notify(
          `Auto follow-up unavailable (${e instanceof Error ? e.message : e}); sent as steering`,
          "warn",
        );
      } finally {
        set({ routing: st.routing.filter((r) => r !== routing) });
      }
      if (routing.restored) return;
    }
  }
  await ctx.send(text, { deliver });
}

function takePending() {
  const p = st.pending;
  if (!p) return;
  clearTimeout(p.timer);
  set({ pending: undefined });
  return p;
}
const send = (text: string) =>
  void deliver(text).catch((e) => tui?.cli.report(`Couldn't send: ${e instanceof Error ? e.message : e}`));
const sendPendingNow = () => {
  const p = takePending();
  if (p) send(p.text);
};
/** Prompts (and steering) wait `sendDelayMs` first, so Esc can take them back; slash commands never do. */
function submit(text: string) {
  const t = text.trim();
  if (!t) return sendPendingNow();
  if (st.cfg.sendDelayMs <= 0 || t.startsWith("/")) return send(text);
  sendPendingNow();
  set({
    pending: {
      text: t,
      deadline: Date.now() + st.cfg.sendDelayMs,
      timer: setTimeout(sendPendingNow, st.cfg.sendDelayMs),
    },
  });
}
/** Puts held and routing texts back into the editor, above the draft. */
function restore(cli: Cli) {
  const back = [takePending()?.text, ...st.routing.filter((r) => !r.restored).map((r) => r.text)].filter(
    (t): t is string => !!t,
  );
  for (const r of st.routing) r.restored = true;
  const draft = cli.ui.getState().input;
  if (back.length) cli.setInput([...back, draft].filter((t) => t.trim()).join("\n\n"));
}

// ── Keys ───────────────────────────────────────────────────────────────────

/** A Pi key id (`ctrl+alt+h`) against Ink's key. */
export function matchesKey(spec: string | null, input: string, key: Key) {
  if (!spec) return false;
  const parts = spec.split("+");
  const name = parts.pop() ?? "";
  const ctrl = parts.includes("ctrl");
  const alt = parts.includes("alt") || parts.includes("meta");
  if (key.ctrl !== ctrl && !(ctrl && name === "h" && key.backspace)) return false;
  if (key.meta !== alt || key.shift !== parts.includes("shift")) return false;
  // Ctrl+H arrives as Backspace
  if (ctrl && name === "h" && key.backspace) return true;
  const named: Record<string, boolean> = {
    escape: key.escape,
    enter: key.return,
    tab: key.tab,
    up: key.upArrow,
    down: key.downArrow,
    left: key.leftArrow,
    right: key.rightArrow,
  };
  return name in named ? !!named[name] : input.toLowerCase() === name;
}

function toggleStash(cli: Cli, ctx: Ctx, text: string) {
  if (!text.trim()) {
    if (st.stash === null) return void ctx.notify("Nothing to stash");
    cli.setInput(st.stash);
    set({ stash: null });
    void ctx.status("stash");
    return void ctx.notify("Stash restored");
  }
  const had = st.stash !== null;
  set({ stash: text });
  void pushHistory(text);
  cli.setInput("");
  void ctx.status("stash", "stash");
  void ctx.notify(had ? "Stash updated" : "Text stashed");
}

/** The editor's keys (`cli.keys`): seen before the built-in prompt's, which never sees those handled here. */
function keys(input: string, key: Key, cli: Cli): boolean {
  if (!st.enabled || !tui) return false;
  const { ctx } = tui;
  if (st.welcome) set({ welcome: undefined });
  const text = cli.ui.getState().input;
  const sc = st.cfg.shortcuts;
  // Esc takes held and routing prompts back instead of aborting the run
  if (key.escape && (st.pending || st.routing.length)) restore(cli);
  // Alt+Enter queues a follow-up for after the running turn (else it's the prompt's newline)
  else if (key.return && key.meta && cli.ui.getState().busy && text.trim() && !text.trim().startsWith("/")) {
    cli.setInput("");
    void ctx.send(text, { deliver: "after" });
  } else if ((key.meta && input.toLowerCase() === "s" && !key.ctrl) || (key.ctrl && !key.meta && input === "s"))
    toggleStash(cli, ctx, text);
  else if (matchesKey(sc.stashHistory, input, key))
    void openHistory(ctx)
      .then((r) => void (r && ctx.notify(r)))
      .catch((e) => cli.report(String(e)));
  else if (matchesKey(sc.cutEditor, input, key) || matchesKey(sc.copyEditor, input, key)) {
    const cut = matchesKey(sc.cutEditor, input, key);
    if (!text.trim()) void ctx.notify("Editor is empty");
    else {
      cli.copy(text);
      if (cut) cli.setInput("");
      void ctx.notify(cut ? "Cut editor text" : "Copied editor text");
    }
  } else if (matchesKey(sc.reply, input, key))
    void reply("", ctx)
      .then((r) => void (r && ctx.notify(r)))
      .catch((e) => cli.report(String(e)));
  else return false;
  return true;
}

/** Enter (`cli.submit`): sends a held prompt now when empty, and steers the running turn, which the built-in refuses. */
function submitKey(value: string, Default: (value: string) => boolean, cli: Cli): boolean {
  const t = value.trim();
  if (!st.enabled || (!t && !st.pending)) return Default(value);
  if (!t) {
    sendPendingNow();
    return true;
  }
  if (!cli.ui.getState().busy || t.startsWith("/")) return Default(value);
  cli.setInput("");
  submit(value);
  return true;
}

// ── Footer ─────────────────────────────────────────────────────────────────

let rates: { at: number; rates: Partial<Record<Currency, number>> } | undefined;
let fetchingRates = false;
const ratesPath = () => join(dataDir(), "currency-rates.json");
/** USD → `c`, from a keyless FX feed cached for a day; undefined until known (then the footer redraws). */
function rate(c: Currency): number | undefined {
  if (c === "USD") return 1;
  if ((!rates || Date.now() - rates.at > 86_400_000) && !fetchingRates && tui) {
    fetchingRates = true;
    const { ctx } = tui;
    void (async () => {
      try {
        rates ??= JSON.parse(await readFile(ratesPath(), "utf8"));
        if (rates && Date.now() - rates.at < 86_400_000) return;
        const res = await ctx.fetch(
          "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
        );
        const usd = ((await res.json()) as { usd?: Record<string, unknown> }).usd ?? {};
        const next: Partial<Record<Currency, number>> = {};
        for (const k of CURRENCIES)
          if (typeof usd[k.toLowerCase()] === "number") next[k] = usd[k.toLowerCase()] as number;
        rates = { at: Date.now(), rates: next };
        await mkdir(dataDir(), { recursive: true });
        writeFileSync(ratesPath(), JSON.stringify(rates));
      } catch {
        // stays unknown; the next draw tries again after the day
      } finally {
        fetchingRates = false;
        bump();
      }
    })();
  }
  return rates?.rates[c];
}

/** Pi's token counts (uncached input) from the branch's replies and tools' own model calls; totals over `messages` plus `extra` (the session's `usage`: subruns', and what a compaction moved out of messages) */
function tokens(messages: readonly Message[], extra?: Usage) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let last: Tokens | undefined;
  let context: number | null = null;
  // the session's usage counts like a tool's own model calls: in the totals, not the context
  const all: readonly Message[] = extra
    ? [...messages, { role: "tool", results: [{ id: "", output: "", usage: extra }] }]
    : messages;
  for (const m of all) {
    const usages =
      m.role === "assistant"
        ? [m.usage, ...m.toolCalls.map((c) => c.result?.usage)]
        : m.role === "tool"
          ? m.results.map((r) => r.usage)
          : [];
    usages.forEach((u, i) => {
      if (!u) return;
      const write = u.cacheWrite ?? 0;
      const t = {
        input: Math.max(0, u.input - u.cacheRead - write),
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: write,
      };
      total.input += t.input;
      total.output += t.output;
      total.cacheRead += t.cacheRead;
      total.cacheWrite += t.cacheWrite;
      total.cost += u.cost ?? 0;
      if (m.role === "assistant" && i === 0) {
        last = t;
        context = u.input + u.output;
      }
    });
  }
  return { total, last, context };
}

function useTick(ms: number) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** The bar's rows at the terminal's width. */
function useBar() {
  useTheme();
  useTick(1000);
  useSt((s) => s.tick);
  const cfg = useSt((s) => s.cfg);
  const { columns } = useWindowSize();
  const messages = useSession((s) => s.messages);
  const name = useSession((s) => s.name);
  const id = useUi((s) => s.session.id);
  const status = useUi((s) => s.status);
  const effort = useUi(runEffort);
  // their texts (Pi's statuses are text)
  const statuses = useUi(
    useShallow((s) => Object.fromEntries(Object.entries(s.statuses).map(([k, v]) => [k, v.text]))),
  );
  const preset = PRESETS[cfg.preset];
  const options = mergeOptions(preset.options, cfg.segmentOptions);
  const ids = rows(preset, cfg.customItems, cfg.layout, cfg.disabledSegments);
  // the session's (`/cd`), else where hortus started
  const cwd = useSession((s) => s.cwd) ?? process.cwd();
  const extra = useSession((s) => s.usage);
  const { total, last, context } = tokens(messages, extra);
  const g = options.git ?? {};
  const showGit =
    ids.includes("git") && [g.showBranch, g.showStaged, g.showUnstaged, g.showUntracked].some((v) => v !== false);
  const c: SegmentContext = {
    model: status && {
      id: status.model,
      provider: status.name,
      reasoning: status.efforts?.some((e) => e !== "off") ?? true,
    },
    thinking: effort ?? "auto",
    sessionId: id,
    sessionName: name,
    cwd,
    usage: total,
    last,
    contextTokens: context,
    contextWindow: status?.window ?? 0,
    git: showGit ? gitStatus(cwd, g.polling, g.statusTtlMs) : { branch: null, staged: 0, unstaged: 0, untracked: 0 },
    gitHost: showGit && g.hostIcon ? gitHost(cwd) : null,
    statuses,
    hidden: new Set([
      ...cfg.hiddenExtensionStatusKeys,
      ...cfg.customItems.filter((i) => i.excludeFromExtensionStatuses).map((i) => i.statusKey),
    ]),
    custom: new Map(cfg.customItems.map((i) => [i.id, i])),
    options,
    colors: cfg.colors,
    icons: icons(cfg.icons),
    startTime: st.startTime,
    rate,
  };
  return {
    cfg,
    columns,
    statuses,
    ...layout(c, preset, ids, columns, {
      separator: cfg.separator ?? preset.separator,
      padding: cfg.padding,
      wrap: cfg.secondaryOverflow === "wrap",
    }),
  };
}

const Row = ({ spans }: { spans: Span[] }) =>
  spans.length ? (
    <Text wrap="truncate">
      {spans.map(({ text, ...style }, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional
        <Text key={i} {...style}>
          {text}
        </Text>
      ))}
    </Text>
  ) : null;

const truncate = (s: string, w: number) => (width(s) <= w ? s : `${[...s].slice(0, Math.max(0, w - 1)).join("")}…`);

/** The working message (a vibe), styled like Pi's `workingVibes.color`. */
function VibeLine() {
  const v = useSt((s) => s.vibe);
  const busy = useUi((s) => s.busy);
  const color = useSt((s) => s.cfg.workingVibes.color);
  useTheme();
  return v && busy ? <Row spans={[{ text: " " }, ...paint(color ?? "muted", v)]} /> : null;
}

/** Above the input: notification statuses (`[...]`), the working message (above-powerline), the bar (placement above). */
function AboveInput({ Default }: { Default: ComponentType }) {
  const enabled = useSt((s) => s.enabled);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Default />
      {enabled && <AboveBar />}
    </Box>
  );
}
function AboveBar() {
  const { cfg, top, statuses, columns } = useBar();
  const hasVibe = useSt((s) => !!s.vibe);
  const busy = useUi((s) => s.busy);
  const working = hasVibe && busy && cfg.workingIndicatorPlacement === "above-powerline";
  const hidden = new Set(cfg.hiddenExtensionStatusKeys);
  const notes = Object.entries(statuses).filter(
    ([k, v]) => !hidden.has(k) && isNotification(v) && width(` ${v}`) <= columns,
  );
  const bar = cfg.placement === "above" && top.length > 0;
  if (!notes.length && !working && !bar) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {notes.map(([k, v]) => (
        <Text key={k}>{` ${v}`}</Text>
      ))}
      {working && <VibeLine />}
      {bar && <Row spans={top} />}
    </Box>
  );
}

/** Pi's footer: the bar (placement below), the delayed-send countdown, the last prompt, then the secondary rows. */
function StatusBar({ Default }: { Default: ComponentType }) {
  return useSt((s) => s.enabled) ? <Footer /> : <Default />;
}
function Footer() {
  const { cfg, top, secondary, columns } = useBar();
  const pending = useSt((s) => s.pending);
  const last = useSt((s) => s.lastPrompt);
  const rest: Span[][] = [];
  if (cfg.placement === "below") rest.push(top);
  if (pending) {
    const secs = Math.max(1, Math.ceil((pending.deadline - Date.now()) / 1000));
    const hint = `sending in ${secs}s · esc to edit · enter to send now`;
    rest.push([
      { text: " " },
      ...paint("accent", hint),
      { text: "  " },
      ...paint("dim", truncate(pending.text.replace(/\s+/g, " "), Math.max(1, columns - width(hint) - 3))),
    ]);
  }
  const compact = last.replace(/\s+/g, " ").trim();
  if (cfg.showLastPrompt && compact && columns - 3 >= 10)
    rest.push([{ text: " " }, ...paint("dim", `↳ ${truncate(compact, columns - 3)}`)]);
  return (
    <Box flexDirection="column">
      {[...rest, ...secondary].map((spans, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
        <Row key={i} spans={spans} />
      ))}
    </Box>
  );
}

/** The input, with the working message on its top edge (editor-border). */
function Prompt({ Default }: { Default: ComponentType }) {
  const enabled = useSt((s) => s.enabled);
  const placement = useSt((s) => s.cfg.workingIndicatorPlacement);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {enabled && placement === "editor-border" && <VibeLine />}
      <Default />
    </Box>
  );
}

// ── Welcome ────────────────────────────────────────────────────────────────

const LOGO = [
  "██████████    ",
  "████  ████    ",
  "████  ████    ",
  "████████  ████",
  "████      ████",
  "████      ████",
];
const GRADIENT = ["#ff00af", "#d75fff", "#af5fff", "#875fff", "#5fafff", "#00ffff"];

function ago(d: Date) {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function showWelcome(cli: Cli, ctx: Ctx) {
  // Pi's: only for a session with no replies yet
  if (cli.session.getState().messages.some((m) => m.role === "assistant")) return;
  const r = await ctx.resolve().catch(() => undefined);
  let counts = { context: 0, skills: 0 };
  let tokens: number | undefined;
  try {
    const req = await ctx.preview([]);
    counts = { context: req.context.length, skills: req.skills?.length ?? 0 };
    tokens = req.system ? Math.ceil(req.system.length / 4) : undefined;
  } catch {
    // no provider yet: nothing counted
  }
  const sessions = (await listSessions().catch(() => []))
    .filter((s) => s.id !== cli.session.id)
    .slice(0, 3)
    .map((s) => ({ name: preview(s.title, 30), ago: ago(s.created) }));
  // something happened meanwhile (a key, a run): too late
  if (!st.welcome && cli.ui.getState().input === "" && !cli.ui.getState().busy && st.enabled)
    set({
      welcome: {
        model: r?.model ?? "No model",
        provider: r?.provider ?? "Unknown",
        sessions,
        contextFiles: counts.context,
        skills: counts.skills,
        tokens,
        until: Date.now() + 30_000,
      },
    });
}

function WelcomeBox({ w }: { w: Welcome }) {
  useTick(1000);
  useTheme();
  const { columns } = useWindowSize();
  const left = Math.ceil((w.until - Date.now()) / 1000);
  useEffect(() => {
    if (left <= 0) set({ welcome: undefined });
  }, [left]);
  const boxWidth = Math.min(columns, Math.max(76, Math.min(columns - 2, 96)));
  const dim = (t: string) => <Text color={theme.dim}>{t}</Text>;
  const head = (t: string) => (
    <Text bold color={theme.accent}>
      {` ${t}`}
    </Text>
  );
  const line = (n: number | string, what: string) => (
    <Text>
      {" "}
      {dim("- ")}
      <Text color={theme.green}>{n}</Text> {what}
    </Text>
  );
  return (
    <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
      <Box width={boxWidth} borderStyle="round" borderColor={theme.dim}>
        <Box width={26} flexDirection="column" alignItems="center" paddingY={1}>
          <Text bold>Welcome back!</Text>
          <Text> </Text>
          {LOGO.map((l, i) => (
            <Text key={l + String(i)}>
              {[...l].map((ch, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: characters are positional
                <Text key={j} color={GRADIENT[Math.min(GRADIENT.length - 1, Math.floor(j / 2))]}>
                  {ch}
                </Text>
              ))}
            </Text>
          ))}
          <Text> </Text>
          <Text color="#d787af">{w.model}</Text>
          {dim(w.provider)}
        </Box>
        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="single"
          borderColor={theme.dim}
          borderTop={false}
          borderBottom={false}
          borderRight={false}
        >
          {head("Tips")}
          <Text> {dim("/")} for commands</Text>
          <Text> {dim("Alt+S")} stash the prompt</Text>
          <Text> {dim("Shift+Tab")} cycle thinking</Text>
          {head("Loaded")}
          {w.contextFiles || w.skills ? (
            <>
              {w.contextFiles > 0 && line(w.contextFiles, `context file${w.contextFiles === 1 ? "" : "s"}`)}
              {w.skills > 0 && line(w.skills, `skill${w.skills === 1 ? "" : "s"}`)}
            </>
          ) : (
            <Text> {dim("No context files or skills loaded")}</Text>
          )}
          {w.tokens ? line(`≈ ${formatTokens(w.tokens)}`, "initial prompt tokens") : null}
          {head("Recent sessions")}
          {w.sessions.length ? (
            w.sessions.map((s) => (
              <Text key={s.name + s.ago} wrap="truncate">
                {" "}
                {dim("• ")}
                <Text color="#00afaf">{s.name}</Text>
                {dim(` (${s.ago})`)}
              </Text>
            ))
          ) : (
            <Text> {dim("No recent sessions")}</Text>
          )}
        </Box>
      </Box>
      {dim(`Press any key to continue (${Math.max(0, left)}s)`)}
    </Box>
  );
}

/** Pi's welcome overlay, in the transcript's place until a key, a run or 30 seconds dismiss it. */
function Transcript({ Default }: { Default: ComponentType }) {
  const w = useSt((s) => s.welcome);
  const { columns } = useWindowSize();
  return w && columns >= 44 ? <WelcomeBox w={w} /> : <Default />;
}

// ── Plugin ─────────────────────────────────────────────────────────────────

const shown = (ctx: Ctx) => !!tui && ctx.session === tui.cli.session;

async function vibeCommand(arg: string, ctx: Ctx) {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();
  const v = st.cfg.vibe;
  const setVibe = async (patch: Partial<typeof v>, raw: Record<string, unknown>) => {
    set({ cfg: { ...st.cfg, vibe: { ...st.cfg.vibe, ...patch } } });
    await saveRaw({}, raw);
  };
  if (!sub) {
    let s = `Vibe: ${v.theme ?? "off"} | Mode: ${v.mode} | Model: ${v.model}`;
    if (v.theme && v.mode === "file") {
      const n = loadVibes(v.theme).length;
      s += n ? ` | File: ${n} vibes` : " | File: not found";
    }
    return s;
  }
  if (sub === "model") {
    const spec = parts.slice(1).join(" ");
    if (!spec) return `Current vibe model: ${v.model}`;
    if (spec.toLowerCase() !== "auto" && !spec.includes("/"))
      throw new Error("Invalid model format. Use: provider/model (e.g. anthropic/claude-haiku-4-5:low), or auto");
    await setVibe({ model: spec }, { model: spec });
    return spec.toLowerCase() === "auto"
      ? "Vibe model set to: auto (follows active model)"
      : `Vibe model set to: ${spec}`;
  }
  if (sub === "mode") {
    const mode = parts[1]?.toLowerCase();
    if (!mode) return `Current vibe mode: ${v.mode}`;
    if (mode !== "generate" && mode !== "file") throw new Error("Invalid mode. Use: generate or file");
    if (mode === "file" && v.theme && !hasVibeFile(v.theme))
      throw new Error(`No vibe file for "${v.theme}". Run /vibe generate ${v.theme} first`);
    await setVibe({ mode }, { mode });
    return `Vibe mode set to: ${mode}`;
  }
  if (sub === "generate") {
    const g = parseGenerateArgs(parts.slice(1));
    if (!g) throw new Error("Usage: /vibe generate <theme> [count]");
    await ctx.notify(`Generating ${g.count} vibes for "${g.theme}"...`);
    const r = await generateBatch(ctx, v.model, g.theme, g.count);
    return `Generated ${r.count} vibes for "${g.theme}" → ${r.path}`;
  }
  if (sub === "off") {
    await setVibe({ theme: null }, { theme: null });
    vibe.reset();
    return "Vibe disabled";
  }
  const theme = arg.trim();
  await setVibe({ theme }, { theme });
  vibe.reset();
  if (v.mode === "file" && !hasVibeFile(theme))
    await ctx.notify(`Vibe set to: ${theme} (file mode, but no file found - run /vibe generate ${theme})`, "warn");
  else return `Vibe set to: ${theme}`;
}

/**
 * Pi's pi-powerline-footer: a powerline status bar (presets, segments, layout, custom items from statuses), a welcome
 * overlay, working vibes, an editor stash with history, delayed send, Enter-steers/Alt+Enter-follows-up while a turn
 * runs (optionally routed by TypeSafe's Jev), /reply quoting and editor copy/cut.
 */
const plugin: CliPlugin = {
  on: {
    init: () => {
      st = fresh();
      tui = undefined;
    },
    session_open: ({ reason }) => {
      if (!st) return;
      set({ lastPrompt: "", startTime: Date.now(), stash: null, welcome: undefined });
      if (reason !== "start") void tui?.ctx.status("stash");
      invalidateGit(true);
    },
    input: (p, ctx) => {
      if (!st || p.meta || p.handled) return;
      if (p.source === "user" && st.enabled && st.cfg.sendDelayMs > 0 && shown(ctx)) {
        p.handled = true;
        return submit(p.text);
      }
      set({ lastPrompt: p.text });
    },
    run_start: (p, ctx) => {
      if (p.source === "preview" || !shown(ctx)) return;
      set({ welcome: undefined });
      vibe.start(ctx, st.lastPrompt);
    },
    tool_call: ({ call }, ctx) => {
      if (!shown(ctx)) return;
      set({ welcome: undefined });
      vibe.toolCall(
        ctx,
        call.name,
        (call.input ?? {}) as Record<string, unknown>,
        lastAssistantText(ctx.session?.getState().messages ?? []),
      );
    },
    tool_result: ({ call }) => {
      if (call.name === "write" || call.name === "edit") invalidateGit();
      else if (call.name === "bash")
        invalidateGit(mightChangeBranch(String((call.input as { command?: unknown })?.command ?? "")));
      else return;
      if (st) bump();
    },
    run_end: (p, ctx) => {
      if (p.source === "run" && shown(ctx)) vibe.end();
    },
    close: () => {
      if (st?.pending) clearTimeout(st.pending.timer);
    },
  },
  commands: [
    {
      name: "powerline",
      description: "Configure powerline status (toggle, preset, placement)",
      args: "[preset|placement above|below|toggle]",
      complete: () => [
        ...PRESET_NAMES.map((value) => ({ value, description: "preset" })),
        ...["above", "below", "toggle"].map((p) => ({ value: `placement ${p}` })),
      ],
      run: async (arg, ctx) => {
        const a = arg.trim().toLowerCase();
        if (!a) {
          const enabled = !st.enabled;
          if (!enabled) {
            if (tui) restore(tui.cli);
            set({ stash: null, welcome: undefined });
            await ctx.status("stash");
          }
          set({ enabled });
          return `Powerline ${enabled ? "enabled" : "disabled"}`;
        }
        const m = /^placement(?:\s+(above|below|toggle))?$/.exec(a);
        if (m) {
          const placement =
            m[1] === "above" || m[1] === "below" ? m[1] : st.cfg.placement === "above" ? "below" : "above";
          set({ cfg: { ...st.cfg, placement } });
          await saveRaw({ placement });
          return `Powerline placement set to: ${placement}`;
        }
        const preset = PRESET_NAMES.find((p) => p === a);
        if (preset) {
          set({ cfg: { ...st.cfg, preset } });
          await saveRaw({ preset });
          return `Preset set to: ${preset}`;
        }
        return `Available presets: ${PRESET_NAMES.join(", ")}`;
      },
    },
    {
      name: "cd",
      description: "Change the session's working directory (the path segment, tools and AGENTS.md follow it)",
      args: "[dir]",
      run: async (arg, ctx) => {
        if (!arg.trim()) return `Working directory: ${ctx.cwd}`;
        const dir = resolve(ctx.cwd, arg.trim().replace(/^~(?=$|\/)/, homedir()));
        if (!(await stat(dir).catch(() => undefined))?.isDirectory()) throw new Error(`Not a directory: ${dir}`);
        if (!ctx.session) throw new Error("There is no session");
        await ctx.session.setCwd(dir);
        return `Working directory: ${dir}`;
      },
    },
    {
      name: "stash-history",
      description: "Open prompt history picker",
      run: (_, ctx) => (st.enabled ? openHistory(ctx) : "Powerline is disabled"),
    },
    {
      name: "reply",
      description: "Quote a previous user or assistant message into the editor",
      args: "[message id]",
      run: (arg, ctx) => reply(arg, ctx),
    },
    {
      name: "vibe",
      description: "Set working message theme. Usage: /vibe [theme|off|mode|model|generate]",
      args: "[theme|off|mode|model|generate]",
      run: (arg, ctx) => vibeCommand(arg, ctx),
    },
  ],
  cli: {
    statusBar: StatusBar,
    aboveInput: AboveInput,
    prompt: Prompt,
    transcript: Transcript,
    keys,
    submit: submitKey,
    init: (cli, ctx) => {
      tui = { cli, ctx };
      if (st.cfg.invalid.length)
        void ctx.notify(`Ignoring invalid powerline settings: ${st.cfg.invalid.join(", ")}`, "warn");
      if (st.cfg.welcome) void showWelcome(cli, ctx);
    },
  },
};
export default plugin;
