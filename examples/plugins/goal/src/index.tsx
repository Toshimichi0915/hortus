import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type CliPlugin, type EntryRenderer, theme } from "@hortus/cli";
import {
  type Ctx,
  hortusDir,
  type Message,
  type PluginEntry,
  type Session,
  type SessionState,
  tool,
  type Usage,
  type UserMessage,
} from "@hortus/core";
import { Text } from "ink";
import { z } from "zod";
import {
  activeContract,
  continuePrompt,
  formatTokens,
  INACTIVE_CONTRACT,
  kickoffPrompt,
  MIN_WAIT_MS,
  resumePrompt,
  summary,
  updatedPrompt,
  waitingResumePrompt,
} from "./prompts.ts";

export type Status = "active" | "paused" | "blocked" | "budget_limited" | "complete";

/** The session branch's goal, as its last `goal:state` entry left it. */
export interface Goal {
  /** new on every start and edit: goal prompts and tool calls naming another are stale */
  id: string;
  text: string;
  status: Status;
  tokenBudget?: number;
  /** the branch's assistant tokens when the goal started; `tokensUsed` counts from there */
  baselineTokens: number;
  tokensUsed: number;
  /** runs that ended with the goal active */
  iteration: number;
  /** model responses of automatic (continuation) runs in this safety epoch */
  automaticTurns: number;
  /** automatic runs in a row without tool calls whose visible output was the same */
  toolFreeRepeats: number;
  lastFingerprint?: string;
  safetyPause?: "continuation_limit" | "no_progress";
  /** active but quiet: no continuation until a non-goal message, `/goal resume` or `resumeAt` */
  waiting?: { reason: string; resumeAt?: number };
  summary?: string;
  /** why it stopped */
  reason?: string;
}

/** `~/.hortus/goal.json`; null turns a limit off. */
export interface Settings {
  continuationLimits: { automaticTurns: number | null; noProgressTurns: number | null };
  /** whether other plugins may start and cancel goals over the `goal:start` / `goal:cancel` events */
  rpc: { enabled: boolean };
}
const DEFAULTS: Settings = { continuationLimits: { automaticTurns: 25, noProgressTurns: 3 }, rpc: { enabled: false } };
// ponytail: module-wide, read in `init`; per agent if one process ever runs two with different homes
let settings = DEFAULTS;

/** What a managed run (`goal:start`) hears on `goal:event`. */
export type GoalRunEvent =
  | { type: "state"; runId: string; goalId: string; status: Status | "cleared"; summary?: string; reason?: string }
  | { type: "error"; runId: string; operation: "start" | "cancel"; error: { code: string; message: string } };

declare module "@hortus/core" {
  interface Events {
    /** starts a goal (when `rpc.enabled`) whose state changes are published on `goal:event` until it stops */
    "goal:start": { runId: string; objective: string; tokenBudget?: number };
    /** pauses the managed run's goal */
    "goal:cancel": { runId: string; reason?: string };
    "goal:event": GoalRunEvent;
  }
}

/** goal prompts sent by the plugin: kickoff, resume and edit ones are manual, continuations automatic */
const KICK = "goal";
const CONTINUE = "goal:continue";

/** What the plugin tracks about a session besides its goal entry. */
interface Rt {
  /** the running run's goal, active at its start */
  goalId?: string;
  /** the entries of the messages before it (a compaction mid-run changes the history's length, not its entry ids) */
  start?: Set<string | undefined>;
  /** a goal tool ended the goal's turn (Pi's `terminate`) */
  ended?: boolean;
  /** the run that just ended asks for a continuation, sent at `idle` */
  continue?: boolean;
  timer?: NodeJS.Timeout;
  managed?: { runId: string; goalId: string; last?: string };
  runIds: Set<string>;
}
const rts = new WeakMap<Session, Rt>();
const rtOf = (s: Session) => {
  const r = rts.get(s) ?? { runIds: new Set() };
  rts.set(s, r);
  return r;
};

