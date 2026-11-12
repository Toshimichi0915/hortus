import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CompactEvent,
  type CompactionData,
  type Ctx,
  hortusDir,
  type Message,
  type Plugin,
  type PluginEntry,
  type Session,
  tool,
} from "@hortus/core";
import { z } from "zod";
import {
  applyTailBudget,
  type BudgetCutKind,
  buildOwnCut,
  buildPiVccCustomInstructions,
  calibrateCharsPerToken,
  estimateTokensFromChars,
  isSkippedCustom,
  messageChars,
  parseCompactionInstructions,
  parseKeepAndPrompt,
  resolveSmartKeepUserTurns,
} from "./cut.ts";
import { extractPaths, type FileOps } from "./extract.ts";
import {
  buildGlobalIndexById,
  normalizeToolParams,
  openRecallView,
  parseCommandRequest,
  parseToolRequest,
  type RecallPagingHints,
  type RecallSource,
  type RecallToolParams,
  runRecall,
} from "./recall.ts";
import { compileRanked } from "./summarize.ts";

// ── core/settings.ts: `~/.hortus/vcc.json` ──

export interface VccSettings {
  /** true (default): pi-vcc writes every compaction (automatic and `/compact`); false: only `/pi-vcc`'s */
  overrideDefaultCompaction: boolean;
  /** if the keep:1 tail is under 5k tokens, keep as many turns as fit in 25k (an explicit keep:N is respected) */
  smartKeepTail: boolean;
  /** providers (secrets.json name or type, any case) pi-vcc steps aside for; `/pi-vcc` always runs */
  skipForProviders: string[];
  /** plugin messages left out of the summary, by `<plugin>:<type>` or `<type>` of their `meta` */
  skipCustomTypes: string[];
  /** commands remembered in a [Tracked Commands] section, e.g. `["ssh", "kubectl", "gh pr"]` */
  trackCommands: string[];
}

export const DEFAULT_SETTINGS: VccSettings = {
  overrideDefaultCompaction: true,
  smartKeepTail: true,
  skipForProviders: [],
  skipCustomTypes: [],
  trackCommands: [],
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The settings, read at each compaction (so edits apply at once); a missing or invalid file gives the defaults. */
export async function loadSettings(): Promise<VccSettings> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(join(hortusDir(), "vcc.json"), "utf8"));
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  return {
    ...DEFAULT_SETTINGS,
    ...(typeof parsed.overrideDefaultCompaction === "boolean" && {
      overrideDefaultCompaction: parsed.overrideDefaultCompaction,
    }),
    ...(typeof parsed.smartKeepTail === "boolean" && { smartKeepTail: parsed.smartKeepTail }),
    skipForProviders: strings(parsed.skipForProviders),
    skipCustomTypes: strings(parsed.skipCustomTypes),
    // blank names would match every command; duplicates would repeat lines
    trackCommands: [...new Set(strings(parsed.trackCommands).map((s) => s.trim()))].filter(Boolean),
  };
}

// ── session entries ──

/**
 * Every entry of the session in file order (all branches: recall's `scope: "all"` and the global `#N` index), and its
 * current branch.
 */
export const recallSource = async (session: Session): Promise<RecallSource> => ({
  all: await session.allEntries(),
  branch: session.entries(),
});

// ── hooks/before-compact.ts ──

export interface CompactionStats {
  summarized: number;
  kept: number;
  keptUserTurns: number;
  totalUserTurns: number;
  budgetCut?: BudgetCutKind;
  keptTokensEst: number;
  smartKeepAdjusted?: boolean;
}

export interface VccDetails {
  compactor: "pi-vcc";
  /** 2: refs are session-global (recall's `#N`) */
  version: number;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  reason: CompactEvent["reason"];
  willRetry: boolean;
}

const formatTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export const formatCompactionStats = (stats: CompactionStats): string => {
  if (stats.budgetCut) {
    const reason = stats.budgetCut === "no_anchor" ? "no user anchor" : "oversized tail";
    return `pi-vcc: kept ~${formatTokens(stats.keptTokensEst)} tok tail (mid-turn cut, ${reason}), summarized ${stats.summarized}.`;
  }
  const notes = [`summarized ${stats.summarized}`, ...(stats.smartKeepAdjusted ? ["smart-keep"] : [])];
  return `pi-vcc: kept ${stats.keptUserTurns}/${stats.totalUserTurns} turns, ~${formatTokens(stats.keptTokensEst)} tok (${notes.join(", ")}).`;
};

