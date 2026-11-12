import {
  addUsage,
  type CompactEvent,
  contextTokens,
  type CompactionData,
  type Ctx,
  isSummary,
  loadConfig,
  type Message,
  messageTokens,
  type Piece,
  type PluginEntry,
  type Session,
  type Usage,
  version,
} from "../index.ts";

const SELF = "builtin:compaction";
const DEFAULTS = { enabled: true, reserve: 16384, keepRecent: 20000 };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The settings, fitted to `window` when known: `reserve` at most half of it, and `keepRecent` at most half of what is
 * left below the threshold (more and a compaction leaves the context over the threshold, compacting every request).
 */
async function settings(window?: number) {
  const s = { ...DEFAULTS, ...(await loadConfig().catch(() => undefined))?.compaction };
  if (!window) return s;
  const reserve = Math.min(s.reserve, window / 2);
  return { ...s, reserve, keepRecent: Math.min(s.keepRecent, (window - reserve) / 2) };
}

/** where the messages a new summary replaces start: after the previous summary */
const startOf = (messages: readonly Message[]) => (isSummary(messages[0]) ? 1 : 0);

/**
 * The index of the first message to keep: walking back until `keepRecent` tokens are kept, at a message with an
 * `entryId` that is no tool result (never parting a call from its result), leaving at least one message to summarize.
 * None reaches `keepRecent`: the latest such cut when `force`, else undefined (nothing worth compacting).
 */
export function cut(messages: readonly Message[], keepRecent: number, force = false): number | undefined {
  let tokens = 0;
  let latest: number | undefined;
  for (let i = messages.length - 1; i > startOf(messages); i--) {
    const m = messages[i] as Message;
    tokens += messageTokens(m);
    if (m.role === "tool" || !m.entryId) continue;
    latest ??= i;
    if (tokens >= keepRecent) return i;
  }
  return force ? latest : undefined;
}

/**
 * Messages as text, so the summarizer doesn't continue them; tool calls and results cut at 2000 characters, and the
 * whole at `max` characters, keeping the newest (an older part left out, a message too long clipped).
 */
function serialize(messages: readonly Message[], max = Number.POSITIVE_INFINITY): string {
  const clip = (s: string, n = 2000) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s);
  const parts = messages.flatMap((m) => {
    if (m.role === "user") return [`[User]: ${m.content}`];
    if (m.role === "tool")
      return m.results.map((r) => `[Tool result${r.isError ? " (error)" : ""}]: ${clip(r.output)}`);
    return [
      ...(m.text ? [`[Assistant]: ${m.text}`] : []),
      ...(m.toolCalls.length
        ? [
            `[Assistant tool calls]: ${m.toolCalls.map((c) => `${c.name}(${clip(JSON.stringify(c.input))})`).join("; ")}`,
          ]
        : []),
    ];
  });
  const kept: string[] = [];
  for (let i = parts.length - 1, left = max; i >= 0 && left > 0; i--) {
    const part = parts[i] as string;
    kept.unshift(clip(part, left));
    left -= part.length + 2;
  }
  const left = parts.length - kept.length;
  return [...(left ? [`[${left} earlier parts left out]`] : []), ...kept].join("\n\n");
}

const SYSTEM =
  "You are a context summarization assistant. You read a conversation between a user and an AI coding agent and write a structured summary that lets the agent continue the work without the conversation. Do not continue the conversation and do not answer questions in it: output only the summary.";
const FORMAT = `Write the summary in this format:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements the user stated]

## Progress
### Done
- [x] [Completed tasks]
### In Progress
- [ ] [Current work]
### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [File paths, names, values and errors needed to continue]`;