export const goalOf = (state: SessionState) => state.data.goal as Goal | undefined;
const sessionOf = (ctx: Ctx) => {
  if (!ctx.session) throw new Error("There is no session to keep the goal in");
  return ctx.session;
};
const unfinished = (g?: Goal): g is Goal => !!g && g.status !== "complete";
const over = (g: Goal) => g.tokenBudget !== undefined && g.tokensUsed >= g.tokenBudget;
/**
 * the branch's tokens (`input` includes cache reads and writes): its replies', its tool results' own (subruns'), and
 * the session's `usage` (what a compaction moved out of the messages), as `usageLine` counts them
 */
export const tokens = (s: Session) => {
  const { messages, usage } = s.getState();
  const n = (u?: Usage) => (u ? u.input + u.output : 0);
  return messages.reduce((sum, m) => {
    if (m.role === "tool") return m.results.reduce((t, r) => t + n(r.usage), sum);
    if (m.role !== "assistant") return sum;
    return m.toolCalls.reduce((t, c) => t + n(c.result?.usage), sum + n(m.usage));
  }, n(usage));
};
const used = (s: Session, g: Goal) => Math.max(0, tokens(s) - g.baselineTokens);
const epoch = (g: Goal): Goal => ({
  ...g,
  automaticTurns: 0,
  toolFreeRepeats: 0,
  lastFingerprint: undefined,
  safetyPause: undefined,
});
const halt = (g: Goal, status: Status, reason?: string): Goal => ({ ...g, status, waiting: undefined, reason });

/** Saves `goal` (null: none) as the branch's, stops a wait timer it no longer has, and tells a managed run. */
async function save(ctx: Ctx, s: Session, goal: Goal | null) {
  await s.appendEntry("goal:state", goal);
  const r = rtOf(s);
  if (goal?.status !== "active" || !goal.waiting?.resumeAt) {
    clearTimeout(r.timer);
    r.timer = undefined;
  }
  const m = r.managed;
  if (!m) return;
  const own = goal?.id === m.goalId ? goal : undefined;
  const status = own?.status ?? "cleared";
  if (status === m.last) return;
  m.last = status;
  if (status !== "active") r.managed = undefined;
  await ctx.emit("goal:event", {
    type: "state",
    runId: m.runId,
    goalId: m.goalId,
    status,
    ...(own?.summary && { summary: own.summary }),
    ...(own?.reason && status !== "complete" && { reason: own.reason }),
    ...(!own && { reason: "managed goal replaced or cleared" }),
  });
}

/**
 * Sends a goal prompt for goal `g` (`meta.details.goalId`, checked at `input`): starts a run when idle, else follows
 * the running one (after it ends, through `input`, like Pi's followUp).
 */
const kick = (ctx: Ctx, g: Goal, text: string, source = KICK) =>
  void ctx
    .send(
      { content: text, meta: { plugin: "goal", type: "prompt", details: { goalId: g.id } } },
      { deliver: "after", source },
    )
    .catch(() => {});
/** a run a continuation prompt started counts as automatic work */
const automatic = (ctx: Ctx) => ctx.run?.source === CONTINUE;

const MAX_OBJECTIVE = 4_000;
function objectiveOf(text: string) {
  const t = text.trim();
  if (!t) throw new Error("Usage: /goal <goal_to_complete>");
  if (t.length > MAX_OBJECTIVE)
    throw new Error(
      `Goal objective is too long (${t.length}/${MAX_OBJECTIVE} characters). Put long instructions in a file and reference it from /goal instead.`,
    );
  return t;
}

