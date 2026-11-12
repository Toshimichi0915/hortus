/** pi-vcc's summary: normalize, sections, merge with the previous summary; ported from @sting8k/pi-vcc 0.11.2 (MIT). */
import type { Message } from "@hortus/core";
import { type BriefRankingOptions, buildBriefSections, selectRankedBriefBlocks, stringifyBrief } from "./brief.ts";
import {
  COMMAND_SEPARATOR,
  capItems,
  COMMANDS_PER_NAME,
  EARLY_REQUESTS_KEPT,
  extractCommits,
  extractFiles,
  extractTrackedCommands,
  extractUserMessages,
  type FileOps,
  formatCommits,
  formatTrackedCommands,
  keepNewestUserMessages,
  type NormalizedBlock,
  sanitize,
} from "./extract.ts";

// ── sections.ts ──
export interface SectionData {
  earlyRequests: string[];
  filesAndChanges: string[];
  commits: string[];
  userMessages: string[];
  /** Populated only when settings.trackCommands is non-empty -- see
   * core/settings.ts. Empty array otherwise, same as any other section
   * with nothing to report. */
  trackedCommands: string[];
  briefTranscript: string;
}

// ── core/filter-noise.ts ──

const NOISE_TOOLS = new Set([
  "TodoWrite",
  "TodoRead",
  "ToolSearch",
  "WebSearch",
  "AskUser",
  "ExitSpecMode",
  "GenerateDroid",
]);

const NOISE_STRINGS = [
  "Continue from where you left off.",
  "No response requested.",
  "IMPORTANT: TodoWrite was not called yet.",
];

const XML_WRAPPER_RE = /<(system-reminder|ide_opened_file|command-message|context-window-usage)[^>]*>[\s\S]*?<\/\1>/g;

const isNoiseUserBlock = (text: string): boolean => {
  const trimmed = text.trim();
  if (NOISE_STRINGS.some((s) => trimmed.includes(s))) return true;
  const stripped = trimmed.replace(XML_WRAPPER_RE, "").trim();
  return stripped.length === 0;
};

const cleanUserText = (text: string): string => text.replace(XML_WRAPPER_RE, "").trim();

export const filterNoise = (blocks: NormalizedBlock[]): NormalizedBlock[] => {
  const out: NormalizedBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "tool_call" && NOISE_TOOLS.has(b.name)) continue;
    if (b.kind === "tool_result" && NOISE_TOOLS.has(b.name)) continue;
    if (b.kind === "user") {
      if (isNoiseUserBlock(b.text)) continue;
      const cleaned = cleanUserText(b.text);
      if (!cleaned) continue;
      out.push({ kind: "user", text: cleaned, ...(b.injected ? { injected: true } : {}) });
      continue;
    }
    out.push(b);
  }
  return out;
};

// ── core/format.ts ──

const section = (title: string, items: string[]): string => {
  if (items.length === 0) return "";
  const body = items.map((i) => `- ${i}`).join("\n");
  return `[${title}]\n${body}`;
};

/** Files listed per Files And Changes category; the newest are kept. */
export const FILES_PER_CATEGORY = 10;

/** Also strips the trailing "(+N more)" that older versions wrote. */
export const stripCapMarker = (text: string): string =>
  text.replace(/^\s*\(\+\d+ earlier\)\s*/, "").replace(/\s*\(\+\d+ (?:more|earlier)\)\s*$/, "");

export const BRIEF_MAX_LINES = 120;
const TUI_SAFE_LINE_CHARS = 120;

const wrapLine = (line: string, maxChars: number): string[] => {
  if (line.length <= maxChars) return [line];

  const indent = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)?/)?.[0] ?? "";
  const continuationIndent = indent ? " ".repeat(Math.min(indent.length, 8)) : "";
  const wrapped: string[] = [];
  let remaining = line;
  let prefix = "";

  while (prefix.length + remaining.length > maxChars) {
    const available = Math.max(20, maxChars - prefix.length);
    let splitAt = remaining.lastIndexOf(" ", available);
    if (splitAt < Math.floor(available * 0.5)) splitAt = available;

    wrapped.push(prefix + remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
    prefix = continuationIndent;
  }

  if (remaining) wrapped.push(prefix + remaining);
  return wrapped;
};

