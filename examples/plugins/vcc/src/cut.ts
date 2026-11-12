/**
 * pi-vcc's own cut (keep the last N user turns, smart keep-tail, token-budget rescue), its token estimate and its
 * `/pi-vcc` arguments; ported from @sting8k/pi-vcc 0.11.2 (MIT) `hooks/before-compact.ts`, `core/token-estimate.ts` and
 * `core/compact-args.ts`. Pi's branch entries become the session's live messages (each with its `entryId`): hortus
 * already replays a compaction into them, so pi-vcc's own walk back to the last compaction isn't needed.
 */
import type { Message } from "@hortus/core";
import { normalize } from "./summarize.ts";

// ── core/token-estimate.ts ──

export const DEFAULT_CHARS_PER_TOKEN = 4;
export const MIN_CHARS_PER_TOKEN = 2;
export const MAX_CHARS_PER_TOKEN = 6;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const calibrateCharsPerToken = (sourceChars: number, sourceTokens: number | undefined): number => {
  if (!sourceTokens || sourceTokens <= 0 || sourceChars <= 0) return DEFAULT_CHARS_PER_TOKEN;
  const raw = sourceChars / sourceTokens;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CHARS_PER_TOKEN;
  return clamp(raw, MIN_CHARS_PER_TOKEN, MAX_CHARS_PER_TOKEN);
};