/** Starts a goal on the ctx's session and sends its kickoff prompt; `runId` makes it a managed run. */
export async function startGoal(ctx: Ctx, objective: string, tokenBudget?: number, runId?: string) {
  const s = sessionOf(ctx);
  const text = objectiveOf(objective);
  if (unfinished(goalOf(s.getState()))) throw new Error("A goal is unfinished: /goal edit it, or /goal clear it first");
  const goal: Goal = {
    id: randomUUID(),
    text,
    status: "active",
    ...(tokenBudget !== undefined && { tokenBudget }),
    baselineTokens: tokens(s),
    tokensUsed: 0,
    iteration: 0,
    automaticTurns: 0,
    toolFreeRepeats: 0,
  };
  if (runId) rtOf(s).managed = { runId, goalId: goal.id };
  await save(ctx, s, goal);
  kick(ctx, goal, kickoffPrompt(goal));
  return goal;
}

/** New objective (and budget), same usage; an active goal gets a fresh safety epoch and the updated prompt. */
export async function editGoal(ctx: Ctx, objective: string, tokenBudget?: number) {
  const s = sessionOf(ctx);
  const old = goalOf(s.getState());
  if (!unfinished(old)) throw new Error("No goal to edit");
  let goal: Goal = {
    ...old,
    id: randomUUID(),
    text: objectiveOf(objective),
    tokenBudget: tokenBudget ?? old.tokenBudget,
  };
  if (goal.status === "budget_limited" && !over(goal)) goal = { ...goal, status: "active", reason: undefined };
  if (goal.status === "active") goal = epoch({ ...goal, waiting: undefined });
  await save(ctx, s, goal);
  if (goal.status === "active") kick(ctx, goal, updatedPrompt(goal));
  return goal;
}

/** Stops automatic work, keeping the goal, and aborts its session's running run. */
export async function pauseGoal(ctx: Ctx, reason = "paused by the user") {
  const s = sessionOf(ctx);
  const g = goalOf(s.getState());
  if (g?.status !== "active") throw new Error("No active goal to pause");
  await save(ctx, s, halt(g, "paused", reason));
  ctx.abort(reason);
}

/** Resumes a stopped goal in a fresh safety epoch, or wakes a waiting one. */
export async function resumeGoal(ctx: Ctx) {
  const s = sessionOf(ctx);
  const g = goalOf(s.getState());
  if (!unfinished(g)) throw new Error("No goal to resume");
  if (g.status === "active") {
    if (!g.waiting) throw new Error("The goal is already active");
    const next = { ...g, waiting: undefined };
    await save(ctx, s, next);
    kick(ctx, next, waitingResumePrompt(next, g.waiting.reason));
    return next;
  }
  if (over(g))
    throw new Error(
      `The token budget is spent (${formatTokens(g.tokensUsed)}/${formatTokens(g.tokenBudget ?? 0)}): raise it with /goal edit --tokens <budget> <objective>`,
    );
  const next = epoch({ ...g, status: "active", reason: undefined });
  await save(ctx, s, next);
  kick(ctx, next, resumePrompt(next, g.status));
  return next;
}

/** Drops the goal (not the running run). */
export async function clearGoal(ctx: Ctx) {
  const s = sessionOf(ctx);
  if (!goalOf(s.getState())) throw new Error("No goal to clear");
  await save(ctx, s, null);
}

/** Schedules the waiting goal's deadline wake-up, if it has one (replacing an earlier timer). */
function schedule(ctx: Ctx, s: Session) {
  const r = rtOf(s);
  clearTimeout(r.timer);
  r.timer = undefined;
  const g = goalOf(s.getState());
  const at = g?.status === "active" ? g.waiting?.resumeAt : undefined;
  if (!g || at === undefined) return;
  r.timer = setTimeout(
    async () => {
      r.timer = undefined;
      const now = goalOf(s.getState());
      if (ctx.session !== s || now?.id !== g.id || now.status !== "active" || now.waiting?.resumeAt !== at) return;
      const next = { ...now, waiting: undefined };
      await save(ctx, s, next);
      kick(ctx, next, continuePrompt(next), CONTINUE);
    },
    Math.max(0, at - Date.now()),
  );
  r.timer.unref();
}

