/**
 * pi-vcc's `vcc_recall`: search, range, expand, touched files and `#N:path` drill-down over the raw session (everything
 * a compaction dropped); ported from @sting8k/pi-vcc 0.11.2 (MIT), its comments kept. Pi's session file becomes
 * hortus's session entries (see `RecallSource`), and Pi's message parts hortus messages (`RawMessage`).
 */
import type { Message, SessionEntry } from "@hortus/core";
import {
  clip,
  extractPath,
  extractPaths,
  extractToolCallArgsText,
  extractToolCallText,
  isContentBearing,
  summarizeToolArgs,
} from "./extract.ts";

/** builtin:compaction's entry type */
export const COMPACTION_ENTRY = "builtin:compaction:compaction";

// ── core/recall-scope.ts ──
export type RecallScope = "lineage" | "all";
export type RecallMode = "hybrid" | "touched";

const SCOPE_RE = /\bscope:(lineage|all)\b/i;

const VALID_MODES = new Set(["hybrid", "touched"]);

export const normalizeRecallScope = (scope?: unknown): RecallScope =>
  typeof scope === "string" && scope.toLowerCase() === "all" ? "all" : "lineage";

/**
 * Normalize a mode param to a supported recall mode. Without OM integration,
 * only "touched" adds behavior beyond the default hybrid search — "file"-only
 * search is not implemented in pi-vcc, so it is not exposed.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export const normalizeRecallMode = (mode?: unknown): RecallMode =>
  typeof mode === "string" && VALID_MODES.has(mode.toLowerCase()) ? (mode.toLowerCase() as RecallMode) : "hybrid";

export const parseRecallScope = (text: string): { scope: RecallScope; text: string } => {
  const match = text.match(SCOPE_RE);
  return {
    scope: normalizeRecallScope(match?.[1]),
    text: text.replace(SCOPE_RE, "").replace(/\s+/g, " ").trim(),
  };
};

// ── core/recall-request.ts ──

export type DrillTarget = NonNullable<ReturnType<typeof parseDrillDown>>;

/** The one thing a recall call does. Exactly one action runs per call. */
export type RecallAction =
  | { kind: "drill"; target: DrillTarget }
  | { kind: "touched"; page?: number }
  | { kind: "expand"; indices: number[] }
  | { kind: "range"; range: unknown[]; page: number }
  | { kind: "search"; query: string; page: number }
  | { kind: "recent"; query?: string };

export interface RecallRequest {
  scope: RecallScope;
  action: RecallAction;
  /** Params the caller set that this action does not use. Defaults (page:1, expand:[]) are not listed. */
  ignored?: string[];
  /** Values normalizeToolParams could not repair and removed. */
  dropped?: string[];
}

export interface RecallToolParams {
  query?: string;
  expand?: number[];
  range?: unknown[];
  page?: number;
  scope?: string;
  mode?: string;
}

/** Where normalizeToolParams records values it had to drop; read by parseToolRequest. */
export const DROPPED_KEY = "_vccDropped";

const KNOWN_PARAMS = new Set(["query", "range", "expand", "page", "scope", "mode"]);

/** 12, "12", "#12", " 12 " -> 12. Anything else -> undefined. */
const toIndex = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isInteger(v) ? v : undefined;
  if (typeof v === "string") {
    const m = v.trim().match(/^#?(\d+)$/);
    return m ? Number(m[1]) : undefined;
  }
  return undefined;
};