export const wrapLongLines = (text: string, maxChars = TUI_SAFE_LINE_CHARS): string =>
  text
    .split("\n")
    .flatMap((line) => wrapLine(line, maxChars))
    .join("\n");

export const capBrief = (text: string): string => {
  const lines = text.split("\n");
  if (lines.length <= BRIEF_MAX_LINES) return text;
  const omitted = lines.length - BRIEF_MAX_LINES;
  const kept = lines.slice(-BRIEF_MAX_LINES);
  // Find first section header to avoid cutting mid-section
  const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};

export const RECALL_NOTE =
  "Use `vcc_recall` to search for prior work, decisions, and context from before this summary. " +
  "Do not redo work already completed.";

export interface FormatSummaryOptions {
  capBriefTranscript?: boolean;
}

export const formatSummary = (data: SectionData, options: FormatSummaryOptions = {}): string => {
  const capBriefTranscript = options.capBriefTranscript ?? true;
  const headerParts = [
    section("Early Session Requests", data.earlyRequests),
    section("Files And Changes", data.filesAndChanges),
    section("Commits", data.commits),
    section("Tracked Commands", data.trackedCommands),
    section("User Messages", data.userMessages),
  ].filter(Boolean);

  const parts: string[] = [];
  if (headerParts.length > 0) {
    parts.push(headerParts.join("\n\n"));
  }
  if (data.briefTranscript) {
    parts.push(capBriefTranscript ? capBrief(data.briefTranscript) : data.briefTranscript);
  }

  if (parts.length === 0) return "";

  // NOTE: RECALL_NOTE is intentionally NOT appended here.
  // It is appended once by `compile()` at the very end, after merge-with-previous,
  // to avoid the note compounding inside the brief transcript across compactions.
  return wrapLongLines(parts.join("\n\n---\n\n"));
};

// ── core/build-sections.ts ──

export interface BuildSectionsInput {
  blocks: NormalizedBlock[];
  briefBlocks?: NormalizedBlock[];
  /** Hook-provided file activity; authoritative for files touched before this compaction. */
  fileOps?: FileOps;
  /** Command names to record in a [Tracked Commands] section (see
   * PiVccSettings.trackCommands). Empty/omitted = section stays empty. */
  trackCommands?: readonly string[];
  /** The previous summary already holds the early requests, so this
   * compaction's first messages are ordinary user messages. */
  hasEarlyRequests?: boolean;
}

const formatFileActivity = (blocks: NormalizedBlock[], fileOps?: FileOps): string[] => {
  const act = extractFiles(blocks, fileOps);
  // Dedup: if already Modified, drop from Created (file existed before)
  for (const p of act.modified) act.created.delete(p);
  const lines: string[] = [];
  const cap = (set: Set<string>) => capItems([...set], FILES_PER_CATEGORY, ", ");
  if (act.modified.size > 0) lines.push(`Modified: ${cap(act.modified)}`);
  if (act.created.size > 0) lines.push(`Created: ${cap(act.created)}`);
  if (act.read.size > 0) lines.push(`Read: ${cap(act.read)}`);
  return lines;
};

export const buildSections = (input: BuildSectionsInput): SectionData => {
  const { blocks } = input;
  const briefSections = buildBriefSections(input.briefBlocks ?? blocks);
  // The early requests are the session's first user messages, picked by
  // position; they are not repeated in [User Messages].
  const messages = extractUserMessages(blocks);
  const early = input.hasEarlyRequests ? [] : messages.slice(0, EARLY_REQUESTS_KEPT);
  return {
    earlyRequests: early,
    filesAndChanges: formatFileActivity(blocks, input.fileOps),
    commits: formatCommits(extractCommits(blocks)),
    userMessages: keepNewestUserMessages(messages.slice(early.length)),
    trackedCommands: formatTrackedCommands(extractTrackedCommands(blocks, input.trackCommands ?? [])),
    briefTranscript: stringifyBrief(briefSections),
  };
};