function summaryPrompt(p: CompactEvent, messages: readonly Message[], max?: number) {
  return [
    `<conversation>\n${serialize(messages, max)}\n</conversation>`,
    p.previousSummary &&
      `<previous-summary>\n${p.previousSummary}\n</previous-summary>\n\nThe previous summary covers what came before the conversation above: update it with the conversation, keeping what still matters.`,
    FORMAT,
    p.instructions && `Additional focus: ${p.instructions}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The user message the session starts with after a compaction (the entry's id is its `entryId`). */
const summaryMessage = (summary: string, entryId: string): Message => ({
  role: "user",
  content: `The conversation before this point was compacted into this summary:\n\n<summary>\n${summary}\n</summary>`,
  meta: { plugin: SELF, type: "summary", details: { summary } },
  entryId,
});

/** the tokens `m` spent: a reply's own, and its (or a tool message's) results' */
function usageOf(m: Message): Usage | undefined {
  const results =
    m.role === "tool" ? m.results : m.role === "assistant" ? m.toolCalls.flatMap((c) => c.result ?? []) : [];
  return results.reduce((u, r) => addUsage(u, r.usage), m.role === "assistant" ? m.usage : undefined);
}

/** a request's copy of `messages`: deep, without results' `details` (as core builds one) */
const requestCopy = (messages: readonly Message[]): Message[] =>
  structuredClone(
    messages.map((m) => (m.role === "tool" ? { ...m, results: m.results.map(({ details: _, ...r }) => r) } : m)),
  );

/** `ctx.state[key]`, made on first use */
const stored = <T>(ctx: Ctx, key: string, make: () => T): T => {
  ctx.state[key] ??= make();
  return ctx.state[key] as T;
};
/** in-flight compactions by session (one at a time: a second request waits for it, then does nothing) */
const inflight = (ctx: Ctx) => stored(ctx, "inflight", () => new WeakMap<Session, Promise<unknown>>());
/** compactions saved per session, so far */
const saved = (ctx: Ctx) => stored(ctx, "saved", () => new WeakMap<Session, number>());
/** run requests in flight → `saved` when they were built */
const built = (ctx: Ctx) => stored(ctx, "built", () => new Map<string, number>());
/**
 * sessions whose last reply answered a request built before a compaction saved since: its usage is the whole
 * uncompacted context's, so requests don't compact on it until a fresh reply arrives
 */
const stale = (ctx: Ctx) => stored(ctx, "stale", () => new WeakSet<Session>());

/**
 * Compacts `ctx.session`: `compact` (handlers may cancel, move the cut or supply the summary), the summary written by
 * `ctx.complete` unless supplied, the entry saved, then `compacted`. Resolves with the entry, or why there is none.
 */
async function compact(
  ctx: Ctx,
  reason: CompactEvent["reason"],
  instructions?: string,
): Promise<PluginEntry<CompactionData> | string> {
  const session = ctx.session;
  if (!session) return "There is no session to compact";
  const running = inflight(ctx).get(session);
  if (running) {
    await running.catch(() => {});
    return "A compaction was already running";
  }
  const done = (async () => {
    const contextWindow =
      ctx.run?.info.contextWindow ??
      (await ctx
        .resolve()
        .then((r) => r.info.contextWindow)
        .catch(() => undefined));
    const { keepRecent } = await settings(contextWindow);
    const all = session.getState().messages;
    const at = cut(all, keepRecent, reason !== "threshold");
    if (at === undefined) return "Nothing to compact";
    const start = startOf(all);
    const previous = start
      ? ((all[0] as { meta?: { details?: { summary?: string } } }).meta?.details?.summary ?? "")
      : "";
    const index = (id: string | undefined) => {
      const i = id === undefined ? -1 : all.findIndex((m) => m.entryId === id);
      return i < start ? all.length : i;
    };
    // the first summary and details set are final (like `tool_call.result`); `messages` follows `firstKeptId`
    let summary: string | undefined;
    let details: unknown;
    const p = {
      reason,
      ...(instructions && { instructions }),
      firstKeptId: all[at]?.entryId,
      ...(previous && { previousSummary: previous }),
      tokensBefore: contextTokens(all),
      ...(contextWindow && { contextWindow }),
    } as CompactEvent;
    Object.defineProperties(p, {
      all: { value: Object.freeze(all.slice(start)), enumerable: true },
      messages: { get: () => Object.freeze(all.slice(start, index(p.firstKeptId))), enumerable: true },
      summary: {
        get: () => summary,
        set: (v: string) => {
          summary ??= v;
        },
        enumerable: true,
      },
      details: {
        get: () => details,
        set: (v: unknown) => {
          details ??= v;
        },
        enumerable: true,
      },
    });
    await ctx.emit("compact", p);
    if (p.cancel) return "Compaction cancelled by a plugin";
    // a handler's cut: never at a tool message (parting it from its call), nor past a reply whose calls still run
    let end = index(p.firstKeptId);
    while (end > start && all[end]?.role === "tool") end--;
    const last = all.at(-1);
    if (end === all.length && last?.role === "assistant" && last.toolCalls.some((c) => !c.result)) end--;
    if (end <= start) return "Nothing to compact";
    p.firstKeptId = all[end]?.entryId;
    let usage: Usage | undefined;
    if (summary === undefined) {
      await ctx.status("compaction", "Compacting…");
      try {
        // outside a run, the session's provider and model
        const target = ctx.run ? {} : await ctx.resolve().then(({ provider, model }) => ({ provider, model }));
        // the conversation at most half the window (unknown: half the estimate, or of what overflowed), so it fits
        const fit = contextWindow ?? p.tokensBefore;
        const reply = await ctx.complete({
          ...target,
          system: SYSTEM,
          messages: [{ role: "user", content: summaryPrompt(p, p.messages, fit && Math.floor(fit * 2)) }],
        });
        summary = reply.text.trim();
        usage = reply.usage;
      } finally {
        await ctx.status("compaction");
      }
    }
    if (!summary) throw new Error("The summary came back empty");
    const data: CompactionData = {
      summary,
      ...(details !== undefined && { details }),
      ...(p.firstKeptId !== undefined && { firstKeptId: p.firstKeptId }),
      tokensBefore: p.tokensBefore,
      ...(usage && { usage }),
    };
    // keeping nothing: not what was appended meanwhile either (a run's reply)
    if (data.firstKeptId === undefined) {
      const now = session.getState().messages;
      if (now.length > all.length && now[all.length - 1]?.entryId === all.at(-1)?.entryId)
        data.firstKeptId = now[all.length]?.entryId;
    }
    const id = await session.appendEntry(`${SELF}:compaction`, data);
    saved(ctx).set(session, (saved(ctx).get(session) ?? 0) + 1);
    const entry = session.entries().find((e) => e.id === id) as PluginEntry<CompactionData>;
    await ctx.emit("compacted", { entry, reason });
    return entry;
  })();
  inflight(ctx).set(session, done);
  try {
    return await done;
  } finally {
    inflight(ctx).delete(session);
  }
}

/** An automatic compaction: true if one was saved; a failure is reported, not thrown (the run goes on without it). */
async function auto(ctx: Ctx, reason: CompactEvent["reason"]) {
  try {
    return typeof (await compact(ctx, reason)) !== "string";
  } catch (e) {
    if (!ctx.signal.aborted) await ctx.notify(`Compaction failed: ${errorText(e)}`, "error");
    return false;
  }
}

/** a provider error saying the request didn't fit the model's context */
const OVERFLOW =
  /context[ _-]?(length|window)|prompt is too long|input is too long|maximum context|too many (input )?tokens|exceeds? (the )?(context|max)|request too large|reduce the length/i;

/** runs whose overflow was compacted and retried: their next `response` is the retry's */
const retried = (ctx: Ctx) => stored(ctx, "retried", () => new Set<string>());

/**
 * Compaction: when a run's next request would pass the model's context window less `reserve` (`reason: "threshold"`),
 * or the provider rejects one as too long (`"overflow"`, then retried once), or on `/compact [instructions]` and a
 * `compact_request` (`"manual"`), the messages before about `keepRecent` recent tokens are replaced by a summary: a
 * `builtin:compaction:compaction` entry whose reducer starts `state.messages` with it. `compact` handlers may cancel,
 * move the cut or write the summary themselves (an algorithmic compactor); `compacted` follows.
 */
export default {
  name: SELF,
  version,
  plugin: {
    entries: {
      // the messages before `firstKeptId` become the summary; the usage of everything before moves to `state.usage`, so
      // totals hold and the context estimate (the last reply's usage) restarts after the summary
      compaction: ({ id, data: d }: PluginEntry<CompactionData>, state) => {
        const i = d.firstKeptId === undefined ? -1 : state.messages.findIndex((m) => m.entryId === d.firstKeptId);
        let usage = d.usage;
        for (const m of i === -1 ? state.messages : state.messages.slice(0, i)) usage = addUsage(usage, usageOf(m));
        const kept = (i === -1 ? [] : state.messages.slice(i)).map((m) => {
          if (m.role !== "assistant" || !m.usage) return m;
          usage = addUsage(usage, m.usage);
          const { usage: _, ...rest } = m;
          return rest;
        });
        state.messages = [summaryMessage(d.summary, id), ...kept];
        state.usage = addUsage(state.usage, usage);
      },
    },
    on: {
      request: async (r, ctx) => {
        const session = ctx.session;
        const window = ctx.run?.info.contextWindow;
        if (r.source !== "run" || !session || !window) return;
        const { enabled, reserve } = await settings(window);
        const over = !stale(ctx).has(session) && contextTokens(session.getState().messages) > window - reserve;
        // the request was copied before: it gets the compacted messages
        if (enabled && over && (await auto(ctx, "threshold"))) r.messages = requestCopy(session.getState().messages);
        built(ctx).set(r.id, saved(ctx).get(session) ?? 0);
      },
      response: async (res, ctx) => {
        const at = built(ctx).get(res.id);
        built(ctx).delete(res.id);
        // stale until a reply to a request built after the compaction arrives
        if (ctx.session && res.assistant && at !== undefined)
          stale(ctx)[at === (saved(ctx).get(ctx.session) ?? 0) ? "delete" : "add"](ctx.session);
        const id = ctx.run?.id;
        if (!id || res.request.source !== "run" || retried(ctx).delete(id)) return;
        if (res.error === undefined || res.retry) return;
        if (res.meta?.status !== 413 && !OVERFLOW.test(errorText(res.error))) return;
        if (!(await settings()).enabled) return;
        // the retry is built from the session's messages again, compacted
        if (await auto(ctx, "overflow")) {
          retried(ctx).add(id);
          res.retry = true;
        }
      },
      run_end: (_, ctx) => {
        if (ctx.run) retried(ctx).delete(ctx.run.id);
      },
      compact_request: async (p, ctx) => {
        const entry = await compact(ctx, "manual", p.instructions).catch(async (e) => {
          const why = `Compaction failed: ${errorText(e)}`;
          await ctx.notify(why, "error");
          return why;
        });
        if (typeof entry === "string") p.done?.(undefined, entry);
        else p.done?.(entry);
      },
    },
    commands: [
      {
        name: "compact",
        args: "[instructions]",
        description: "Summarize the conversation so far to free up context",
        run: async (arg, ctx) => {
          const r = await compact(ctx, "manual", arg.trim() || undefined);
          return typeof r === "string" ? r : undefined;
        },
      },
    ],
  },
} satisfies Piece;