/** "12", "#12, #15", "12 15" -> numbers; undefined unless the whole string is #N tokens. */
const indexList = (s: string): number[] | undefined => {
  const t = s.trim().replace(/^\[|\]$/g, "");
  if (!/^\s*#?\d+(\s*[,\s]\s*#?\d+)*\s*$/.test(t)) return undefined;
  return (t.match(/\d+/g) ?? []).map(Number);
};

/**
 * Repair argument mistakes whose meaning is certain, before pi validates the
 * schema: numbers sent as strings or with a leading #, a single index where a
 * list is expected, a range written as "10-20" or reversed, enum values in
 * the wrong case, and a scope value put in mode. Values that cannot be
 * repaired are removed and listed under DROPPED_KEY, so the output names them
 * instead of pi rejecting the whole call or recall dropping them silently.
 */
export const normalizeToolParams = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const p: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const dropped: string[] = [];
  const drop = (key: string, why: string) => {
    dropped.push(`${key} ${JSON.stringify(p[key])} (${why})`);
    delete p[key];
  };

  for (const key of Object.keys(p)) {
    if (!KNOWN_PARAMS.has(key) && key !== DROPPED_KEY) drop(key, "not a vcc_recall param");
  }

  if (p.page !== undefined) {
    const n = toIndex(p.page);
    if (n !== undefined && n >= 1) p.page = n;
    else drop("page", "not a page number");
  }

  if (p.expand !== undefined) {
    const list = Array.isArray(p.expand)
      ? p.expand.map(toIndex)
      : typeof p.expand === "string"
        ? indexList(p.expand)
        : [toIndex(p.expand)];
    if (list?.every((n) => n !== undefined)) p.expand = list;
    else drop("expand", "not #N indices");
  }

  if (p.range !== undefined) {
    let pair: (number | undefined)[] | undefined;
    if (Array.isArray(p.range)) pair = p.range.map(toIndex);
    else if (typeof p.range === "string") {
      const m = p.range.trim().match(/^\[?\s*#?(\d+)\s*(?:(?:-|\.\.|,|to)\s*#?(\d+)\s*)?\]?$/i);
      pair = m ? [Number(m[1]), Number(m[2] ?? m[1])] : undefined;
    } else pair = [toIndex(p.range)];
    // A single index reads just that entry.
    if (pair?.length === 1) pair = [pair[0], pair[0]];
    if (pair && pair.length === 2 && pair.every((n) => n !== undefined)) {
      const [a, b] = pair as number[];
      p.range = a <= b ? [a, b] : [b, a];
    } else drop("range", "not [from, to]");
  }

  for (const key of ["scope", "mode"] as const) {
    if (typeof p[key] === "string") p[key] = (p[key] as string).trim().toLowerCase();
  }
  if ((p.mode === "all" || p.mode === "lineage") && p.scope === undefined) {
    p.scope = p.mode;
    delete p.mode;
  }
  if (p.scope !== undefined && p.scope !== "lineage" && p.scope !== "all") drop("scope", "use 'lineage' or 'all'");
  if (p.mode !== undefined && p.mode !== "hybrid" && p.mode !== "touched")
    drop("mode", "use 'touched' or leave it out");
  if (p.query !== undefined && typeof p.query !== "string") drop("query", "not text");

  if (dropped.length > 0) p[DROPPED_KEY] = dropped;
  return p;
};

/**
 * Tool params -> request. The precedence lives here and only here:
 * #N:path drill-down, then mode:'touched', then expand, then range, then
 * query search, then the most recent entries.
 */
export const parseToolRequest = (params: RecallToolParams): RecallRequest => {
  const scope = normalizeRecallScope(params.scope);
  const q = params.query?.trim();
  const indices = [...new Set(params.expand ?? [])];
  const hasRange = Array.isArray(params.range) && params.range.length > 0;
  const set = {
    query: Boolean(q),
    expand: indices.length > 0,
    range: hasRange,
    page: (params.page ?? 1) > 1,
    touched: normalizeRecallMode(params.mode) === "touched",
  };
  const droppedRaw = (params as Record<string, unknown>)[DROPPED_KEY];
  const dropped = Array.isArray(droppedRaw) && droppedRaw.length > 0 ? droppedRaw.map(String) : undefined;
  const req = (action: RecallAction, uses: (keyof typeof set)[]): RecallRequest => {
    const ignored = (Object.keys(set) as (keyof typeof set)[])
      .filter((k) => set[k] && !uses.includes(k))
      .map((k) => (k === "touched" ? "mode" : k));
    const base: RecallRequest = dropped ? { scope, action, dropped } : { scope, action };
    return ignored.length > 0 ? { ...base, ignored } : base;
  };

  const target = q ? parseDrillDown(q) : null;
  if (target) return req({ kind: "drill", target }, ["query"]);
  if (set.touched) return req({ kind: "touched", page: params.page }, ["touched", "page"]);
  if (set.expand) return req({ kind: "expand", indices }, ["expand"]);
  if (hasRange)
    return req({ kind: "range", range: params.range as unknown[], page: Math.max(1, params.page ?? 1) }, [
      "range",
      "page",
    ]);
  if (q)
    return req({ kind: "search", query: params.query as string, page: Math.max(1, params.page ?? 1) }, [
      "query",
      "page",
    ]);
  return req({ kind: "recent", query: params.query }, []);
};

/** /pi-vcc-recall args -> request. A person types a query, scope:all and page:N only. */
export const parseCommandRequest = (args: string): RecallRequest => {
  const parsed = parseRecallScope(args.trim());
  const scope = parsed.scope;
  const pageMatch = parsed.text.match(/\bpage:(\d+)\b/i);
  const page = pageMatch ? Math.max(1, parseInt(pageMatch[1], 10)) : 1;
  const query = parsed.text.replace(/\bpage:\d+\b/i, "").trim();
  if (!query) return { scope, action: { kind: "recent" } };
  return { scope, action: { kind: "search", query, page } };
};

// ── core/render-entries.ts ──

export interface RenderedEntry {
  index: number;
  role: string;
  summary: string;
  files?: string[];
}

/** A session message as recall loads it: a tool message also carries its results' tool names. */
export type RawMessage = Message & { toolNames?: string[] };

const resultText = (msg: RawMessage, max?: number): string =>
  msg.role === "tool"
    ? msg.results
        .map((r, i) => `[${msg.toolNames?.[i] ?? ""}] ${max === undefined ? r.output : clip(r.output, max)}`)
        .join("\n")
    : "";

const toolCalls = (msg: RawMessage): string =>
  msg.role === "assistant"
    ? msg.toolCalls.map((c) => `${c.name}(${summarizeToolArgs((c.input ?? {}) as Record<string, unknown>)})`).join(", ")
    : "";

const extractFilesFromContent = (msg: RawMessage): string[] =>
  msg.role === "assistant"
    ? msg.toolCalls.flatMap((c) => extractPaths((c.input ?? {}) as Record<string, unknown>))
    : [];

export const renderMessage = (msg: RawMessage, index: number, full = false): RenderedEntry => {
  if (msg.role === "user") return { index, role: "user", summary: full ? msg.content : clip(msg.content, 300) };
  if (msg.role === "tool") return { index, role: "tool_result", summary: resultText(msg, full ? undefined : 200) };
  const text = full ? msg.text : clip(msg.text, 300);
  const tools = toolCalls(msg);
  const files = extractFilesFromContent(msg);
  const summary = tools ? `${tools}\n${text}` : text;
  return { index, role: "assistant", summary, ...(files.length > 0 && { files }) };
};

// ── core/search-entries.ts ──

export interface SearchHit extends RenderedEntry {
  /** Context snippet around the first matched term (only when query provided) */
  snippet?: string;
  /** Number of query terms matched (for ranking) */
  matchCount?: number;
}

/**
 * Result of a search, with enough metadata for a caller to report truncation
 * honestly (see `searchEntriesDetailed`). `searchEntries` stays `SearchHit[]`
 * for existing call sites that only need the hits themselves.
 */
export interface SearchResult {
  hits: SearchHit[];
  /** Genuine matches found before the hard cap was applied (after any
   *  relative-floor noise filtering). May exceed `hits.length`. */
  totalBeforeCap: number;
  /** True when the hard cap discarded matches (`totalBeforeCap > hits.length`). */
  truncated: boolean;
}
/** A file touched in one entry — used by mode:touched aggregation. */
export interface FileTouch {
  index: number;
  toolName: string;
  /** False when the call names the file but carries no file content to drill into (a multi-path script edit). */
  drillable?: false;
}

/** Aggregated view of a file touched across multiple entries. */
export interface TouchedFile {
  path: string;
  entries: FileTouch[];
}
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Quantifier starting at `i`, if any. Only unbounded forms (+, *, {n,}) can
 *  drive catastrophic backtracking. */
const quantifierAt = (p: string, i: number): { len: number; unbounded: boolean } => {
  const c = p[i];
  if (c === "+" || c === "*") return { len: 1, unbounded: true };
  if (c === "{") {
    const end = p.indexOf("}", i);
    const body = end === -1 ? "" : p.slice(i + 1, end);
    if (/^\d+(,\d*)?$/.test(body)) return { len: end - i + 1, unbounded: body.endsWith(",") };
  }
  return { len: 0, unbounded: false };
};

/**
 * Detect an unbounded quantifier applied to a group that already contains one,
 * e.g. `(a+)+` or `(\w*)*`. That shape makes the engine explore exponentially
 * many splits on a non-matching input. Alternation overlap like `(a|a)+` is not
 * covered here; the search budget in `searchEntries` is the backstop.
 */
const hasNestedQuantifier = (pattern: string): boolean => {
  const groups: boolean[] = []; // per open group: contains an unbounded quantifier
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      groups.push(false);
      continue;
    }
    if (c === ")") {
      const inner = groups.pop() ?? false;
      const q = quantifierAt(pattern, i + 1);
      if (inner && q.unbounded) return true;
      if (groups.length) groups[groups.length - 1] ||= inner || q.unbounded;
      i += q.len;
      continue;
    }
    const q = quantifierAt(pattern, i);
    if (q.unbounded && groups.length) {
      groups[groups.length - 1] = true;
      i += q.len - 1;
    }
  }
  return false;
};

/** Try to compile as regex; fall back to escaped literal. Patterns with nested
 *  unbounded quantifiers are treated as literals rather than compiled. */
const safeRegex = (pattern: string): RegExp => {
  if (hasNestedQuantifier(pattern)) return new RegExp(escapeRegex(pattern), "i");
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegex(pattern), "i");
  }
};

/**
 * Wall-clock budget for one search. A normal query over 400 entries takes ~10ms,
 * so this only trips on pathological patterns that survive `hasNestedQuantifier`.
 * Aborting loudly beats returning a silently truncated match count.
 *
 * This is a per-entry checkpoint, not a hard per-call ceiling: JavaScript cannot
 * interrupt a running `RegExp.test`, so a single pathological entry still runs to
 * completion and the overshoot is caught on the next iteration. That bounds the
 * damage to one entry instead of the whole corpus, which is the point — the
 * unbounded case was N entries multiplied by the per-entry cost.
 */
const SEARCH_BUDGET_MS = 3000;

const startBudget = (): (() => void) => {
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  return () => {
    if (Date.now() > deadline) {
      throw new Error(
        `Search aborted: query exceeded ${SEARCH_BUDGET_MS}ms. Use fewer or more specific words; ` +
          "for a regex, avoid nested quantifiers such as (a+)+.",
      );
    }
  };
};

/** Detect if the query looks like a single regex pattern (contains regex metacharacters). */
const looksLikeRegex = (query: string): boolean => /[|*+?{}()[\]\\^$.]/.test(query);

/** Build a regex for snippet highlighting — matches first available term. */
const snippetRegex = (terms: string[]): RegExp => {
  const alts = terms.map((t) => safeRegex(t).source);
  return new RegExp(alts.join("|"), "i");
};

// ── Stopwords for natural language queries ──
const STOPWORDS = new Set([
  // English
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "of",
  "in",
  "to",
  "for",
  "with",
  "on",
  "at",
  "from",
  "by",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "about",
  "it",
  "its",
  "that",
  "this",
  "what",
  "which",
  "who",
  "whom",
  "these",
  "those",
]);

/** Remove stopwords, keep meaningful terms. */
const filterStopwords = (terms: string[]): string[] => {
  const meaningful = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()) && t.length > 1);
  // If all terms were stopwords, return original (don't lose everything)
  return meaningful.length > 0 ? meaningful : terms;
};

// ── BM25-lite scoring ──
const BM25_K = 1.2;
const BM25_B = 0.75;

/**
 * One query term, compiled once per search. Building the RegExp per term per
 * doc cost ~1M compilations on a 17k-message session and was most of the
 * search time.
 */
interface Term {
  term: string;
  re: RegExp; // safeRegex(term): case-insensitive, first match
  global: RegExp; // same source with "gi", for counting occurrences
}

const compileTerms = (terms: string[]): Term[] =>
  terms.map((term) => {
    const re = safeRegex(term);
    return { term, re, global: new RegExp(re.source, "gi") };
  });

/** Count occurrences of a term in text. */
const termFreq = (text: string, t: Term): number => {
  const matches = text.match(t.global);
  return matches ? matches.length : 0;
};

const wordCount = (doc: string): number => doc.split(/\s+/).length;