const REASON_MESSAGES = {
  no_live_messages: "pi-vcc: Nothing to compact (no live messages)",
  too_few_live_messages: "pi-vcc: Too few messages to compact",
};

/** What a compaction left for `compacted` and `/pi-vcc`: its stats, and a prompt to send after it (`/compact <text>`). */
interface Pending {
  isPiVcc: boolean;
  stats: CompactionStats;
  followUpPrompt: string | null;
}
const pending = (ctx: Ctx) => {
  ctx.state.pending ??= new WeakMap<Session, Pending>();
  return ctx.state.pending as WeakMap<Session, Pending>;
};

/** Files the calls in `messages` read and changed, as Pi's `fileOps` (ranking's structural signal). */
const fileOpsOf = (messages: readonly Message[]): FileOps => {
  const calls = messages.flatMap((m) => (m.role === "assistant" ? m.toolCalls : []));
  const paths = (re: RegExp) =>
    calls.flatMap((c) => (re.test(c.name) ? extractPaths((c.input ?? {}) as Record<string, unknown>) : []));
  return { readFiles: paths(/^read$/i), modifiedFiles: paths(/^(write|edit)$/i) };
};

/** The provider a compaction runs for: the run's, else the session's (`ctx.resolve`). */
const providerOf = async (ctx: Ctx) => ctx.run ?? (await ctx.resolve().catch(() => undefined));

/**
 * The `compact` handler: pi-vcc's own cut (`firstKeptId`) and its algorithmic summary (no model call). A cut that finds
 * nothing to compact cancels, except an automatic overflow (not `/pi-vcc`), left to builtin:compaction's model summary.
 */
async function compact(p: CompactEvent, ctx: Ctx) {
  const session = ctx.session;
  if (p.summary !== undefined || p.cancel || !session) return;
  const settings = await loadSettings();
  const { isPiVcc, keepUserTurns, keepUserTurnsExplicit, followUpPrompt } = parseCompactionInstructions(p.instructions);
  pending(ctx).delete(session);
  if (!isPiVcc && !settings.overrideDefaultCompaction) return;
  // provider-level opt-out, checked each time (the model can change mid-session); /pi-vcc bypasses it
  if (!isPiVcc && settings.skipForProviders.length) {
    const run = await providerOf(ctx);
    const ids = [run?.provider, run?.type].filter((x): x is string => !!x).map((x) => x.toLowerCase());
    if (settings.skipForProviders.some((s) => ids.includes(s.toLowerCase()))) return;
  }
  // every message after the previous summary, as builtin:compaction snapshotted them
  const live = p.all;

  const calibrationChars = live.reduce((n, m) => n + messageChars(m), 0) + (p.previousSummary?.length ?? 0);
  const charsPerToken = calibrateCharsPerToken(calibrationChars, p.tokensBefore);
  const smartKeep = resolveSmartKeepUserTurns({
    live,
    requestedKeepUserTurns: keepUserTurnsExplicit ? keepUserTurns : null,
    explicit: keepUserTurnsExplicit,
    smartKeepTail: settings.smartKeepTail,
    charsPerToken,
  });
  let cut = buildOwnCut(live, smartKeep.keepUserTurns, settings.skipCustomTypes);
  // default path only: rescue autonomous / oversized-tail sessions with a token-budget cut
  if (cut.ok && !keepUserTurnsExplicit)
    cut = applyTailBudget(live, cut, { charsPerToken, skipCustomTypes: settings.skipCustomTypes });
  if (!cut.ok) {
    if (!isPiVcc && p.reason === "overflow") return;
    await ctx.notify(REASON_MESSAGES[cut.reason], "warn");
    p.cancel = true;
    return;
  }

  // what the summary reads leaves out skipCustomTypes; the cut above is fixed already
  const messages = cut.messages.filter((m) => !isSkippedCustom(m, settings.skipCustomTypes));
  // refs are session-global `#N`s, the numbers recall uses
  const globalIndex = buildGlobalIndexById((await recallSource(session)).all);
  const sourceIndices = messages.map((m) => (m.entryId === undefined ? undefined : globalIndex.get(m.entryId)));

  // a size-relative token budget for the brief, converted to chars by the calibrated ratio
  const summary = compileRanked({
    messages,
    sourceIndices,
    previousSummary: p.previousSummary,
    fileOps: fileOpsOf(messages),
    trackCommands: settings.trackCommands,
    ranking: {
      maxBriefChars: Math.round(1100 * charsPerToken),
      maxBriefCharsCeiling: Math.round(2000 * charsPerToken),
      briefCharsPerBlock: Math.round(15 * charsPerToken),
    },
  });

  const kept = cut.firstKeptId === undefined ? [] : live.slice(cut.messages.length);
  pending(ctx).set(session, {
    isPiVcc,
    followUpPrompt,
    stats: {
      summarized: messages.length,
      kept: kept.length,
      keptUserTurns: cut.keptUserTurns,
      totalUserTurns: cut.totalUserTurns,
      ...(cut.budgetCut && { budgetCut: cut.budgetCut }),
      keptTokensEst: estimateTokensFromChars(
        kept.reduce((n, m) => n + messageChars(m), 0),
        charsPerToken,
      ),
      smartKeepAdjusted: smartKeep.smartAdjusted,
    },
  });
  p.firstKeptId = cut.firstKeptId;
  p.summary = summary;
  p.details = {
    compactor: "pi-vcc",
    version: 2,
    sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1] as string),
    sourceMessageCount: messages.length,
    previousSummaryUsed: Boolean(p.previousSummary),
    reason: p.reason,
    willRetry: p.reason === "overflow",
  } satisfies VccDetails;
}