// ── core/normalize.ts (hortus messages) ──

/**
 * hortus messages to blocks. A plugin's user message (`meta`) is `injected`, as pi-vcc marks a custom_message; a tool
 * message gives one block per result, named after its call. `sourceIndices`, when provided, supplies the
 * session-global `#N` index per input position; a missing entry yields no ref. Omitted, positions are used.
 */
export const normalize = (
  messages: readonly Message[],
  sourceIndices?: Array<number | undefined>,
): NormalizedBlock[] => {
  const names = new Map(
    messages.flatMap((m) => (m.role === "assistant" ? m.toolCalls.map((c) => [c.id, c.name]) : [])),
  );
  return messages.flatMap((msg, i): NormalizedBlock[] => {
    const sourceIndex = sourceIndices ? sourceIndices[i] : i;
    if (msg.role === "user") {
      const blocks: NormalizedBlock[] = [];
      const text = sanitize(msg.content);
      if (text) blocks.push({ kind: "user", text, sourceIndex, ...(msg.meta ? { injected: true } : {}) });
      for (const img of msg.images ?? []) blocks.push({ kind: "user", text: `[image: ${img.mediaType}]`, sourceIndex });
      return blocks.length > 0 ? blocks : [{ kind: "user", text: "", sourceIndex }];
    }
    if (msg.role === "tool")
      return msg.results.map((r) => ({
        kind: "tool_result",
        name: names.get(r.id) ?? "",
        text: sanitize(r.output),
        sourceIndex,
      }));
    return [
      ...(msg.text ? [{ kind: "assistant" as const, text: sanitize(msg.text), sourceIndex }] : []),
      ...msg.toolCalls.map((c) => ({
        kind: "tool_call" as const,
        name: c.name,
        args: (c.input ?? {}) as Record<string, unknown>,
        sourceIndex,
      })),
    ];
  });
};

// ── core/summarize.ts ──

export interface CompileInput {
  messages: readonly Message[];
  previousSummary?: string;
  fileOps?: FileOps;
  /**
   * Session-global `#N` index per message position (see
   * src/core/global-indices.ts). Parallel to `messages`; a missing entry
   * renders as no ref (fail-closed). Omitted entirely → legacy positional.
   */
  sourceIndices?: Array<number | undefined>;
  /** See BuildSectionsInput.trackCommands (core/build-sections.ts) --
   * empty/omitted by default, threaded through from
   * PiVccSettings.trackCommands by the caller (hooks/before-compact.ts). */
  trackCommands?: readonly string[];
}

export interface RankedCompileInput extends CompileInput {
  ranking?: BriefRankingOptions;
}

const EARLY = "Early Session Requests";
const HEADER_NAMES = [EARLY, "Files And Changes", "Commits", "Tracked Commands", "User Messages"];

const SEPARATOR = "\n\n---\n\n";

// A header section is a "[Title Case]" line standing alone in the header area
// (the text before the first separator) plus the lines up to the next blank
// line; sections are joined by blank lines and have none inside. The brief
// transcript's blocks are "[user]" / "[assistant]", and a transcript line can
// start with "[Some Title]" followed by more text, so a header is never found
// by searching the text for "[Title]". Matching the shape, not a list of names,
// also bounds sections written by older versions (e.g. [Outstanding Context]).
const HEADER_LINE_RE = /^\[[A-Z][^\]\n]*\]$/;

/** Header area and brief transcript. Without a leading header line the whole
 * text is the brief; header sections only (no separator) have no brief. */