/** A run of base64 characters this long can be encoded data (an image, a file). Shorter
 *  ones (keys, tokens) rarely hold a chance match: a 3-letter term hits about once per
 *  32k random chars. JSON, code and paths break a run with punctuation. */
const BASE64_RUN = /[A-Za-z0-9+/=]{1000,}/g;

/** Encoded data mixes digits and both cases (random base64: ~16% / 40% / 40%). Joined
 *  identifiers, hex and `=====` rules do not, and stay searchable. */
const looksEncoded = (run: string): boolean => {
  let digits = 0,
    upper = 0,
    lower = 0;
  for (let i = 0; i < run.length; i++) {
    const c = run.charCodeAt(i);
    if (c >= 48 && c <= 57) digits++;
    else if (c >= 65 && c <= 90) upper++;
    else if (c >= 97 && c <= 122) lower++;
  }
  return digits >= run.length * 0.05 && upper >= run.length * 0.15 && lower >= run.length * 0.15;
};

/** An entry's text as search sees it: encoded data is dropped, as search engines drop
 *  overlong tokens. Terms match as substrings, so a short term would hit inside it
 *  hundreds of times, and it would count as one word of length. */
const searchableText = (msg: RawMessage | undefined, e: RenderedEntry): string =>
  (msg ? fullText(msg) : e.summary).replace(BASE64_RUN, (run) => (looksEncoded(run) ? "…" : run));

interface BM25Context {
  n: number; // total docs
  avgDl: number; // average doc length (words)
  df: Map<string, number>; // term -> number of docs containing it
  /** Per doc, the terms it contains: found once here, reused for matchCount and scoring. */
  matched: Term[][];
}

/** Precompute IDF and avgDl across all docs. */
const buildBM25Context = (docs: string[], docLens: number[], terms: Term[], checkBudget: () => void): BM25Context => {
  const n = docs.length;
  const df = new Map<string, number>();
  const matched: Term[][] = [];
  let totalLen = 0;

  for (let i = 0; i < n; i++) {
    checkBudget();
    totalLen += docLens[i];
    const here: Term[] = [];
    for (const t of terms) {
      if (t.re.test(docs[i])) {
        df.set(t.term, (df.get(t.term) ?? 0) + 1);
        here.push(t);
      }
    }
    matched.push(here);
  }

  return { n, avgDl: totalLen / Math.max(n, 1), df, matched };
};

/** BM25 score for a single doc against query terms. */
const bm25Score = (doc: string, dl: number, terms: Term[], ctx: BM25Context): number => {
  let score = 0;

  for (const t of terms) {
    const tf = termFreq(doc, t);
    if (tf === 0) continue;

    const docFreq = ctx.df.get(t.term) ?? 0;
    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log((ctx.n - docFreq + 0.5) / (docFreq + 0.5) + 1);
    // TF saturation with length normalization
    const tfNorm = (tf * (BM25_K + 1)) / (tf + BM25_K * (1 - BM25_B + (BM25_B * dl) / ctx.avgDl));
    score += idf * tfNorm;
  }

  return score;
};

/** Longest snippet line: a longer one is cut to a window around the match, or to its start. */
const SNIPPET_LINE_CHARS = 300;

const clipLine = (line: string, at: number): string => {
  if (line.length <= SNIPPET_LINE_CHARS) return line;
  const start = Math.max(0, Math.min(at - SNIPPET_LINE_CHARS / 2, line.length - SNIPPET_LINE_CHARS));
  const end = start + SNIPPET_LINE_CHARS;
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
};

/** Line-based snippet: ±contextLines around first regex match. */
const lineSnippet = (text: string, regex: RegExp, contextLines = 2): string | undefined => {
  const lines = text.split("\n");
  let matchIdx = -1;
  let matchAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].search(regex);
    if (at >= 0) {
      matchIdx = i;
      matchAt = at;
      break;
    }
  }
  if (matchIdx === -1) return undefined;

  const start = Math.max(0, matchIdx - contextLines);
  const end = Math.min(lines.length, matchIdx + contextLines + 1);
  const slice = lines.slice(start, end).map((line, i) => clipLine(line, start + i === matchIdx ? matchAt : 0));

  const parts: string[] = [];
  if (start > 0) parts.push(`...(${start} lines above)`);
  parts.push(...slice);
  if (end < lines.length) parts.push(`...(${lines.length - end} lines below)`);
  return parts.join("\n");
};

/**
 * Aggregate character budget for ALL toolCall arguments appended to one
 * message's searchable text — a single shared budget across every toolCall
 * in the message, not per call, so N toolCalls can't multiply the bound and
 * make one message's contribution to the BM25 doc corpus unbounded.
 *
 * Head-only cap: content past this budget is not indexed via toolCall
 * arguments at all. This is an honest tradeoff, not a proxy for full
 * coverage — a Write/Edit tool result commonly only acknowledges success
 * (e.g. "wrote 400 lines"), so a fact buried past the cap in a giant
 * argument is not guaranteed to be searchable elsewhere either.
 */
const TOOL_ARGS_BUDGET = 2000;

/**
 * Tool name of the recall tool itself (src/tools/recall.ts). A search
 * operation must not match its own query or its own prior output: the
 * vcc_recall invocation is persisted as an ordinary assistant toolCall (its
 * `{ query }` argument, excluded below in `toolCallArgsText`) followed by an
 * ordinary toolResult message (its `N matches for "<query>"` text, excluded
 * in `fullText`) — without both exclusions a repeated query keeps matching
 * its own prior invocation/output and the hit count grows on every search.
 * This is a targeted introspection invariant for one named tool, not a
 * general allowlist/blocklist over tool names or tool results.
 */
const RECALL_TOOL_NAME = "vcc_recall";

/** Text of every toolCall's arguments in a message's content, for search —
 *  bounded once, in aggregate, by TOOL_ARGS_BUDGET. Excludes the recall
 *  tool's own arguments (see RECALL_TOOL_NAME). */
const toolCallArgsText = (msg: RawMessage): string => {
  if (msg.role !== "assistant") return "";
  const raw = msg.toolCalls
    .filter((part) => part.name?.toLowerCase() !== RECALL_TOOL_NAME)
    .map((part) => extractToolCallArgsText((part.input ?? {}) as Record<string, unknown>))
    .filter(Boolean)
    .join("\n");
  return clip(raw, TOOL_ARGS_BUDGET);
};

/**
 * Build full searchable text for a message: its text plus toolCall arguments (bash command, write/edit content, etc.)
 * so a match that only exists in a tool call's arguments is still findable. The recall tool's own results are excluded
 * (searchable text ""): they echo back `N matches for "<query>"`, so a repeated query would match itself.
 */
const fullText = (msg: RawMessage): string => {
  if (msg.role === "user") return msg.content;
  if (msg.role === "tool")
    return msg.results
      .filter((_, i) => msg.toolNames?.[i]?.toLowerCase() !== RECALL_TOOL_NAME)
      .map((r) => r.output)
      .join("\n");
  const argsText = toolCallArgsText(msg);
  return argsText ? `${msg.text}\n${argsText}` : msg.text;
};