// ── tools/recall.ts, commands/vcc-recall.ts ──

const scopeArg = (scope: string) => (scope === "all" ? " scope:all" : "");

const TOOL_PAGING_HINTS: RecallPagingHints = {
  outOfRange: (_query, _scope, totalPages, truncated) =>
    truncated
      ? `Use a page between 1 and ${totalPages}.`
      : `Use a page between 1 and ${totalPages}, or refine your query.`,
  nextPage: (_query, scope, page) =>
    `\n--- Use page:${page}${scope === "all" ? " with scope:'all'" : ""} for more results ---`,
  skipCurrentTurn: true,
  aroundHit: (n, scope) =>
    `\n--- Read around a hit: range:[${Math.max(0, n - 3)}, ${n + 3}]; full text: expand:[${n}]${scope === "all" ? " (with scope:'all')" : ""} ---`,
};

const COMMAND_PAGING_HINTS: RecallPagingHints = {
  outOfRange: (query, scope, totalPages, truncated) =>
    `Use /pi-vcc-recall ${query}${scopeArg(scope)} page:N with N between 1 and ${totalPages}` +
    (truncated ? "." : ", or refine your query."),
  nextPage: (query, scope, page) => `\n--- /pi-vcc-recall ${query}${scopeArg(scope)} page:${page} ---`,
};

/** What the model is told the parameters are; the tool repairs and checks them itself (`normalizeToolParams`). */
const RecallParams = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works. '#N:path' instead shows a file's content from entry N.",
    ),
  range: z
    .array(z.number())
    .min(2)
    .max(2)
    .optional()
    .describe(
      "[from, to]: every entry from #from to #to (inclusive) in order, 20 per page. #N is the number in summary refs like (#12) and in recall results.",
    ),
  expand: z
    .array(z.number())
    .optional()
    .describe("#N indices to return full content for (from summary refs like (#12) or recall results)."),
  page: z.number().optional().describe("Page number (1-based) for query, range or touched results. Default: 1."),
  scope: z
    .enum(["lineage", "all"])
    .optional()
    .describe(
      "Default 'lineage' covers the active conversation path. Use 'all' to also reach messages from other branches, such as turns that were edited or retried.",
    ),
  mode: z
    .enum(["hybrid", "touched"])
    .optional()
    .describe(
      "hybrid (default) = normal recall; touched = files worked on, by path, with entry indices. The touched list misses files written via bash redirects.",
    ),
});