export const estimateTokensFromChars = (chars: number, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number =>
  Math.ceil(chars / charsPerToken);

/** Chars attributed to one image, as Pi's (and hortus's) estimate: ~1200 tokens at 4 chars/token. */
export const IMAGE_CONTENT_CHARS = 4800;

/** A message's size in chars: text, tool calls (name + input JSON), results, images. */
export const messageChars = (m: Message): number => {
  if (m.role === "user") return m.content.length + (m.images?.length ?? 0) * IMAGE_CONTENT_CHARS;
  if (m.role === "tool")
    return m.results.reduce((n, r) => n + r.output.length + (r.images?.length ?? 0) * IMAGE_CONTENT_CHARS, 0);
  return (
    m.text.length + m.toolCalls.reduce((n, c) => n + c.name.length + (JSON.stringify(c.input ?? "") ?? "").length, 0)
  );
};

export const messageTokens = (m: Message, charsPerToken?: number) =>
  estimateTokensFromChars(messageChars(m), charsPerToken);

// ── core/compact-args.ts ──

export const PI_VCC_COMPACT_INSTRUCTION = "__pi_vcc__";
const KEEP_TOKEN_RE = /^keep:(\d+)$/;

export interface ParsedCompactionArgs {
  followUpPrompt: string;
  keepUserTurns: number | null;
  keepUserTurnsExplicit: boolean;
}

const parseKeepUserTurns = (raw: string): number => {
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
};

export const parseKeepAndPrompt = (args?: string): ParsedCompactionArgs => {
  const trimmed = args?.trim() ?? "";
  if (!trimmed) return { followUpPrompt: "", keepUserTurns: null, keepUserTurnsExplicit: false };
  const startMatch = trimmed.match(/^keep:(\d+)(?:\s+|$)([\s\S]*)$/);
  if (startMatch)
    return {
      followUpPrompt: startMatch[2].trim(),
      keepUserTurns: parseKeepUserTurns(startMatch[1]),
      keepUserTurnsExplicit: true,
    };
  const parts = trimmed.split(/\s+/);
  const endMatch = parts[parts.length - 1].match(KEEP_TOKEN_RE);
  if (endMatch)
    return {
      followUpPrompt: trimmed.slice(0, trimmed.length - parts[parts.length - 1].length).trim(),
      keepUserTurns: parseKeepUserTurns(endMatch[1]),
      keepUserTurnsExplicit: true,
    };
  return { followUpPrompt: trimmed, keepUserTurns: null, keepUserTurnsExplicit: false };
};

export const buildPiVccCustomInstructions = (keepUserTurns: number | null): string =>
  keepUserTurns == null ? PI_VCC_COMPACT_INSTRUCTION : `${PI_VCC_COMPACT_INSTRUCTION} keep:${keepUserTurns}`;

/** `/pi-vcc`'s marker (always pi-vcc's), else `/compact <text>`: a `keep:N` and a prompt to send afterwards. */
export const parseCompactionInstructions = (
  customInstructions?: string,
): { isPiVcc: boolean; keepUserTurns: number; keepUserTurnsExplicit: boolean; followUpPrompt: string | null } => {
  const trimmed = customInstructions?.trim();
  if (trimmed === PI_VCC_COMPACT_INSTRUCTION)
    return { isPiVcc: true, keepUserTurns: 1, keepUserTurnsExplicit: false, followUpPrompt: null };
  const keepPrefix = `${PI_VCC_COMPACT_INSTRUCTION} `;
  if (trimmed?.startsWith(keepPrefix)) {
    const parsed = parseKeepAndPrompt(trimmed.slice(keepPrefix.length));
    return {
      isPiVcc: true,
      keepUserTurns: parsed.keepUserTurns ?? 1,
      keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
      followUpPrompt: null,
    };
  }
  const parsed = parseKeepAndPrompt(customInstructions);
  return {
    isPiVcc: false,
    keepUserTurns: parsed.keepUserTurns ?? 1,
    keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
    followUpPrompt: parsed.followUpPrompt || null,
  };
};

// ── hooks/before-compact.ts: the cut ──

export type BudgetCutKind = "no_anchor" | "oversized_tail";
export const OVERSIZED_TAIL_FACTOR = 2.5;
export const MIN_SMART_TAIL_TOKENS = 5_000;
export const MAX_SMART_TAIL_TOKENS = 25_000;

/** A plugin message whose `meta` the user listed in `skipCustomTypes` (`<plugin>:<type>` or just `<type>`). */
export const isSkippedCustom = (m: Message, skipCustomTypes: readonly string[]): boolean =>
  m.role === "user" &&
  !!m.meta &&
  (skipCustomTypes.includes(m.meta.type) || skipCustomTypes.includes(`${m.meta.plugin}:${m.meta.type}`));

/** True when the prefix would contribute at least one block to the summary. */
const prefixHasRenderableContent = (prefix: readonly Message[], skipCustomTypes: readonly string[]): boolean =>
  normalize(prefix.filter((m) => !isSkippedCustom(m, skipCustomTypes))).length > 0;

export type OwnCutCancelReason = "no_live_messages" | "too_few_live_messages";

export type OwnCutResult =
  | {
      ok: true;
      /** what the summary replaces */
      messages: Message[];
      /** none: compact everything (Pi's "" sentinel) */
      firstKeptId: string | undefined;
      compactAll: boolean;
      keptUserTurns: number;
      totalUserTurns: number;
      requestedKeepUserTurns: number;
      keepFallbackToCompactAll: boolean;
      budgetCut?: BudgetCutKind;
    }
  | { ok: false; reason: OwnCutCancelReason };

const normalizeKeepUserTurns = (keepUserTurns: number): number =>
  Number.isFinite(keepUserTurns) ? Math.max(0, Math.floor(keepUserTurns)) : 0;

/** Summarize everything before the last `keepUserTurns` user turns of `live` (the session's messages after its summary). */
export function buildOwnCut(
  live: readonly Message[],
  keepUserTurns = 1,
  skipCustomTypes: readonly string[] = [],
): OwnCutResult {
  const normalizedKeepUserTurns = normalizeKeepUserTurns(keepUserTurns);
  if (live.length === 0) return { ok: false, reason: "no_live_messages" };
  if (live.length <= 2) return { ok: false, reason: "too_few_live_messages" };
  // A window with nothing renderable compiles to "" whichever cut is chosen: nothing to compact.
  if (!prefixHasRenderableContent(live, skipCustomTypes)) return { ok: false, reason: "no_live_messages" };

  const userIndices = live.reduce<number[]>((acc, m, i) => {
    if (m.role === "user") acc.push(i);
    return acc;
  }, []);
  const compactAll = (keepFallbackToCompactAll: boolean): OwnCutResult => ({
    ok: true,
    messages: [...live],
    firstKeptId: undefined,
    compactAll: true,
    keptUserTurns: 0,
    totalUserTurns: userIndices.length,
    requestedKeepUserTurns: normalizedKeepUserTurns,
    keepFallbackToCompactAll,
  });

  if (normalizedKeepUserTurns <= 0) return compactAll(false);
  const targetUserIdx = userIndices.length - normalizedKeepUserTurns;
  const cutIdx = targetUserIdx >= 0 ? userIndices[targetUserIdx] : -1;
  // no safe boundary (single user prompt, none, or keep larger than the turns): compact everything, keep no tail
  if (cutIdx <= 0) return compactAll(true);
  // a prefix rendering nothing would store an empty summary and never shrink the context
  if (!prefixHasRenderableContent(live.slice(0, cutIdx), skipCustomTypes)) return compactAll(true);
  return {
    ok: true,
    messages: live.slice(0, cutIdx),
    firstKeptId: live[cutIdx].entryId,
    compactAll: false,
    keptUserTurns: userIndices.length - targetUserIdx,
    totalUserTurns: userIndices.length,
    requestedKeepUserTurns: normalizedKeepUserTurns,
    keepFallbackToCompactAll: false,
  };
}

/**
 * Token-budget tail cut: walk back to `maxTokens`, then snap forward off any tool message to the next valid
 * boundary (mirroring Pi's findCutPoint).
 */
export const findBudgetCutIndex = (live: readonly Message[], maxTokens: number, charsPerToken?: number): number => {
  let acc = 0;
  let crossed = -1;
  for (let i = live.length - 1; i >= 0; i--) {
    acc += messageTokens(live[i], charsPerToken);
    if (acc >= maxTokens) {
      crossed = i;
      break;
    }
  }
  if (crossed < 0) return -1;
  for (let j = Math.max(crossed, 1); j < live.length; j++) if (live[j].role !== "tool") return j;
  return -1;
};

/**
 * Rescues default-path cuts: no user anchor (an autonomous run: compact-all) or an oversized kept tail (one giant last
 * turn) are re-cut to a token budget. Explicit `keep:0` stays compact-all.
 */
export const applyTailBudget = (
  live: readonly Message[],
  cut: OwnCutResult,
  opts: {
    maxTokens?: number;
    oversizedFactor?: number;
    charsPerToken?: number;
    skipCustomTypes?: readonly string[];
  } = {},
): OwnCutResult => {
  if (!cut.ok) return cut;
  const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
  const factor = opts.oversizedFactor ?? OVERSIZED_TAIL_FACTOR;
  const renders = (idx: number) => prefixHasRenderableContent(live.slice(0, idx), opts.skipCustomTypes ?? []);
  const budgetResult = (idx: number, budgetCut: BudgetCutKind): OwnCutResult => ({
    ok: true,
    messages: live.slice(0, idx),
    firstKeptId: live[idx].entryId,
    compactAll: false,
    keptUserTurns: live.slice(idx).filter((m) => m.role === "user").length,
    totalUserTurns: live.filter((m) => m.role === "user").length,
    requestedKeepUserTurns: cut.requestedKeepUserTurns,
    keepFallbackToCompactAll: false,
    budgetCut,
  });

  // Case A: no user anchor → compact-all, re-cut to a token budget unless it came from an explicit keep:0
  if (cut.compactAll) {
    if (!cut.keepFallbackToCompactAll) return cut;
    const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
    if (idx < 0 || !renders(idx)) return cut;
    return budgetResult(idx, "no_anchor");
  }
  // Case B: oversized user-boundary tail, re-cut only past maxTokens * factor
  const tailStart = cut.messages.length;
  let tailTokens = 0;
  for (let i = tailStart; i < live.length; i++) tailTokens += messageTokens(live[i], opts.charsPerToken);
  if (tailTokens <= maxTokens * factor) return cut;
  const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
  if (idx <= tailStart) return cut;
  return budgetResult(idx, "oversized_tail");
};

/** Tail tokens for keep:N; null when keep would compact everything or cancel. */
const tailTokensForKeep = (live: readonly Message[], keepUserTurns: number, charsPerToken?: number): number | null => {
  const cut = buildOwnCut(live, keepUserTurns);
  if (!cut.ok || cut.compactAll) return null;
  const chars = live.slice(cut.messages.length).reduce((sum, m) => sum + messageChars(m), 0);
  return estimateTokensFromChars(chars, charsPerToken);
};

/**
 * The effective keep:N. Explicit keep:N is always respected; with `smartKeepTail`, a keep:1 tail at most `minTokens`
 * grows to the largest N whose tail stays at most `maxTokens` (stopping at the compact-all boundary).
 */
export const resolveSmartKeepUserTurns = (opts: {
  live: readonly Message[];
  requestedKeepUserTurns: number | null;
  explicit: boolean;
  smartKeepTail: boolean;
  minTokens?: number;
  maxTokens?: number;
  charsPerToken?: number;
}): { keepUserTurns: number; smartAdjusted: boolean; fromKeep: number } => {
  const minTokens = opts.minTokens ?? MIN_SMART_TAIL_TOKENS;
  const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
  const baseKeep = opts.requestedKeepUserTurns ?? 1;
  const unchanged = { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
  if (opts.explicit || !opts.smartKeepTail) return unchanged;
  const baseTokens = tailTokensForKeep(opts.live, baseKeep, opts.charsPerToken);
  if (baseTokens == null || baseTokens > minTokens) return unchanged;
  const baseCut = buildOwnCut(opts.live, baseKeep);
  const totalUserTurns = baseCut.ok ? baseCut.totalUserTurns : 0;
  let selected = baseKeep;
  for (let k = baseKeep + 1; k <= totalUserTurns; k++) {
    const tokens = tailTokensForKeep(opts.live, k, opts.charsPerToken);
    if (tokens == null || tokens > maxTokens) break;
    selected = k;
  }
  return { keepUserTurns: selected, smartAdjusted: selected !== baseKeep, fromKeep: baseKeep };
};