/**
 * Compute file indicators from a message, counting non-empty content lines
 * per content-bearing file call. Shape-based — no tool-name allowlist.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export function getFileIndicators(
  msg: RawMessage,
): { toolName: string; path: string; lineCount: number; drillable: boolean }[] {
  if (msg.role !== "assistant") return [];
  const indicators: { toolName: string; path: string; lineCount: number; drillable: boolean }[] = [];
  for (const part of msg.toolCalls) {
    const args = (part.input ?? {}) as Record<string, unknown>;
    const drillable = isContentBearing(args);
    // A multi-path edit tool: a script (`code`) edits the listed `paths`, so there is no per-file content.
    if (!drillable && !(typeof args.code === "string" && Array.isArray(args.paths))) continue;
    const nonEmpty = extractToolCallText(args)
      .split("\n")
      .filter((l) => l.trim().length > 0);
    for (const path of extractPaths(args))
      indicators.push({ toolName: part.name || "", path, lineCount: nonEmpty.length, drillable });
  }
  return indicators;
}

/**
 * Aggregate file operations across all entries for mode:touched.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export function getTouchedFiles(messages: RawMessage[], rendered: RenderedEntry[]): TouchedFile[] {
  const map = new Map<string, TouchedFile>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const indicators = getFileIndicators(msg);
    for (const fm of indicators) {
      const index = rendered[i]?.index ?? i;
      if (!map.has(fm.path)) {
        map.set(fm.path, { path: fm.path, entries: [] });
      }
      (map.get(fm.path) as TouchedFile).entries.push({
        index,
        toolName: fm.toolName,
        ...(!fm.drillable && { drillable: false as const }),
      });
    }
  }
  return Array.from(map.values());
}

/**
 * Relative BM25 noise floor for MULTI-TERM natural-language queries only:
 * after sorting by score, drop hits scoring below this fraction of the top
 * score. Relative (not absolute) because BM25 magnitudes vary with corpus
 * size and document length, so a fixed score threshold would behave
 * inconsistently across short vs. long sessions.
 *
 * Applied only when the query has >=2 DISTINCT effective terms after
 * stopword filtering and case/duplicate normalization (see the
 * `effectiveTermCount >= 2` gate below `searchEntriesDetailed` uses before
 * calling `applyRelativeFloor`). Distinct, not raw count: "auth auth" or
 * "Auth AUTH" is semantically a single-term query and must bypass the floor
 * like any other single term — repeating or casing a word doesn't turn it
 * into the multi-term OR-tail noise this floor targets. The normalization is
 * gate-only; it doesn't change `terms` or the BM25 scoring itself, which
 * already matches case-insensitively. For a genuine single term, every hit's
 * occurrence already satisfies the whole query — its BM25 score differences
 * reflect term frequency and document length, not multi-term OR-tail noise,
 * so filtering by it there risks real matches for no corresponding noise
 * reduction. Evidence below confirmed this rather than assuming it.
 *
 * Evidence (scripts/benchmark-recall-quality.ts, run through this exact
 * production function via its `tuning` override — not a duplicate scoring
 * implementation). Two independent runs against real session corpora (23
 * sessions/161 queries and 31 sessions/222 queries; exact counts vary with
 * whatever real sessions are available locally, so both are reported rather
 * than treating one as a fixed target):
 *   - floor=0.20 on multi-term queries: median result count 49→23 (run 1,
 *     n=69) and 60.5→23.5 (run 2, n=98); p90 142.8→81 and 126.2→75.3.
 *     Zero-hit count stayed 0 in both runs, top-1 never changed (0/69,
 *     0/98). Top-5 membership shifted in 5/69 (7%) and 5/98 (5%).
 *   - floor=0.10 was too weak to "meaningfully" remove the tail (multi-term
 *     median only 49→39 / 60.5→42); floor=0.25 removed more but roughly
 *     doubled the multi-term top-5 disruption (8/69, run 1) for little extra
 *     median gain over 0.20. 0.20 is the least aggressive setting that
 *     meaningfully thinned the tail.
 *   - Single-term queries with the floor gated off: every floor candidate
 *     (0, 0.10, 0.20, 0.25) produced byte-identical results — 0/92 and
 *     0/124 top-5 changes in both runs, confirming the gate is a true no-op
 *     rather than an untested assumption. Before this gate existed, applying
 *     0.20 unconditionally still changed single-term top-5 in a small but
 *     non-zero fraction of queries (1/140 in this repo's own rerun, 1/124 in
 *     an independent reviewer rerun) for negligible median movement — real
 *     false-negative risk for no real noise benefit, which is why the gate
 *     exists.
 *
 * The top-scoring hit always survives by construction, independent of the
 * evidence above: its own score always satisfies `score >= topScore * floor`
 * for any floor <= 1, so a non-empty scored[] can never be filtered to zero.
 */
const BM25_RELATIVE_FLOOR = 0.2;

/**
 * Hard cap on total SEARCH results, applied to both the natural-language
 * (post-floor) and regex result paths so pagination stays bounded regardless
 * of how noisy or broad a query is.
 *
 * Evidence (same bench/corpora as BM25_RELATIVE_FLOOR, floor disabled to
 * isolate the cap's effect; run 1 = 161 queries, run 2 = 222 queries):
 * uncapped result counts ranged up to 380 (median 32 / 29.5, p90 119 /
 * 115.9). cap=50 sits ABOVE the corpus's own median in both runs but BELOW
 * its p90 — it leaves the typical (median) query unclipped while still
 * bounding the long tail: only 46/161 (29%) and 66/222 (30%) of queries were
 * truncated by it, versus 90/161 (56%) and 124/222 (56%) for cap=25, which
 * would also clip plenty of unremarkable ~30-match queries well under what
 * "noisy" implies. cap=50 also bounds the worst case (380) down by 87%.
 * Combined with the floor (production policy: floor=0.20 multi-term-only,
 * cap=50, vs. no filtering at all): 0 zero-hit regressions and 0 top-1
 * changes in both runs; top-5 changed in 5/161 (3%) and 5/222 (2%); median
 * result count 32→18 and 29.5→20; p90 119→50 and 115.9→50.
 */
const SEARCH_RESULT_CAP = 50;

/**
 * Tuning overrides for `searchEntriesDetailed`. Exists only so the offline
 * bench (scripts/benchmark-recall-quality.ts) and targeted tests can
 * exercise the real scoring/capping pipeline against candidate constants —
 * production call sites (`searchEntries`, the recall tool) never pass this
 * and always get `BM25_RELATIVE_FLOOR`/`SEARCH_RESULT_CAP`.
 */
export interface SearchTuning {
  relativeFloor?: number;
  cap?: number;
}

/** Drop scored hits below `floor` of the top score. The top hit's own score
 *  always passes (score >= score * floor for floor <= 1), so this can never
 *  turn a non-empty `scored` into an empty result. */
const applyRelativeFloor = (
  scored: Array<{ hit: SearchHit; score: number }>,
  floor: number,
): Array<{ hit: SearchHit; score: number }> => {
  if (scored.length === 0) return scored;
  const topScore = scored[0].score;
  if (topScore <= 0) return scored;
  return scored.filter((s) => s.score >= topScore * floor);
};

/**
 * Bound `hits` to `cap` entries, reporting the pre-cap count so callers can
 * signal truncation honestly instead of understating "total matches".
 *
 * Order preserved, never re-sorted: for the BM25 path that's already
 * highest-score-first, so `slice(0, cap)` keeps the top `cap` hits. For the
 * regex path there is no score — hits are collected in entry/chronological
 * iteration order, so `slice(0, cap)` keeps the OLDEST `cap` matches, not
 * the most recent or most relevant ones. That is an explicit, documented
 * preservation choice for this change, not a new selection/ranking policy —
 * changing which matches a truncated regex search keeps (e.g. newest-first)
 * is a separate decision, out of scope here.
 */
const capHits = (hits: SearchHit[], cap: number): SearchResult => {
  const totalBeforeCap = hits.length;
  const capped = totalBeforeCap > cap ? hits.slice(0, cap) : hits;
  return { hits: capped, totalBeforeCap, truncated: capped.length < totalBeforeCap };
};

/**
 * Full search with truncation metadata. `searchEntries` below is a thin
 * `.hits`-only wrapper kept for existing call sites; use this directly when
 * a caller (the recall tool) needs to report a capped result set honestly.
 */