/** The visible text a run's replies had, normalized, hashed: the same twice in a row is no progress. */
function fingerprint(messages: Message[]) {
  const text = messages
    .flatMap((m) => (m.role === "assistant" ? [m.text] : []))
    .join("\n")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
  return createHash("sha256")
    .update(/^[\p{P}\s]*$/u.test(text) ? "" : text)
    .digest("hex");
}

const CONTRADICTORY = [
  /(?<!could\s)\bnot\s+(?:yet\s+)?(?:complete|completed|done|finished)\b/i,
  /\bstill\s+(?:incomplete|failing|failing\s+tests?|fails?)\b/i,
  /\btests?\s+(?:still\s+)?fail(?:ing)?\b/i,
];

/** The ctx's session and its active goal, if `id` names it; else the rejection the model gets. */
function owned(ctx: Ctx, id: string, what: string) {
  const s = ctx.session;
  const g = s && goalOf(s.getState());
  const reject = (why: string) => new Error(`${what} rejected: ${why}.`);
  if (!s || !unfinished(g)) throw reject("no active goal");
  if (id.trim() !== g.id) throw reject("goal_id does not match the active goal");
  if (g.status !== "active") throw reject(`goal is ${g.status}, not active`);
  return { s, g };
}

const goalId = z
  .string()
  .min(1)
  .max(128)
  .describe(
    "The exact goal_id shown in the current active /goal prompt. Used only to reject stale calls from older turns.",
  );
const MAX_WAIT_MS = 2_147_483_647;

const tools = [
  tool({
    name: "goal_complete",
    description:
      "Mark an active /goal complete only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and every requirement is verified. Tool visibility alone does not activate Goal mode. Never call for ordinary work, partial progress, blockers, failures, or unverified work.",
    inputSchema: z.object({
      goal_id: goalId,
      summary: z
        .string()
        .min(1)
        .max(4_000)
        .describe(
          "State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.",
        ),
    }),
    execute: async (input, ctx) => {
      const { s, g } = owned(ctx, input.goal_id, "Goal completion");
      const text = input.summary.trim();
      if (!text) throw new Error("Goal completion rejected: summary is empty.");
      if (CONTRADICTORY.some((p) => p.test(text)))
        throw new Error("Goal completion rejected: summary says the goal is not complete.");
      rtOf(s).ended = true;
      await save(ctx, s, { ...halt(g, "complete"), tokensUsed: used(s, g), summary: text });
      return `Goal complete: ${text}`;
    },
  }),
  tool({
    name: "goal_blocked",
    description:
      "Stop an active /goal only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and the same evidenced external blocker recurred for at least three consecutive Goal turns. Tool visibility alone does not activate Goal mode. Never call for ordinary clarification, uncertainty, incomplete work, or recoverable failures.",
    inputSchema: z.object({
      goal_id: goalId,
      reason: z
        .string()
        .min(1)
        .max(1_000)
        .describe("The specific user or external action required to unblock the goal."),
      evidence: z
        .string()
        .min(1)
        .max(4_000)
        .describe("Concrete evidence from the repeated attempts that proves the impasse."),
      repeated_turns: z
        .number()
        .int()
        .min(3)
        .describe("Number of separate turns spent trying to resolve this same blocker."),
    }),
    execute: async (input, ctx) => {
      const { s, g } = owned(ctx, input.goal_id, "goal_blocked");
      const reason = input.reason.trim();
      if (!reason || !input.evidence.trim())
        throw new Error("goal_blocked rejected: reason and evidence are required.");
      rtOf(s).ended = true;
      await save(ctx, s, { ...halt(g, "blocked", reason), tokensUsed: used(s, g) });
      return `Goal blocked: ${reason}`;
    },
  }),
  tool({
    name: "goal_wait",
    description: `Keep an active /goal quiet only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and progress depends on an arranged external wake event or one safety deadline. Tool visibility alone does not activate Goal mode. Call goal_wait alone. Requests below ${MIN_WAIT_MS}ms are clamped to ${MIN_WAIT_MS}ms. Never call for ordinary unfinished work.`,
    inputSchema: z.object({
      goal_id: goalId,
      reason: z.string().min(1).max(1_000).describe("Why the goal is waiting and which external event should wake it."),
      resume_after_ms: z
        .number()
        .int()
        .min(1)
        .max(MAX_WAIT_MS)
        .optional()
        .describe(
          `Optional safety deadline in milliseconds that requests one continuation if no wake message arrives. Values below ${MIN_WAIT_MS} are accepted but clamped to ${MIN_WAIT_MS}.`,
        ),
    }),
    execute: async (input, ctx) => {
      const { s, g } = owned(ctx, input.goal_id, "goal_wait");
      const reason = input.reason.trim();
      if (g.waiting) throw new Error("goal_wait rejected: goal is already waiting.");
      if (!reason) throw new Error("goal_wait rejected: reason is empty.");
      const requested = input.resume_after_ms;
      const effective = requested === undefined ? undefined : Math.max(MIN_WAIT_MS, requested);
      rtOf(s).ended = true;
      await save(ctx, s, {
        ...g,
        tokensUsed: used(s, g),
        waiting: { reason, ...(effective !== undefined && { resumeAt: Date.now() + effective }) },
      });
      return effective !== requested
        ? `Goal waiting: ${reason}\nRequested resume_after_ms ${requested} was clamped to ${effective}.`
        : `Goal waiting: ${reason}`;
    },
  }),
];