const recallTool = tool({
  name: "vcc_recall",
  description: [
    "Recall earlier parts of this session, including anything dropped by compaction.",
    "Use it before saying the context is gone.",
    "",
    "Pick one per call:",
    "- query: keyword search (regex works), 5 results per page.",
    "- range: [from, to]: entries #from..#to in order, 20 per page.",
    "- expand: [N, ...]: full text of those entries.",
    "- mode: 'touched': files worked on, with entry indices.",
    "- query '#N:path': file content from entry N ('#N:path:full' for all lines).",
    "",
    "Add to any of them:",
    "- page: next page of query, range or touched results.",
    "- scope: 'lineage' (default) reads the current conversation path; 'all' also",
    "  reads edited or retried branches.",
    "",
    "#N is the number shown in summary refs like (#12) and in recall results.",
    "Only the current session is searchable. One result is capped at 50 KB.",
  ].join("\n"),
  prompt:
    "Use vcc_recall to recall earlier parts of this session before saying the context is gone. " +
    "One per call: query (search), range:[from, to] (entries in order), expand:[N] (full text), " +
    "mode:'touched' (files). #N is the number in summary refs like (#12).",
  // repairable mistakes (strings for numbers, "10-20" ranges, wrong case) are fixed, not rejected
  inputSchema: z.looseObject({}),
  jsonSchema: z.toJSONSchema(RecallParams),
  execute: async (input, ctx) => {
    if (!ctx.session) return "No session available.";
    const request = parseToolRequest(normalizeToolParams(input) as RecallToolParams);
    const view = openRecallView(await recallSource(ctx.session), request.scope, ctx.cwd);
    return runRecall(request, view, TOOL_PAGING_HINTS);
  },
});

/**
 * pi-vcc: an algorithmic compactor (no model call). builtin:compaction still decides when to compact and saves the
 * entry; this plugin's `compact` handler picks the cut (the last user turn, grown or budget-cut) and writes the
 * summary: [Early Session Requests], [Files And Changes], [Commits], [Tracked Commands], [User Messages] and a ranked
 * brief transcript with `(#N)` refs, merged with the previous summary. `vcc_recall` reads what was compacted away.
 */
export default {
  tools: [recallTool],
  on: {
    compact,
    compacted: async ({ entry: { data }, reason }, ctx) => {
      if ((data.details as VccDetails | undefined)?.compactor !== "pi-vcc" || !ctx.session) return;
      const p = pending(ctx).get(ctx.session);
      // /pi-vcc reports its own; an overflow's retry follows at once
      if (!p || p.isPiVcc || reason === "overflow") return;
      pending(ctx).delete(ctx.session);
      await ctx.notify(formatCompactionStats(p.stats));
      // not awaited: it resolves when the run it starts ends
      if (p.followUpPrompt) void ctx.send(p.followUpPrompt, { deliver: "after" });
    },
  },
  commands: [
    {
      name: "pi-vcc",
      args: "[keep:N] [prompt]",
      description: "Compact conversation with pi-vcc structured summary",
      run: async (arg, ctx) => {
        const { followUpPrompt, keepUserTurns } = parseKeepAndPrompt(arg);
        let saved: PluginEntry<CompactionData> | undefined;
        let why: string | undefined;
        await ctx.emit("compact_request", {
          instructions: buildPiVccCustomInstructions(keepUserTurns),
          done: (e, reason) => {
            saved = e;
            why = reason;
          },
        });
        if (!saved || !ctx.session) return why ?? "Nothing to compact";
        const p = pending(ctx).get(ctx.session);
        pending(ctx).delete(ctx.session);
        if (followUpPrompt) void ctx.send(followUpPrompt, { deliver: "after" });
        return p ? formatCompactionStats(p.stats) : "Compacted with pi-vcc";
      },
    },
    {
      name: "pi-vcc-recall",
      args: "<query> [scope:all] [page:N]",
      description:
        "Recall earlier parts of this session. Plain keywords work best; add scope:all to reach edited or retried turns.",
      run: async (arg, ctx) => {
        if (!ctx.session) return "No session available.";
        const request = parseCommandRequest(arg);
        const view = openRecallView(await recallSource(ctx.session), request.scope, ctx.cwd);
        const content = runRecall(request, view, COMMAND_PAGING_HINTS);
        void ctx.send({ content, meta: { plugin: ctx.plugin, type: "recall" } }, { deliver: "after" });
      },
    },
  ],
} satisfies Plugin;