export const searchEntriesDetailed = (
  entries: RenderedEntry[],
  messages: RawMessage[],
  query?: string,
  tuning?: SearchTuning,
): SearchResult => {
  if (!query?.trim()) return { hits: entries, totalBeforeCap: entries.length, truncated: false };

  const relativeFloor = tuning?.relativeFloor ?? BM25_RELATIVE_FLOOR;
  const cap = tuning?.cap ?? SEARCH_RESULT_CAP;
  const rawQuery = query.trim();
  const checkBudget = startBudget();

  // If the query looks like a single regex pattern (contains metacharacters),
  // treat the whole thing as one pattern — don't split into terms.
  //
  // The detection is deliberately loose, so ordinary prose trips it: a trailing
  // "?" or "." turns the whole sentence into one pattern that must match
  // verbatim. On real sessions that path returned nothing 47.5% of the time
  // versus 1.1% for term search. Mode detection must never silently lose
  // results, so an empty regex result falls through to term search below.
  //
  // No relative-floor filtering here: regex matches are boolean (matched or
  // not), there's no score to be relative to. Only the hard cap applies.
  if (looksLikeRegex(rawQuery)) {
    const regex = safeRegex(rawQuery);
    const hits: SearchHit[] = [];
    for (let i = 0; i < entries.length; i++) {
      checkBudget();
      const e = entries[i];
      const msg = messages[i];
      const text = searchableText(msg, e);
      const filePart = e.files?.join(" ") ?? "";
      const hay = `${e.role} ${text} ${filePart}`;
      if (regex.test(hay)) {
        const snip = lineSnippet(text, regex);
        hits.push({ ...e, snippet: snip, matchCount: 1 });
      }
    }
    if (hits.length > 0) return capHits(hits, cap);
  }

  // Natural language / multi-word query: BM25 scoring
  const rawTerms = rawQuery.split(/\s+/);
  const terms = filterStopwords(rawTerms);
  const snipRe = snippetRegex(terms);

  // Build all docs for BM25 context
  const docs: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const msg = messages[i];
    const text = searchableText(msg, e);
    const filePart = e.files?.join(" ") ?? "";
    docs.push(`${e.role} ${text} ${filePart}`);
  }

  const compiled = compileTerms(terms);
  const docLens = docs.map(wordCount);
  const ctx = buildBM25Context(docs, docLens, compiled, checkBudget);

  const scored: Array<{ hit: SearchHit; score: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    checkBudget();
    const e = entries[i];
    const hay = docs[i];
    const here = ctx.matched[i];
    const mc = here.length;
    if (mc === 0) continue;
    // Terms absent from the doc add 0, so scoring only the matched ones gives the same sum in the same order.
    const score = bm25Score(hay, docLens[i], here, ctx);
    const text = searchableText(messages[i], e);
    const snip = lineSnippet(text, snipRe);
    scored.push({
      hit: { ...e, snippet: snip, matchCount: mc },
      score,
    });
  }

  // Sort by BM25 score desc, then drop the noisy long tail relative to the
  // top score (multi-term queries only — see BM25_RELATIVE_FLOOR), then
  // apply the hard cap.
  scored.sort((a, b) => b.score - a.score);
  // Gate on DISTINCT normalized terms, not raw term count: "auth auth" or
  // "Auth AUTH" is semantically a single-term query and must bypass the
  // floor like any other single term — repeating/casing a word doesn't turn
  // it into the multi-term OR-tail noise this floor targets. This is a
  // gate-only normalization; it does not change `terms` itself or the BM25
  // scoring above, which already matches case-insensitively.
  const effectiveTermCount = new Set(terms.map((t) => t.toLowerCase())).size;
  const floored = effectiveTermCount >= 2 ? applyRelativeFloor(scored, relativeFloor) : scored;
  return capHits(
    floored.map((s) => s.hit),
    cap,
  );
};

export const searchEntries = (entries: RenderedEntry[], messages: RawMessage[], query?: string): SearchHit[] =>
  searchEntriesDetailed(entries, messages, query).hits;

// ── core/drill-down.ts ──
/**
 * Drill-down: resolve #N:path syntax to tool call file content.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 *
 * Supports: #42:auth.ts (preview), #42:auth.ts:full (full content), #42:file (auto-select).
 *
 * Path matching notes:
 * - The regex uses $ anchor so lazy .+? consumes the full path — spaces, dots, and
 *   Windows drive-letter colons (C:\) all work correctly.
 * - One edge case: a file path literally ending in ":full" (e.g. C:\file:full)
 *   would be misinterpreted as the :full flag. This is extremely unlikely.
 * - Inline queries like "check #42:auth.ts" are NOT drill-down — the ^ anchor
 *   requires the entire query to be the drill-down pattern.
 */

// ── Types ─────────────────────────────────────────────────────────────────