async function loadSettings(): Promise<Settings> {
  let file: Partial<Settings>;
  try {
    file = JSON.parse(await readFile(join(hortusDir(), "goal.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return DEFAULTS;
    throw new Error(`~/.hortus/goal.json ignored: ${e instanceof Error ? e.message : String(e)}`);
  }
  const limit = (v: unknown, d: number | null) =>
    v === null || (typeof v === "number" && Number.isSafeInteger(v) && v > 0) ? v : d;
  return {
    continuationLimits: {
      automaticTurns: limit(file.continuationLimits?.automaticTurns, DEFAULTS.continuationLimits.automaticTurns),
      noProgressTurns: limit(file.continuationLimits?.noProgressTurns, DEFAULTS.continuationLimits.noProgressTurns),
    },
    rpc: { enabled: file.rpc?.enabled === true },
  };
}

/** `10k`, `1.5m`, `2000` → tokens; undefined if not a positive amount. */
export function parseTokenBudget(value: string) {
  const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(value.trim());
  if (!m) return undefined;
  const n = Math.floor(Number(m[1]) * (m[2]?.toLowerCase() === "m" ? 1e6 : m[2]?.toLowerCase() === "k" ? 1e3 : 1));
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Splits on whitespace, keeping quoted parts together (quotes dropped). */
const tokenize = (s: string) =>
  [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "").filter(Boolean);

/** `[--tokens <budget>] <objective>` */
function objectiveArgs(words: string[], usage: string) {
  if (words[0] !== "--tokens") return { objective: words.join(" ") };
  const raw = words[1];
  if (!raw) throw new Error(`Usage: ${usage} --tokens 100k <goal_to_complete>`);
  const tokenBudget = parseTokenBudget(raw);
  if (tokenBudget === undefined) throw new Error(`Invalid token budget: ${raw}`);
  if (words.length < 3) throw new Error(`Usage: ${usage} <goal_to_complete>`);
  return { objective: words.slice(2).join(" "), tokenBudget };
}

/** `/goal`'s argument, run with the host ctx (the current session). */
export async function goalCommand(ctx: Ctx, arg: string): Promise<string> {
  const [first, ...rest] = tokenize(arg);
  const bare = (usage: string) => {
    if (rest.length) throw new Error(`Usage: /goal ${usage}`);
  };
  const s = sessionOf(ctx);
  const limit = settings.continuationLimits.automaticTurns;
  switch (first) {
    case undefined:
    case "status": {
      bare("status");
      const g = goalOf(s.getState());
      return g ? summary(g, limit) : "No goal. Start one with /goal <objective>";
    }
    case "pause":
      bare("pause");
      await pauseGoal(ctx);
      return "Goal paused";
    case "resume": {
      bare("resume");
      const waiting = goalOf(s.getState())?.status === "active";
      await resumeGoal(ctx);
      return waiting ? "Goal woken" : `Goal resumed (automatic work ${limit === null ? "Unlimited" : `0/${limit}`})`;
    }
    case "clear":
    case "stop":
      bare("clear");
      await clearGoal(ctx);
      return "Goal cleared";
    case "edit": {
      const { objective, tokenBudget } = objectiveArgs(rest, "/goal edit");
      const g = await editGoal(ctx, objective, tokenBudget);
      return g.status === "active" ? "Goal updated" : `Goal updated (still ${g.status})`;
    }
    default: {
      const { objective, tokenBudget } = objectiveArgs([first, ...rest], "/goal");
      const old = goalOf(s.getState());
      // as Pi does, asks before replacing an unfinished goal; no one to ask keeps it
      if (unfinished(old)) {
        const answer = await ctx.ask({
          question: `Replace the unfinished goal (${old.status}): ${old.text}`,
          options: [{ label: "Keep" }, { label: "Replace" }],
        });
        if (answer !== "Replace") throw new Error("Kept the unfinished goal: /goal edit it, or /goal clear it first");
        await clearGoal(ctx);
      }
      await startGoal(ctx, objective, tokenBudget);
      return "Goal started";
    }
  }
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const isContract = (m: Message): m is UserMessage =>
  m.role === "user" && m.meta?.plugin === "goal" && m.meta.type === "contract";

/**
 * Pi's pi-goal: `/goal <objective>` sets a session goal the agent keeps working on across runs (a continuation prompt is
 * sent at `idle` after each run that ends with the goal still active) until the model calls `goal_complete` (with the
 * goal's id and evidence), `goal_blocked` or `goal_wait`, the token budget (`--tokens`) is spent, a safety limit
 * pauses it (`goal.json`: automatic responses, repeated tool-free output), or it is paused, aborted or cleared. The goal
 * is a `goal:state` entry, so it is per branch and resuming keeps it (quiet until the next message). Other plugins drive
 * it over `goal:start` / `goal:cancel` and hear `goal:event`, when `rpc.enabled`.
 */
export default {
  tools,
  entries: {
    state: (entry: PluginEntry<Goal | null>, state) => {
      state.data.goal = entry.data ?? undefined;
    },
  },
  on: {
    init: async () => {
      settings = DEFAULTS;
      settings = await loadSettings();
    },
    session_open: async ({ session: s }, ctx) => {
      const g = goalOf(s.getState());
      const limit = settings.continuationLimits.automaticTurns;
      if (g?.status === "active" && limit !== null && g.automaticTurns >= limit)
        await save(ctx, s, {
          ...halt(g, "paused", `continuation_limit (${g.automaticTurns} of ${limit} automatic model responses)`),
          safetyPause: "continuation_limit",
        });
      else schedule(ctx, s);
    },
    session_close: ({ session: s }) => {
      clearTimeout(rtOf(s).timer);
    },
    input: async (p, ctx) => {
      const s = ctx.session;
      if (!s) return;
      const g = goalOf(s.getState());
      if (p.source === KICK || p.source === CONTINUE) {
        // a goal prompt sent for a goal since replaced, stopped or cleared
        if (g?.status !== "active" || (p.meta?.details as { goalId?: string } | undefined)?.goalId !== g.id)
          p.handled = true;
        return;
      }
      if (g?.status !== "active") return;
      // any other message wakes a waiting goal; the user's own starts a new safety epoch
      const next = p.source === "user" ? epoch({ ...g, waiting: undefined }) : { ...g, waiting: undefined };
      if (g.waiting || p.source === "user") await save(ctx, s, next);
    },
    run_start: async (p, ctx) => {
      const s = ctx.session;
      if (p.source !== "run" || !s) return;
      const r = rtOf(s);
      const g = goalOf(s.getState());
      Object.assign(r, { start: new Set(p.messages.map((m) => m.entryId)), ended: false });
      r.goalId = g?.status === "active" ? g.id : undefined;
      const last = [...p.messages].reverse().find(isContract)?.content;
      const want = g?.status === "active" ? activeContract(g) : last !== undefined ? INACTIVE_CONTRACT : undefined;
      if (want !== undefined && want !== last)
        await ctx.send({ content: want, meta: { plugin: "goal", type: "contract" } });
    },
    // Pi's compaction recovery: the contract summarized away is sent again (from the next turn boundary in a run)
    compacted: async (_, ctx) => {
      const s = ctx.session;
      const g = s && goalOf(s.getState());
      if (!s || g?.status !== "active" || s.getState().messages.some(isContract)) return;
      await ctx.send({ content: activeContract(g), meta: { plugin: "goal", type: "contract" } });
    },
    turn_end: async (p, ctx) => {
      const s = ctx.session;
      if (!s) return;
      const r = rtOf(s);
      if (r.ended) {
        p.stop = true;
        return;
      }
      const g = goalOf(s.getState());
      if (g?.status !== "active" || g.id !== r.goalId) return;
      let next: Goal = {
        ...g,
        tokensUsed: used(s, g),
        automaticTurns: g.automaticTurns + (automatic(ctx) ? 1 : 0),
      };
      const limit = settings.continuationLimits.automaticTurns;
      if (over(next))
        next = halt(
          next,
          "budget_limited",
          `token budget reached (${formatTokens(next.tokensUsed)}/${formatTokens(next.tokenBudget ?? 0)})`,
        );
      else if (limit !== null && next.automaticTurns >= limit)
        next = {
          ...halt(next, "paused", `continuation_limit (${next.automaticTurns} of ${limit} automatic model responses)`),
          safetyPause: "continuation_limit",
        };
      await save(ctx, s, next);
      if (next.status !== "active") p.stop = true;
    },
    run_end: async (p, ctx) => {
      const s = ctx.session;
      if (p.source !== "run" || !s) return;
      const r = rtOf(s);
      const { goalId, start = new Set() } = r;
      Object.assign(r, { goalId: undefined, ended: false });
      const g = goalOf(s.getState());
      if (g?.status !== "active" || g.id !== goalId) return;
      let next: Goal = { ...g, iteration: g.iteration + 1, tokensUsed: used(s, g) };
      if (p.aborted)
        next = halt(next, "paused", `interrupted by ${p.aborted.by}${p.aborted.reason ? `: ${p.aborted.reason}` : ""}`);
      // ponytail: Pi tells usage limits (stopped) from other provider errors (waiting); every error waits here
      else if (p.error)
        next = {
          ...next,
          waiting: { reason: `provider error: ${p.error instanceof Error ? p.error.message : String(p.error)}` },
        };
      else if (!next.waiting) {
        if (automatic(ctx)) {
          const ran = p.messages.filter((m) => !start.has(m.entryId));
          if (ran.some((m) => m.role === "assistant" && m.toolCalls.length > 0))
            next = { ...next, toolFreeRepeats: 0, lastFingerprint: undefined };
          else {
            const f = fingerprint(ran);
            next = {
              ...next,
              toolFreeRepeats: f === g.lastFingerprint ? g.toolFreeRepeats + 1 : 1,
              lastFingerprint: f,
            };
          }
          const limit = settings.continuationLimits.noProgressTurns;
          if (limit !== null && next.toolFreeRepeats >= limit)
            next = {
              ...halt(next, "paused", `no_progress (no progress across ${next.toolFreeRepeats} automatic runs)`),
              safetyPause: "no_progress",
            };
        }
        r.continue = next.status === "active";
      }
      await save(ctx, s, next);
    },
    idle: ({ session: s }, ctx) => {
      const r = rtOf(s);
      const g = goalOf(s.getState());
      if (r.continue && g?.status === "active" && !g.waiting) kick(ctx, g, continuePrompt(g), CONTINUE);
      r.continue = false;
      schedule(ctx, s);
    },
    "goal:start": async (p, ctx) => {
      const { runId } = p;
      if (typeof runId !== "string" || !RUN_ID.test(runId)) return;
      const fail = (code: string, message: string) =>
        ctx.emit("goal:event", { type: "error", runId, operation: "start", error: { code, message } });
      const s = ctx.session;
      if (!s) return fail("NO_ACTIVE_SESSION", "No session to start the goal in.");
      if (!settings.rpc.enabled) return fail("RPC_DISABLED", "Managed run RPC is disabled.");
      const r = rtOf(s);
      if (r.runIds.has(runId)) return fail("RUN_ID_IN_USE", "runId was already used in this session.");
      if (typeof p.objective !== "string") return fail("INVALID_REQUEST", "objective must be a string");
      if (p.tokenBudget !== undefined && !(Number.isSafeInteger(p.tokenBudget) && p.tokenBudget > 0))
        return fail("INVALID_REQUEST", "tokenBudget must be a positive integer");
      if (unfinished(goalOf(s.getState())) || r.managed) return fail("GOAL_ALREADY_EXISTS", "A Goal already exists.");
      r.runIds.add(runId);
      try {
        await startGoal(ctx, p.objective, p.tokenBudget, runId);
      } catch (e) {
        r.managed = undefined;
        await fail("ACTIVATION_FAILED", `Goal activation failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    "goal:cancel": async (p, ctx) => {
      const s = ctx.session;
      const m = s && rtOf(s).managed;
      if (!m || m.runId !== p.runId)
        return ctx.emit("goal:event", {
          type: "error",
          runId: p.runId,
          operation: "cancel",
          error: { code: "RUN_NOT_FOUND", message: "No active managed run matches runId." },
        });
      await pauseGoal(ctx, p.reason?.trim() || "goal cancelled by managed run");
    },
  },
  commands: [
    {
      name: "goal",
      args: "[status | pause | resume | clear | edit [--tokens <n>] <objective> | [--tokens <n>] <objective>]",
      description: "Keep working toward an objective across runs until it is done",
      complete: () => [
        { value: "status", description: "Show the current goal" },
        { value: "pause", description: "Pause the active goal" },
        { value: "resume", description: "Resume a stopped or waiting goal" },
        { value: "clear", description: "Clear the current goal" },
        { value: "edit ", label: "edit", description: "Edit the current goal objective" },
        { value: "--tokens ", label: "--tokens", description: "Set a token budget before the goal" },
      ],
      run: (arg, ctx) => goalCommand(ctx, arg),
    },
  ],
  cli: {
    // its prompts, which Pi shows as user messages: one line each, the first of its text
    entries: { "goal:prompt": goalLine("goal"), "goal:contract": goalLine("goal contract") },
  },
} satisfies CliPlugin;

/** A goal message as one dim line: `label`, then its first line of text. */
function goalLine(label: string): EntryRenderer {
  return {
    // biome-ignore lint/correctness/noComponentHookFactories: made once per label, at load
    Render: ({ entry }) => (
      <Text wrap="truncate-end">
        <Text color={theme.accent}>{`◆ ${label} `}</Text>
        <Text color={theme.dim}>{entry.text.trim().split("\n")[0]}</Text>
      </Text>
    ),
  };
}