const splitSummary = (text: string): { head: string; brief: string } => {
  if (!HEADER_LINE_RE.test(text.split("\n", 1)[0])) return { head: "", brief: text.trim() };
  const idx = text.indexOf(SEPARATOR);
  if (idx < 0) return { head: text, brief: "" };
  return { head: text.slice(0, idx), brief: text.slice(idx + SEPARATOR.length).trim() };
};

/** Extract a named section from summary text */
export const sectionOf = (text: string, header: string): string => {
  const lines = splitSummary(text).head.split("\n");
  const start = lines.indexOf(`[${header}]`);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== "") end++;
  return lines.slice(start, end).join("\n").trim();
};

export const briefOf = (text: string): string => splitSummary(text).brief;

const isClean = (l: string) => l.startsWith("- ") && !l.includes("<skill") && !l.includes("</skill");
// Both summaries went through wrapLongLines (the fresh one in formatSummary);
// rejoin each item's indented continuation lines so the merges, which read
// only "- " lines, see whole items.
const unwrapSection = (text: string, header: string) => sectionOf(text, header).replace(/\n[ \t]+(?=\S)/g, " ");

/**
 * The previous summary's early requests, kept as they are: the first summary
 * sets them. An older version's [Session Goal] gives its first real line
 * (not a "- [skill: x]" / "- [Scope change]" marker).
 */
const pinnedEarlyRequests = (prev: string): string[] => {
  const early = unwrapSection(prev, EARLY).split("\n").filter(isClean);
  if (early.length > 0) return early.slice(0, EARLY_REQUESTS_KEPT);
  const goal = unwrapSection(prev, "Session Goal")
    .split("\n")
    .find((l) => isClean(l) && !/^- \[[^\]]*\]$/.test(l));
  return goal ? [goal] : [];
};

const COMMITS_CAP = 8;
const COMMIT_HASH_RE = /^- [0-9a-f]{7,12}: /;
const bareCommit = (line: string): string => line.replace(COMMIT_HASH_RE, "- ");

/** One line per commit, first-seen order. A hashless line is the same commit
 * as a hashed line with its message (one side did not capture the hash): keep
 * the hashed one, in the earlier line's place. */
const dedupCommitLines = (lines: string[]): string[] => {
  const out: string[] = [];
  for (const line of lines) {
    if (out.includes(line)) continue;
    const bare = bareCommit(line);
    if (COMMIT_HASH_RE.test(line)) {
      const hashless = out.indexOf(bare);
      if (hashless >= 0) out[hashless] = line;
      else out.push(line);
    } else if (!out.some((o) => bareCommit(o) === bare)) {
      out.push(line);
    }
  }
  return out;
};

/** Merge a header section */
const mergeHeaderSection = (header: string, prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return prev;

  // Files And Changes: merge by category (Modified/Created/Read), dedup paths
  if (header === "Files And Changes") {
    return mergeFileLines(prev, fresh);
  }

  // Tracked Commands: same categorized-merge shape as Files And Changes, but
  // categories are whatever command names the user configured in
  // trackCommands -- discover them from the actual text rather than a
  // fixed list, so a config change between compactions doesn't orphan a
  // category that was already recorded.
  if (header === "Tracked Commands") {
    return mergeTrackedCommandLines(prev, fresh);
  }

  const prevLines = prev.split("\n").filter(isClean);
  const freshLines = fresh.split("\n").filter(isClean);

  if (header === "User Messages") {
    return `[${header}]\n${keepNewestUserMessages([...prevLines, ...freshLines]).join("\n")}`;
  }

  // Commits: one line per commit, cap
  const capped = dedupCommitLines([...prevLines, ...freshLines]).slice(-COMMITS_CAP);
  if (capped.length === 0) return "";
  return `[${header}]\n${capped.join("\n")}`;
};