interface ContentBearingCall {
  name: string;
  path: string;
  content?: string;
  oldText?: string;
  newText?: string;
  edits?: Array<{ oldText?: string; newText?: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Find content-bearing tool calls that have a `path` argument and at least
 * one content field (content, edits, oldText, newText).
 * Uses the shared isContentBearing() heuristic from content.ts.
 */
function findContentBearingCalls(msg: RawMessage): ContentBearingCall[] {
  if (msg.role !== "assistant") return [];
  const results: ContentBearingCall[] = [];
  for (const part of msg.toolCalls) {
    const args = (part.input ?? {}) as Record<string, unknown>;
    if (!isContentBearing(args)) continue;
    const path = extractPath(args);
    if (!path) continue;
    const entry: ContentBearingCall = { name: part.name ?? "", path };
    if (typeof args.content === "string") entry.content = args.content;
    if (Array.isArray(args.edits)) {
      entry.edits = args.edits.filter(
        (e: unknown): e is { oldText?: string; newText?: string } => e !== null && typeof e === "object",
      );
    }
    if (typeof args.oldText === "string" && !Array.isArray(args.edits)) entry.oldText = args.oldText;
    if (typeof args.newText === "string" && !Array.isArray(args.edits)) entry.newText = args.newText;
    results.push(entry);
  }
  return results;
}

/** Format content for display with optional offset/limit slicing.
 *
 * When full=true, shows everything ignoring offset/limit.
 * When offset/limit given, shows a window with "Lines X-Y (of Z)" header.
 * When neither, shows preview (first 30 lines) with truncation hint.
 */
function formatToolCallContent(
  tc: ContentBearingCall,
  entryIndex: number,
  options?: { full?: boolean; offset?: number; limit?: number },
): string {
  let body: string;
  if (tc.content) {
    body = tc.content;
  } else if (tc.edits) {
    body = tc.edits
      .map((e, i) => `--- edit ${i + 1} ---\n${e.oldText ?? ""}\n--- becomes ---\n${e.newText ?? ""}`)
      .join("\n\n");
  } else if (tc.oldText && tc.newText) {
    body = `--- old ---\n${tc.oldText}\n--- new ---\n${tc.newText}`;
  } else {
    body = "(no file content found in tool call arguments)";
  }

  const full = options?.full ?? false;
  const offset = options?.offset;
  const limit = options?.limit;
  const allLines = body.split("\n");
  const totalLines = allLines.length;
  const previewLimit = 30;
  const MAX_FULL_BYTES = 50 * 1024;

  if (full) {
    // Full content: capped at 50KB
    if (Buffer.byteLength(body, "utf8") > MAX_FULL_BYTES) {
      const truncated = body.slice(0, MAX_FULL_BYTES);
      return `File: ${tc.path}
Tool: ${tc.name}

${truncated}

... (${Buffer.byteLength(body, "utf8") - MAX_FULL_BYTES} more bytes — file exceeds 50KB display limit. Use #${entryIndex}:${tc.path}:${previewLimit} for next page.)`;
    }
    return `File: ${tc.path}
Tool: ${tc.name}

${body}`;
  }

  if (offset !== undefined) {
    // Offset-based window: show slice
    const startLine = Math.max(0, offset);
    const maxLines = limit ?? 30;
    const endLine = Math.min(startLine + maxLines, totalLines);
    const visible = allLines.slice(startLine, endLine);
    const displayStart = startLine + 1; // 1-indexed for user display

    if (visible.length === 0) {
      return `Offset ${startLine} is beyond file length ${totalLines}. Use #${entryIndex}:${tc.path} for the first ${previewLimit} lines.`;
    }

    let result = `File: ${tc.path}
Tool: ${tc.name}
Lines ${displayStart}-${endLine} (of ${totalLines}):

`;
    result += visible.join("\n");

    if (endLine < totalLines) {
      result += `\n\n--- Use #${entryIndex}:${tc.path}:${endLine} or #${entryIndex}:${tc.path}:${endLine}:${maxLines} for next ${maxLines} lines, #${entryIndex}:${tc.path}:full for complete ---`;
    } else if (offset > 0) {
      result += `\n\n(End of file)`;
    }

    return result;
  }

  // Default preview mode: first ${previewLimit} lines
  if (totalLines > previewLimit) {
    const preview = allLines.slice(0, previewLimit).join("\n");
    return `File: ${tc.path}
Tool: ${tc.name}

${preview}

...(${totalLines - previewLimit} more lines — use #${entryIndex}:${tc.path}:full for complete content, or #${entryIndex}:${tc.path}:${previewLimit} for next ${previewLimit} lines)`;
  }

  return `File: ${tc.path}
Tool: ${tc.name}

${body}`;
}

// ── Parse drill-down query ────────────────────────────────────────────────

/**
 * Pattern: #N:path, #N:path:full, #N:path:offset, or #N:path:offset:limit
 * Group 1: index number
 * Group 2: path (consumed lazily, expanded until suffix can match)
 * Group 3: suffix — "full", a number (offset), or "offset:limit"
 */
const DRILLDOWN_PATTERN = /^#(\d+):(.+?)(?::(full|\d+(?::\d+)?))?$/;

/**
 * Parse a drill-down query like #42:auth.ts or #42:auth.ts:full.
 * Returns null if the query doesn't match the drill-down pattern.
 *
 * Suffixes:
 *   :full       → full content (no truncation)
 *   :30         → offset 30 lines, default limit (30)
 *   :30:20      → offset 30 lines, limit 20 lines
 *   (none)      → preview first 30 lines
 */
export function parseDrillDown(query: string): {
  index: number;
  pathPattern: string;
  full: boolean;
  offset?: number;
  limit?: number;
} | null {
  const match = query.match(DRILLDOWN_PATTERN);
  if (!match) return null;
  const index = parseInt(match[1], 10);
  const pathPattern = match[2];
  const suffix = match[3];

  if (suffix === "full") {
    return {
      index,
      pathPattern,
      full: true,
      offset: undefined,
      limit: undefined,
    };
  }

  if (suffix !== undefined) {
    // Parse "offset" or "offset:limit"
    const parts = suffix.split(":");
    const offset = parseInt(parts[0], 10);
    const limit = parts[1] !== undefined ? parseInt(parts[1], 10) : undefined;
    if (!Number.isNaN(offset)) {
      return { index, pathPattern, full: false, offset, limit };
    }
  }

  return {
    index,
    pathPattern,
    full: false,
    offset: undefined,
    limit: undefined,
  };
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Expand a drill-down query (#N:path) to tool call content.
 *
 * Offset/limit let you page through file content incrementally (like pi's read tool):
 *   #42:auth.ts         → first 30 lines (preview)
 *   #42:auth.ts:full    → all content
 *   #42:auth.ts:30      → lines 31-60 (default limit 30)
 *   #42:auth.ts:30:20   → lines 31-50 (custom limit 20)
 *
 * @param sessionFile - Path to the JSONL session file
 * @param entryIndex - The message index (#N)
 * @param pathPattern - File path substring to match (or "file" keyword)
 * @param full - If true, return complete content without truncation
 * @param offset - Line offset (0-indexed) for windowed content
 * @param limit - Max lines to show (default 30 for windowed, ignored if full=true)
 * @returns Formatted content string
 */
export function expandEntryFile(
  loaded: LoadedMessages,
  entryIndex: number,
  pathPattern: string,
  full = false,
  offset?: number,
  limit?: number,
): string {
  const { rendered, rawMessages } = loaded;
  // Look up by `#N` index, not array position: skipped entries (system
  // messages) keep their index but are absent from the arrays.
  const pos = rendered.findIndex((r) => r.index === entryIndex);

  if (pos < 0) {
    return `Entry #${entryIndex} not found in session history.`;
  }

  const calls = findContentBearingCalls(rawMessages[pos]);

  // Special case: #42:file keyword
  if (pathPattern === "file") {
    if (calls.length === 0) {
      return `No file content found in entry #${entryIndex}.`;
    }
    if (calls.length === 1) {
      return formatToolCallContent(calls[0], entryIndex, {
        full,
        offset,
        limit,
      });
    }
    // Multiple content-bearing calls — list them
    const items = calls.map((tc) => `  [#${entryIndex}:${tc.path}] ${tc.name}(${tc.path})`);
    return `Entry #${entryIndex} has ${calls.length} file operations:\n${items.join("\n")}\n\nUse #${entryIndex}:path to drill into a specific file.`;
  }

  const matched = calls.filter((tc) => tc.path.includes(pathPattern));

  if (matched.length === 0) {
    return `No file content found in entry #${entryIndex} for "${pathPattern}".`;
  }

  if (matched.length > 1) {
    // Ambiguous match — list options instead of silently picking the first
    const items = matched.map((tc) => `  [#${entryIndex}:${tc.path}] ${tc.name}(${tc.path})`);
    return `Entry #${entryIndex} has ${matched.length} file operations matching "${pathPattern}":
${items.join("\n")}

Use #${entryIndex}:<more-specific-path> to drill into a specific file.`;
  }

  return formatToolCallContent(matched[0], entryIndex, { full, offset, limit });
}

// ── core/format-recall.ts ──

// ── Path shortening ───────────────────────────────────────────────────────

/**
 * Shorten an absolute file path for display:
 * - If within cwd, return `./relative/path`
 * - Otherwise, show last 3 path components with `.../` prefix
 * - Short paths (≤3 components) returned as-is
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export function shortPath(fullPath: string, cwd: string): string {
  const normalized = fullPath.replace(/\\/g, "/");
  const cwdNormalized = cwd.replace(/\\/g, "/");
  if (normalized.startsWith(`${cwdNormalized}/`)) {
    return `.${normalized.slice(cwdNormalized.length)}`;
  }
  const parts = normalized.split("/");
  if (parts.length > 3) {
    return `.../${parts.slice(-3).join("/")}`;
  }
  return normalized;
}

// ── Touched file output ───────────────────────────────────────────────────

export const TOUCHED_PAGE_SIZE = 5;

/**
 * Format aggregated "files touched" output.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export function formatTouchedOutput(touched: TouchedFile[], cwd: string, page?: number, pageSize?: number): string {
  if (touched.length === 0) {
    return "No file operations found in session history.";
  }

  const ps = pageSize ?? TOUCHED_PAGE_SIZE;
  const totalPages = Math.ceil(touched.length / ps);
  const currentPage = Math.max(1, page ?? 1);
  const start = (currentPage - 1) * ps;
  const pageFiles = touched.slice(start, start + ps);

  const header =
    totalPages > 1
      ? `Page ${currentPage}/${totalPages} (${touched.length} total files)`
      : `${touched.length} files touched`;

  const lines = pageFiles.map((tf) => {
    const displayPath = shortPath(tf.path, cwd);
    const indices = tf.entries.map((e) => `#${e.index} (${e.toolName})`).join(", ");
    return `  ${displayPath}    ${indices}`;
  });

  let result = `${header}:\n\n${lines.join("\n")}`;

  if (currentPage < totalPages) {
    result += `\n\n--- Use page:${currentPage + 1} for more results ---`;
  }

  return result;
}

export const formatRecallOutput = (entries: SearchHit[], query?: string, headerOverride?: string): string => {
  if (entries.length === 0) {
    return query ? `No matches for "${query}" in session history.` : "No entries in session history.";
  }

  const header = headerOverride
    ? `${headerOverride}${query ? ` for "${query}"` : ""}:`
    : query
      ? `Found ${entries.length} matches for "${query}":`
      : `Session history (${entries.length} entries):`;

  const lines = entries.map((e) => {
    const fileSuffix = e.files?.length ? ` files:[${e.files.join(", ")}]` : "";
    const body = query && e.snippet ? e.snippet : e.summary;
    return `#${e.index} [${e.role}]${fileSuffix} ${body}`;
  });

  return `${header}\n\n${lines.join("\n\n")}`;
};

// ── core/recall-run.ts ──

export const SEARCH_PAGE_SIZE = 5;
export const RANGE_PAGE_SIZE = 20;
export const RECENT_COUNT = 25;

// ── core/load-messages.ts, core/global-indices.ts, core/lineage.ts (hortus session entries) ──

/** What recall reads: every entry of the session file in file order (all branches), and the current branch's. */
export interface RecallSource {
  all: readonly SessionEntry[];
  branch: readonly SessionEntry[];
}

export interface LoadedMessages {
  rendered: RenderedEntry[];
  rawMessages: RawMessage[];
}

/** Entries counted by the global `#N` index: message entries. */
const isMessageEntry = (e: SessionEntry): e is Extract<SessionEntry, { type: "message" }> =>
  e.type === "message" && (e as { message?: unknown }).message != null;

/**
 * Map entry ids to their global `#N` index: position among message entries in file order, across compaction windows
 * and branches. Shared with recall's numbering, so summary refs land on their message.
 */
export const buildGlobalIndexById = (entries: readonly SessionEntry[]): Map<string, number> => {
  const byId = new Map<string, number>();
  let n = 0;
  for (const e of entries) if (isMessageEntry(e)) byId.set(e.id, n++);
  return byId;
};

export const loadAllMessages = (source: RecallSource, full: boolean, allowedEntryIds?: Set<string>): LoadedMessages => {
  const rendered: RenderedEntry[] = [];
  const rawMessages: RawMessage[] = [];
  // a tool message carries no tool names: they come from the calls before it
  const names = new Map<string, string>();
  let messageIndex = 0;
  for (const e of source.all) {
    if (!isMessageEntry(e)) continue;
    let msg: RawMessage = e.message;
    if (msg.role === "assistant") for (const c of msg.toolCalls) names.set(c.id, c.name);
    if (msg.role === "tool") msg = { ...msg, toolNames: msg.results.map((r) => names.get(r.id) ?? "") };
    if (!allowedEntryIds || allowedEntryIds.has(e.id)) {
      rendered.push(renderMessage(msg, messageIndex, full));
      rawMessages.push(msg);
    }
    messageIndex++;
  }
  return { rendered, rawMessages };
};

/**
 * The session as one recall call sees it. Scope is applied here, once, and
 * every action reads through it. Loads are cached per call.
 */
export interface RecallView {
  source: RecallSource;
  scope: RecallScope;
  /** for shortening paths */
  cwd: string;
  load(full: boolean): LoadedMessages;
  /** The same session with scope:'all' (itself when already 'all'). */
  widen(): RecallView;
  /**
   * #N of the turn in progress on the active path (its last user message and
   * everything after it), all in the agent's context. Empty when there is no
   * turn in progress or the context was compacted inside it.
   */
  currentTurn(): Set<number>;
}

export const openRecallView = (source: RecallSource, scope: RecallScope, cwd: string): RecallView => {
  const lineageEntryIds = scope === "lineage" ? new Set(source.branch.map((e) => e.id)) : undefined;
  const cache = new Map<boolean, LoadedMessages>();
  let wide: RecallView | undefined;
  let turn: Set<number> | undefined;
  const view: RecallView = {
    source,
    scope,
    cwd,
    load(full) {
      let loaded = cache.get(full);
      if (!loaded) {
        loaded = loadAllMessages(source, full, lineageEntryIds);
        cache.set(full, loaded);
      }
      return loaded;
    },
    widen() {
      if (scope === "all") return view;
      wide ??= openRecallView(source, "all", cwd);
      return wide;
    },
    currentTurn() {
      turn ??= findCurrentTurn(source);
      return turn;
    },
  };
  return view;
};

/**
 * Walk the active path back to the last user message. The tool runs from an
 * agent message already written, so a turn is in progress only when
 * something follows that user message; a compaction in between means the
 * start of the turn may have left the context.
 */
const findCurrentTurn = (source: RecallSource): Set<number> => {
  const none = new Set<number>();
  const branch = source.branch;
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === COMPACTION_ENTRY) return none;
    if (isMessageEntry(e) && e.message.role === "user") break;
  }
  const { rendered } = loadAllMessages(source, false, new Set(branch.map((e) => e.id)));
  for (let i = rendered.length - 1; i >= 0; i--) {
    if (rendered[i].role !== "user") continue;
    return i < rendered.length - 1 ? new Set(rendered.slice(i).map((m) => m.index)) : none;
  }
  return none;
};

/**
 * When the current conversation path has nothing for a query, range or
 * #N:path, recall answers from edited or retried branches instead and says so
 * on the first line. An explicit scope:'all' never needs this.
 */
const OFF_PATH_NOTE = "Nothing on the current conversation path; showing edited or retried branches (scope:'all').\n\n";

export const invalidExpandIndices = (requested: number[], available: Set<number>): number[] =>
  requested.filter((i) => !Number.isInteger(i) || !available.has(i));

/** Surface-specific wording: the tool says page:N, the command says /pi-vcc-recall … page:N. */
export interface RecallPagingHints {
  outOfRange(query: string, scope: RecallScope, totalPages: number, truncated: boolean): string;
  nextPage(query: string, scope: RecallScope, page: number): string;
  /** Next step after a search page, pointing at its first hit. The command has none. */
  aroundHit?(index: number, scope: RecallScope): string;
  /**
   * Leave the current turn (last user message on the path and everything after
   * it) out of search: the agent has it in context, and its question would
   * otherwise match itself. Only the tool sets this; a /pi-vcc-recall command
   * adds no user message, so the last one there belongs to a finished turn.
   */
  skipCurrentTurn?: boolean;
}

const IGNORED_REASON: Record<RecallRequest["action"]["kind"], string> = {
  drill: "a #N:path query runs alone",
  touched: "mode:'touched' runs alone",
  expand: "expand runs alone; send the rest in a separate call",
  range: "range runs alone; send the rest in a separate call",
  search: "",
  recent: "page applies to query or range results",
};

/** One line naming params the action did not use, so nothing is dropped silently. */
export const ignoredNote = (request: RecallRequest): string =>
  (request.dropped?.length ? `Ignored: ${request.dropped.join(", ")}.\n\n` : "") +
  (request.ignored?.length
    ? `Ignored: ${request.ignored.join(", ")} (${IGNORED_REASON[request.action.kind]}).\n\n`
    : "");

/** Ceiling for one recall result, the 50 KB of Pi's read tool: one long entry
 *  (a base64 image on one line) must not flood the context. */
export const RECALL_OUTPUT_CHARS = 50 * 1024;

const capOutput = (text: string): string => {
  if (text.length <= RECALL_OUTPUT_CHARS) return text;
  // Never split a surrogate pair.
  const end = /[\uD800-\uDBFF]/.test(text[RECALL_OUTPUT_CHARS - 1]) ? RECALL_OUTPUT_CHARS - 1 : RECALL_OUTPUT_CHARS;
  return (
    `Warning: output clipped at ${end} of ${text.length} chars (one recall result is capped at 50 KB). ` +
    `Ask for less at once: fewer expand indices, a narrower query, or a line range for file content ('#N:path:offset:limit').\n\n` +
    `${text.slice(0, end)}\n...[clipped at 50 KB]`
  );
};

export const runRecall = (request: RecallRequest, view: RecallView, hints: RecallPagingHints): string =>
  capOutput(ignoredNote(request) + runAction(request, view, hints));

const runAction = (request: RecallRequest, view: RecallView, hints: RecallPagingHints): string => {
  const { action } = request;
  const scopeAll = view.scope === "all";

  switch (action.kind) {
    case "drill": {
      // expandEntryFile loads unfiltered so #N stays aligned with the global
      // message index; scope only decides whether the entry is off-path.
      const t = action.target;
      const offPath = !scopeAll && !view.load(false).rendered.some((m) => m.index === t.index);
      return (
        (offPath ? OFF_PATH_NOTE : "") +
        expandEntryFile(view.widen().load(true), t.index, t.pathPattern, t.full, t.offset, t.limit)
      );
    }

    case "touched":
      return runTouched(action.page, view);

    case "expand":
      return runExpand(action.indices, view);

    case "range":
      return runRange(action.range, action.page, view);

    case "search":
      return runSearch(action.query, action.page, view, hints, hints.skipCurrentTurn ? view.currentTurn() : undefined);

    case "recent": {
      const { rendered } = view.load(false);
      return (scopeAll ? "Scope: all\n\n" : "") + formatRecallOutput(rendered.slice(-RECENT_COUNT), action.query);
    }
  }
};

/** Tool output shown with an expanded call, clipped so one expand cannot flood the context. */
export const PAIRED_RESULT_CHARS = 4000;

const toolCallIds = (msg: RawMessage | undefined): string[] =>
  msg?.role === "assistant" ? msg.toolCalls.map((c) => c.id) : [];

/**
 * Full text of the requested entries. An expanded tool call brings its tool
 * results along (matched by toolCallId, clipped to PAIRED_RESULT_CHARS), so
 * the agent does not have to know the result sits at a later #N. Entries off
 * the current path are served from the whole session and named in a note.
 */
const runExpand = (indices: number[], view: RecallView): string => {
  const pools = view.scope === "all" ? [view] : [view, view.widen()];
  const lookup = (i: number) => {
    for (const v of pools) {
      const { rendered, rawMessages } = v.load(true);
      const pos = rendered.findIndex((m) => m.index === i);
      if (pos >= 0) return { entry: rendered[pos], raw: rawMessages[pos], v, pos };
    }
    return undefined;
  };

  const found = indices.map((i) => ({ i, hit: Number.isInteger(i) ? lookup(i) : undefined }));
  const invalid = found.filter((f) => !f.hit).map((f) => f.i);
  if (invalid.length > 0) return `Cannot expand indices outside session history: ${invalid.join(", ")}`;

  const offPath = found.filter((f) => f.hit?.v !== view).map((f) => `#${f.i}`);
  const requested = new Set(indices);
  const out: SearchHit[] = [];
  for (const { hit } of found) {
    const { entry, raw, v, pos } = hit as NonNullable<typeof hit>;
    out.push(entry);
    const ids = new Set(toolCallIds(raw));
    if (ids.size === 0) continue;
    const { rendered, rawMessages } = v.load(true);
    for (let j = pos + 1; j < rendered.length && ids.size > 0; j++) {
      const r = rawMessages[j];
      // A call's results come before the next assistant message; past it, a
      // reused id (after an interrupted call) belongs to a later call.
      if (r?.role === "assistant") break;
      // hortus answers a reply's calls in one tool message
      if (r?.role !== "tool" || !r.results.some((x) => ids.has(x.id))) continue;
      for (const x of r.results) ids.delete(x.id);
      const res = rendered[j];
      if (requested.has(res.index)) continue;
      const summary =
        res.summary.length > PAIRED_RESULT_CHARS
          ? `${res.summary.slice(0, PAIRED_RESULT_CHARS)}\n...[result of #${entry.index} clipped at ${PAIRED_RESULT_CHARS} of ${res.summary.length} chars; expand:[${res.index}] for all of it]`
          : res.summary;
      out.push({ ...res, summary });
    }
  }

  const header = `Expanded ${indices.map((i) => `#${i}`).join(", ")}`;
  const note =
    offPath.length > 0
      ? `${offPath.join(", ")} ${offPath.length === 1 ? "is" : "are"} not on the current conversation path (edited or retried branch).\n\n`
      : "";
  return (view.scope === "all" ? "Scope: all\n\n" : "") + note + formatRecallOutput(out, undefined, header);
};

/**
 * Entries #from..#to in order, RANGE_PAGE_SIZE per page, same per-entry clip
 * as search and recent. Indices are the global #N space shared with summaries
 * (global-indices.ts), so a ref copied from a summary lands on its message.
 */
const runRange = (range: unknown[], page: number, view: RecallView): string => {
  const [from, to] = range;
  if (
    range.length !== 2 ||
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    (from as number) < 0 ||
    (from as number) > (to as number)
  ) {
    return `Invalid range ${JSON.stringify(range)}: use range:[from, to] with two #N indices, from <= to.`;
  }
  const lo = from as number;
  let hi = to as number;
  const scopeAll = view.scope === "all";
  const { rendered } = view.load(false);
  const entries = rendered.filter((m) => m.index >= lo && m.index <= hi);

  if (entries.length === 0) {
    if (!scopeAll) {
      const wide = view.widen();
      if (wide.load(false).rendered.some((m) => m.index >= lo && m.index <= hi)) {
        return OFF_PATH_NOTE + runRange(range, page, wide);
      }
    }
    const last = rendered[rendered.length - 1];
    return `No messages #${lo}..#${hi} in session history${last ? ` (last entry is #${last.index})` : ""}.`;
  }

  // A range past the end is read up to the last entry, and the header says so.
  const lastIndex = rendered[rendered.length - 1].index;
  const clamped = hi > lastIndex;
  if (clamped) hi = lastIndex;

  const totalPages = Math.ceil(entries.length / RANGE_PAGE_SIZE);
  const counts = `${entries.length} messages${scopeAll ? ", scope: all" : ""}${clamped ? `, #${hi} is the last entry` : ""}`;
  if (page > totalPages) {
    return `Page ${page} is outside the available range 1-${totalPages} (#${lo}..#${hi}: ${counts}). Use a page between 1 and ${totalPages}.`;
  }
  const start = (page - 1) * RANGE_PAGE_SIZE;
  const header =
    totalPages > 1
      ? `Range #${lo}..#${hi}, page ${page}/${totalPages} (${counts})`
      : `Range #${lo}..#${hi} (${counts})`;
  const footer =
    page < totalPages
      ? `\n--- Use range:[${lo}, ${hi}] page:${page + 1}${scopeAll ? " scope:'all'" : ""} for the next ${RANGE_PAGE_SIZE} ---`
      : "";
  return formatRecallOutput(entries.slice(start, start + RANGE_PAGE_SIZE), undefined, header) + footer;
};

/**
 * Search with the current turn left out of the corpus, not just out of the
 * results: filtering afterwards let turn entries win the regex path (so the
 * term fallback never ran), set the relative floor, and fill the hit cap,
 * which hid earlier matches.
 */
const searchBefore = (view: RecallView, query: string, skip: Set<number> | undefined) => {
  const { rendered, rawMessages } = view.load(false);
  if (!skip?.size) return searchEntriesDetailed(rendered, rawMessages, query);
  const keep = rendered.map((m) => !skip.has(m.index));
  return searchEntriesDetailed(
    rendered.filter((_, i) => keep[i]),
    rawMessages.filter((_, i) => keep[i]),
    query,
  );
};

const runSearch = (
  query: string,
  page: number,
  view: RecallView,
  hints: RecallPagingHints,
  skip?: Set<number>,
): string => {
  const { hits, totalBeforeCap, truncated } = searchBefore(view, query, skip);
  if (hits.length === 0 && view.scope === "lineage") {
    const wide = view.widen();
    if (searchBefore(wide, query, skip).hits.length > 0) {
      return OFF_PATH_NOTE + runSearch(query, page, wide, hints, skip);
    }
  }
  if (hits.length === 0 && skip?.size) {
    const inTurn = searchEntriesDetailed(view.load(false).rendered, view.load(false).rawMessages, query).hits.filter(
      (h) => skip.has(h.index),
    ).length;
    if (inTurn > 0) {
      return `No earlier matches for "${query}"; its ${inTurn} match${inTurn === 1 ? " is" : "es are"} in the current turn, which is already in your context.`;
    }
  }
  // Single source of truth for page count: hits.length, the same array
  // that's actually paginated below (already floor-filtered and capped).
  const totalPages = Math.ceil(hits.length / SEARCH_PAGE_SIZE);
  const scopeSuffix = view.scope === "all" ? " (scope: all)" : "";
  // The hard cap can discard genuine matches; hits.length alone would then
  // understate the real total. Say so explicitly. Neutral wording ("showing",
  // not "showing top"): regex-path hits are chronological with no relevance
  // score, so "top" would falsely imply a ranking only the BM25 path has.
  const truncationNote = truncated
    ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results`
    : "";

  // The hard cap creates a fixed reachable page range (1..totalPages). A page
  // beyond it isn't "no matches": say which pages exist instead of falling
  // through to formatRecallOutput's zero-hit message, which would be false.
  if (hits.length > 0 && page > totalPages) {
    return (
      `Page ${page} is outside the available range 1-${totalPages} ` +
      `(${hits.length} matches${scopeSuffix}${truncationNote}). ` +
      hints.outOfRange(query, view.scope, totalPages, truncated)
    );
  }

  const start = (page - 1) * SEARCH_PAGE_SIZE;
  const pageHits = hits.slice(start, start + SEARCH_PAGE_SIZE);
  const header =
    totalPages > 1
      ? `Page ${page}/${totalPages} (${hits.length} total matches${scopeSuffix}${truncationNote})`
      : `${hits.length} matches${scopeSuffix}${truncationNote}`;
  const around = pageHits.length > 0 && hints.aroundHit ? hints.aroundHit(pageHits[0].index, view.scope) : "";
  const footer = page < totalPages ? hints.nextPage(query, view.scope, page + 1) : "";
  return formatRecallOutput(pageHits, query, header) + around + footer;
};

const WRITES_FILE = /write|edit|patch/i;

/** Files worked on, plus a ready #N:path call for the first file on the page that was written. */
const runTouched = (page: number | undefined, view: RecallView): string => {
  const { rendered, rawMessages } = view.load(false);
  const touched = getTouchedFiles(rawMessages, rendered);
  const text = formatTouchedOutput(touched, view.cwd, page);
  const start = (Math.max(1, page ?? 1) - 1) * TOUCHED_PAGE_SIZE;
  for (const tf of touched.slice(start, start + TOUCHED_PAGE_SIZE)) {
    const write = [...tf.entries].reverse().find((e) => e.drillable !== false && WRITES_FILE.test(e.toolName));
    if (!write) continue;
    const name = tf.path.replace(/\\/g, "/").split("/").pop();
    return `${text}\n--- File content at an entry: query:'#${write.index}:${name}' ---`;
  }
  return text;
};