/**
 * Generic categorized-section merge: parses "- Category: a, b, c (+N more)"
 * lines from both prev and fresh text, unions each category's items across
 * compactions (deduped via Set), and re-renders. Extracted from what used
 * to be Files And Changes' only inline implementation, in preparation for
 * a second categorized section reusing the identical shape (see the
 * follow-up `feat/track-commands-section` branch/PR).
 */
const mergeCategorizedLines = (
  categories: readonly string[],
  prev: string,
  fresh: string,
  splitOn: string,
  touchOnDup = false,
): Record<string, Set<string>> => {
  const merged: Record<string, Set<string>> = {};
  for (const cat of categories) merged[cat] = new Set();

  for (const text of [prev, fresh]) {
    for (const line of text.split("\n")) {
      for (const cat of categories) {
        const prefix = `- ${cat}: `;
        if (!line.startsWith(prefix)) continue;
        // Strip the overflow marker so it never merges back in as an entry.
        const rest = stripCapMarker(line.slice(prefix.length));
        for (const p of rest.split(splitOn)) {
          const trimmed = p.trim();
          if (!trimmed) continue;
          // touchOnDup: re-inserting an existing entry moves it to the
          // tail — with tail-capping this makes the section "N most-
          // recently-USED" rather than "N most-recently-first-seen".
          if (touchOnDup && merged[cat].has(trimmed)) merged[cat].delete(trimmed);
          merged[cat].add(trimmed);
        }
      }
    }
  }
  return merged;
};

const formatCategorizedLines = (
  header: string,
  merged: Record<string, Set<string>>,
  categories: readonly string[],
  joinWith: string,
  itemLimit: number,
): string => {
  const lines: string[] = [];
  for (const cat of categories) {
    if (merged[cat].size > 0) lines.push(`- ${cat}: ${capItems([...merged[cat]], itemLimit, joinWith)}`);
  }
  if (lines.length === 0) return "";
  return `[${header}]\n${lines.join("\n")}`;
};

const FILE_CATEGORIES = ["Modified", "Created", "Read"] as const;

/** Merge Files And Changes by category, dedup paths across compactions */
const mergeFileLines = (prev: string, fresh: string): string => {
  // Newest-last with re-touched files moved to the end, so the capped list
  // follows the files being worked on instead of freezing on the first ones.
  const merged = mergeCategorizedLines(FILE_CATEGORIES, prev, fresh, ",", true);
  // Dedup: if already in Modified, drop from Created (file existed before)
  for (const p of merged.Modified) merged.Created.delete(p);
  return formatCategorizedLines("Files And Changes", merged, FILE_CATEGORIES, ", ", FILES_PER_CATEGORY);
};

/** Category names actually present in "- <name>: ..." lines in `text`. */
const discoverCategoryNames = (text: string): string[] => {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^- ([^:]+): /);
    if (m) names.add(m[1]);
  }
  return [...names];
};

/**
 * Merge Tracked Commands by whatever command names actually appear in prev/
 * fresh (not a fixed category list, since trackCommands is user-config).
 * Line format (separator, cap) is owned by extract/tracked-commands.ts.
 */
const mergeTrackedCommandLines = (prev: string, fresh: string): string => {
  const categories = [...new Set([...discoverCategoryNames(prev), ...discoverCategoryNames(fresh)])];
  const merged = mergeCategorizedLines(categories, prev, fresh, COMMAND_SEPARATOR, true);
  return formatCategorizedLines("Tracked Commands", merged, categories, COMMAND_SEPARATOR, COMMANDS_PER_NAME);
};

const mergeBriefTranscript = (prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return prev;
  return `${prev}\n\n${fresh}`;
};

const briefLineCount = (text: string): number => (text ? text.split("\n").length : 0);

const capBriefToLineBudget = (text: string, maxLines: number): string => {
  if (!text || maxLines <= 0) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(-maxLines);
  const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  const omitted = lines.length - clean.length;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};

const mergeBriefTranscriptWithFreshBudget = (prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return capBrief(prev);
  const freshLines = briefLineCount(fresh);
  const remainingPrevLines = Math.max(0, BRIEF_MAX_LINES - freshLines);
  const prevTail = capBriefToLineBudget(prev, remainingPrevLines);
  return prevTail ? `${prevTail}\n\n${fresh}` : fresh;
};

const mergePrevious = (prev: string, fresh: string, options: { preserveFreshBrief?: boolean } = {}): string => {
  // Merge header sections
  const early = pinnedEarlyRequests(prev);
  const headers = HEADER_NAMES.map((header) => {
    if (header === EARLY && early.length > 0) return `[${EARLY}]\n${early.join("\n")}`;
    return mergeHeaderSection(header, unwrapSection(prev, header), unwrapSection(fresh, header));
  }).filter(Boolean);

  // Merge brief transcript
  const prevBrief = briefOf(prev);
  const freshBrief = briefOf(fresh);
  const mergedBrief = options.preserveFreshBrief
    ? mergeBriefTranscriptWithFreshBudget(prevBrief, freshBrief)
    : mergeBriefTranscript(prevBrief, freshBrief);

  const parts: string[] = [];
  if (headers.length > 0) {
    parts.push(headers.join("\n\n"));
  }
  if (mergedBrief) {
    parts.push(options.preserveFreshBrief ? mergedBrief : capBrief(mergedBrief));
  }

  return parts.join(SEPARATOR);
};

interface CompileWithBriefBlocksOptions {
  briefBlocksFor?: (blocks: ReturnType<typeof normalize>) => ReturnType<typeof normalize>;
  capFreshBrief?: boolean;
  preserveFreshBriefOnMerge?: boolean;
}

const compileWithBriefBlocks = (input: CompileInput, options: CompileWithBriefBlocksOptions = {}): string => {
  const blocks = filterNoise(normalize(input.messages, input.sourceIndices));
  const briefBlocks = options.briefBlocksFor?.(blocks);
  // Strip any legacy RECALL_NOTE baked into prev summary (pre-fix format)
  // so merge doesn't re-stack it inside the brief.
  const prev = input.previousSummary ? stripRecallNote(input.previousSummary) : undefined;
  const hasEarlyRequests = prev !== undefined && pinnedEarlyRequests(prev).length > 0;
  const data = buildSections({
    blocks,
    briefBlocks,
    fileOps: input.fileOps,
    trackCommands: input.trackCommands,
    hasEarlyRequests,
  });
  const fresh = formatSummary(data, { capBriefTranscript: options.capFreshBrief ?? true });
  const merged = prev ? mergePrevious(prev, fresh, { preserveFreshBrief: options.preserveFreshBriefOnMerge }) : fresh;
  if (!merged) return "";
  return wrapLongLines(merged + SEPARATOR + RECALL_NOTE);
};

export const compile = (input: CompileInput): string => compileWithBriefBlocks(input);

export const compileRanked = (input: RankedCompileInput): string =>
  compileWithBriefBlocks(input, {
    briefBlocksFor: (blocks) =>
      selectRankedBriefBlocks(blocks, {
        ...input.ranking,
        fileOps: input.ranking?.fileOps ?? input.fileOps,
      }),
    capFreshBrief: false,
    preserveFreshBriefOnMerge: true,
  });

/**
 * RECALL_NOTE as stored: wrapLongLines breaks it across lines (it is longer
 * than the wrap width), so match its words separated by any whitespace,
 * together with the separator in front of it.
 */
const RECALL_NOTE_RE = new RegExp(
  "\\n*(?:---\\n+)?" +
    RECALL_NOTE.split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+") +
    "\\n*",
  "g",
);

/**
 * Remove every RECALL_NOTE from a previous summary before merging. The exact
 * match this replaced never found the wrapped note, so each compaction kept
 * the old note inside the brief and stacked one more; this also cleans those.
 */
const stripRecallNote = (text: string): string => text.replace(RECALL_NOTE_RE, "\n\n").trimEnd();
