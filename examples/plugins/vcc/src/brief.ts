/** pi-vcc's brief transcript and its ranking, ported from @sting8k/pi-vcc 0.11.2 (MIT). */
import { clip, collapseSkillText, extractPath, extractPaths, type FileOps, type NormalizedBlock } from "./extract.ts";

// ── core/brief.ts ──

const TRUNCATE_USER = 256;
const SEGMENT_CLOSING_ASSISTANT_HEAD_WORDS = 120;
const SEGMENT_CLOSING_ASSISTANT_TAIL_WORDS = 120;
const ASSISTANT_HEAD_WORDS = 80;
const ASSISTANT_TAIL_WORDS = 120;

// Strip common self-reflective assistant prefixes that carry no semantic info.
// Conservative list: only removes the leading filler, preserves the actual content.
const SELF_TALK_PREFIX_RE = /^\s*(?:hmm|wait|actually|oh|okay|ok|well|so)[,.!\s-]+/i;

// ── noise filtering ──

const isNoiseUser = (text: string): boolean => {
  return !text.trim();
};

// ── truncation ──

// Unicode-aware word segmentation via Intl.Segmenter (built-in, zero dependency)
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Check if segment is a word (Bun's isWordLike is unreliable for alphanumeric tokens) */
const isWord = (seg: { segment: string; isWordLike?: boolean }): boolean =>
  seg.isWordLike || /[\p{L}\p{N}]/u.test(seg.segment);

// Common stop words — don't count toward budget
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
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
  "shall",
  "can",
  "need",
  "must",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "under",
  "over",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "yet",
  "both",
  "either",
  "neither",
  "each",
  "every",
  "all",
  "any",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "they",
  "them",
  "their",
  "who",
  "which",
  "what",
  "if",
  "then",
  "than",
  "when",
  "where",
  "how",
  "just",
  "also",
]);

const normalizeForTokenBudget = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const truncateTokens = (text: string, limit: number): string => {
  const flat = normalizeForTokenBudget(text);
  let count = 0;
  let lastEnd = 0;
  for (const seg of segmenter.segment(flat)) {
    if (isWord(seg)) {
      if (!STOP_WORDS.has(seg.segment.toLowerCase())) {
        count++;
        if (count > limit) {
          return `${flat.slice(0, lastEnd).trimEnd()}...(truncated)`;
        }
      }
    }
    lastEnd = seg.index + seg.segment.length;
  }
  return flat;
};

const significantWordSpans = (flat: string): { start: number; end: number }[] => {
  const words: { start: number; end: number }[] = [];
  for (const seg of segmenter.segment(flat)) {
    if (!isWord(seg)) continue;
    if (STOP_WORDS.has(seg.segment.toLowerCase())) continue;
    words.push({ start: seg.index, end: seg.index + seg.segment.length });
  }
  return words;
};

const truncateTokensHeadTail = (text: string, headLimit: number, tailLimit: number): string => {
  const flat = normalizeForTokenBudget(text);
  if (headLimit <= 0 || tailLimit <= 0) return flat;
  const words = significantWordSpans(flat);
  if (words.length <= headLimit + tailLimit) return flat;
  const head = flat.slice(0, words[headLimit - 1].end).trimEnd();
  const tail = flat.slice(words[words.length - tailLimit].start).trimStart();
  return `${head}\n...(middle truncated)...\n${tail}`;
};

const nextRenderableBlock = (blocks: NormalizedBlock[], index: number): NormalizedBlock | undefined => {
  for (let i = index + 1; i < blocks.length; i++) {
    if (blocks[i].kind !== "tool_result") return blocks[i];
  }
  return undefined;
};

const isSegmentClosingAssistant = (blocks: NormalizedBlock[], index: number): boolean => {
  if (blocks[index]?.kind !== "assistant") return false;
  const next = nextRenderableBlock(blocks, index);
  return !next || next.kind === "user";
};

// ── bash command compression ──

const BASH_CAP = 240;
const PIPE_TAIL_RE = /\s*\|\s*(?:head|tail|sort|wc|column|tr|cut|awk|uniq|python3|node|bun)(?:\s[^|]*)?$/;
// Preamble/boilerplate lines that carry no durable fact on their own. Dropped
// when a script has more informative lines, so `set -euo pipefail\ngit commit`
// renders the commit rather than the shell option.
const TRIVIAL_LINE_RE = /^(?:set\s+[-+]|cd\s+\S+$|export\s+\w+=|(?:source|\.)\s+\S+|pwd$|true$|:$|#)/;
// A real heredoc opener: `<<` at a command boundary — not preceded by a word
// char or `)`, so shift ops (`8 << 20`, `Rd<<8`) are not misread — with an
// identifier terminator starting [A-Za-z_], so numeric `<< 10` is rejected too.
export const HEREDOC_OPEN_RE = /(?<![\w)])<<-?\s*["']?([A-Za-z_]\w*)["']?/;
// File-writer heredocs (`cat > f <<EOF`, tee, dd) already name their target, so
// the opener alone is informative → body-only. EVERY other heredoc has a
// content-free opener (interpreters python3/node, remote shells `ssh host <<CMD`,
// sqlite3, ...) → we surface a one-line body preview. This denylist replaces an
// interpreter allowlist that missed ssh/sqlite3/etc. and mis-handled heredocs
// combined with a `>` redirect.
const FILEWRITER_HEREDOC_RE = /(?:^|[|&;]\s*)(?:cat|tee|dd)\b/;
const HEREDOC_BODY_CAP = 80;
// Body lines that are pure boilerplate and make a poor preview.
const BODY_NOISE_RE =
  /^(?:import\s|from\s+\S+\s+import|require\(|const\s+\w+\s*=\s*require|#|\/\/|"""|'''|"use strict"|use\s+strict|<\?php)/;

/**
 * If `lines[i]` opens a heredoc whose terminator actually appears on a later
 * line, return that terminator's line index; otherwise -1. Callers use -1 to
 * leave following lines intact instead of treating a stray `<<` (a shift op, a
 * quoted string, or a truncated body) as a heredoc and skipping real commands.
 */
export const heredocCloseIndex = (lines: string[], i: number): number => {
  const hd = lines[i].match(HEREDOC_OPEN_RE);
  if (!hd) return -1;
  const term = hd[1];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === term) return j;
  }
  return -1;
};

const stripCdPrefix = (line: string): string => line.replace(/^cd\s+\S+\s*&&\s*/, "").trim();
const stripPipeTail = (line: string): string => {
  let c = line;
  for (let i = 0; i < 3; i++) {
    const stripped = c.replace(PIPE_TAIL_RE, "");
    if (stripped === c) break;
    c = stripped;
  }
  return c.trim();
};

/**
 * Semantic compression of a (possibly multi-line) bash command.
 * 1. Drop heredoc BODIES (keep the opener line, e.g. `cat > f <<EOF` or
 *    `python3 - <<PY`): the body is prose/script content that bloats the brief
 *    without adding countable facts, while the opener still records what ran.
 * 2. Drop trivial preamble lines (set -euo pipefail, cd-only, export, source,
 *    comments) unless they are the ONLY line, so real work below them surfaces.
 * 3. Strip `cd <path> &&` prefixes and pipe-tail formatting per line.
 * 4. Join the remaining meaningful lines with `; ` and cap length.
 */
const compressBash = (raw: string): string => {
  // Pass 1: keep heredoc opener lines, skip their bodies + terminators.
  const rawLines = raw.split("\n");
  const withoutHeredocBodies: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    withoutHeredocBodies.push(line);
    // Only treat this as a heredoc when its terminator appears downstream; a
    // stray `<<` (string/expression or truncated body) leaves later lines intact.
    const close = heredocCloseIndex(rawLines, i);
    if (close === -1) continue;
    // File-writer heredocs (`cat > f <<EOF`) name their target → keep opener only.
    // Every other heredoc has a content-free opener → grab the first meaningful
    // body line as a preview (`python3 - <<PY`, `ssh host <<CMD`, `sqlite3 <<SQL`).
    const wantPreview = !FILEWRITER_HEREDOC_RE.test(line);
    let preview = "";
    for (let j = i + 1; wantPreview && !preview && j < close; j++) {
      const t = rawLines[j].trim();
      if (t && !BODY_NOISE_RE.test(t)) preview = t;
    }
    if (preview) {
      const clipped = preview.length > HEREDOC_BODY_CAP ? `${preview.slice(0, HEREDOC_BODY_CAP - 1)}\u2026` : preview;
      withoutHeredocBodies[withoutHeredocBodies.length - 1] = `${line.trim()} ${clipped}`;
    }
    i = close; // for-loop's i++ then skips past the terminator line
  }

  const lines = withoutHeredocBodies.map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return raw.trim();

  const meaningful = lines
    .filter((l) => !TRIVIAL_LINE_RE.test(l))
    .map((l) => stripPipeTail(stripCdPrefix(l)))
    .filter(Boolean);
  // If everything was trivial (e.g. a bare `set -e` or `ls`), fall back to the
  // first line so we never emit an empty marker.
  const chosen = meaningful.length ? meaningful : [stripPipeTail(stripCdPrefix(lines[0]))].filter(Boolean);

  const cmd = chosen.join("; ");
  if (cmd.length > BASH_CAP) {
    return `${cmd.slice(0, BASH_CAP - 3)}...`;
  }
  return cmd;
};

// ── tool summary ──

const TOOL_SUMMARY_FIELDS: Record<string, string> = {
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  read: "file_path",
  edit: "file_path",
  write: "file_path",
  Glob: "pattern",
  Grep: "pattern",
};

const toolOneLiner = (name: string, args: Record<string, unknown>): string => {
  const field = TOOL_SUMMARY_FIELDS[name];
  if (field && typeof args[field] === "string") {
    return `* ${name} "${args[field] as string}"`;
  }
  const [path, ...more] = extractPaths(args);
  if (path) return `* ${name} "${path}"${more.length ? ` +${more.length}` : ""}`;
  if (name === "bash" || name === "Bash") {
    const raw = (args.command ?? args.description ?? "") as string;
    const cmd = compressBash(raw);
    return `* ${name} "${cmd}"`;
  }
  if (typeof args.query === "string") {
    return `* ${name} "${clip(args.query as string, 60)}"`;
  }
  return `* ${name}`;
};

export interface BriefLine {
  /** Section header like "[user]" or "[assistant]" */
  header: string;
  /** Content lines for this section */
  lines: string[];
}

/**
 * Build BriefLine sections from NormalizedBlocks.
 */
export const buildBriefSections = (blocks: NormalizedBlock[]): BriefLine[] => {
  const sections: BriefLine[] = [];
  let lastHeader = "";

  const push = (header: string, line: string) => {
    if (header === lastHeader && sections.length > 0) {
      sections[sections.length - 1].lines.push(line);
      return;
    }
    sections.push({ header, lines: [line] });
    lastHeader = header;
  };

  const pushText = (header: string, text: string, ref = "") => {
    const lines = text.split("\n");
    if (ref && lines.length > 0) {
      lines[lines.length - 1] = `${lines[lines.length - 1]}${ref}`;
    }
    for (const line of lines) push(header, line);
  };

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const b = blocks[blockIndex];
    switch (b.kind) {
      case "user": {
        if (isNoiseUser(b.text)) break;
        const text = truncateTokens(collapseSkillText(b.text), TRUNCATE_USER);
        if (text) {
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
          pushText("[user]", text, ref);
        }
        lastHeader = "[user]";
        break;
      }
      case "bash": {
        const cmd = compressBash(b.command);
        const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
        if (cmd) {
          push("[user]", `$ ${cmd}${ref}`);
        }
        lastHeader = "[user]";
        break;
      }
      case "assistant": {
        let raw = b.text;
        // Strip leading self-talk prefix (up to 2x; assistants sometimes chain "Hmm, actually, ...")
        for (let i = 0; i < 2; i++) {
          const stripped = raw.replace(SELF_TALK_PREFIX_RE, "");
          if (stripped === raw) break;
          raw = stripped;
        }
        const text = isSegmentClosingAssistant(blocks, blockIndex)
          ? truncateTokensHeadTail(raw, SEGMENT_CLOSING_ASSISTANT_HEAD_WORDS, SEGMENT_CLOSING_ASSISTANT_TAIL_WORDS)
          : truncateTokensHeadTail(raw, ASSISTANT_HEAD_WORDS, ASSISTANT_TAIL_WORDS);
        if (text) {
          const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
          pushText("[assistant]", text, ref);
        }
        break;
      }
      case "tool_call": {
        // Skip malformed tool calls from streaming providers (empty name / fragmented args).
        if (!b.name || b.name.trim() === "") break;
        const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
        const summary = toolOneLiner(b.name, b.args) + ref;
        push("[assistant]", summary);
        break;
      }
      case "tool_result":
        // Tool result bodies are intentionally omitted from compact briefs.
        break;
    }
  }

  // Collapse consecutive identical tool lines (same text, different #ref)
  for (const sec of sections) {
    if (sec.header !== "[assistant]") continue;
    const out: string[] = [];
    for (const line of sec.lines) {
      if (!line.startsWith("* ")) {
        out.push(line);
        continue;
      }
      const ref = line.match(/\(#(\d+)\)$/)?.[1] ?? "";
      // A ref-less line never joins a ref'd collapse group — merging it would
      // emit a malformed "(#12, #) x2" once mixed ref/no-ref lines can occur
      // (global indices: unresolved positions render no ref).
      if (!ref) {
        out.push(line);
        continue;
      }
      const base = line.slice(0, -(ref.length + 3)).trimEnd();
      const last = out.length > 0 ? out[out.length - 1] : "";
      const m = last.match(/^(.*) \((#[\d, #]+)\) x(\d+)$/);
      if (m && m[1] === base) {
        out[out.length - 1] = `${base} (${m[2]}, #${ref}) x${parseInt(m[3], 10) + 1}`;
      } else if (last.match(/\(#\d+\)$/) && last.replace(/\s*\(#\d+\)$/, "") === base) {
        const prevRef = last.match(/\(#(\d+)\)$/)?.[1];
        out[out.length - 1] = `${base} (#${prevRef}, #${ref}) x2`;
      } else {
        out.push(line);
      }
    }
    sec.lines = out;
  }

  // Cap tool calls per [assistant] turn — keep tail (latest actions tend to
  // be the deciding edits/writes; head is usually exploration noise).
  const TOOL_CALLS_PER_TURN = 8;
  for (const sec of sections) {
    if (sec.header !== "[assistant]") continue;
    const toolIdxs = sec.lines.map((l, i) => (l.startsWith("* ") ? i : -1)).filter((i) => i >= 0);
    if (toolIdxs.length <= TOOL_CALLS_PER_TURN) continue;
    const dropCount = toolIdxs.length - TOOL_CALLS_PER_TURN;
    const dropSet = new Set(toolIdxs.slice(0, dropCount));
    const firstKeptToolIdx = toolIdxs[dropCount];
    const next: string[] = [];
    let inserted = false;
    for (let i = 0; i < sec.lines.length; i++) {
      if (dropSet.has(i)) continue;
      if (!inserted && i === firstKeptToolIdx) {
        next.push(`* (${dropCount} earlier tool-call entries omitted)`);
        inserted = true;
      }
      next.push(sec.lines[i]);
    }
    sec.lines = next;
  }

  return sections;
};

/**
 * Stringify BriefLine sections into text format.
 */
export const stringifyBrief = (sections: BriefLine[]): string => {
  // Emit sections -- suppress blank lines between consecutive tool summaries
  const out: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (i > 0) {
      const prev = sections[i - 1];
      const prevIsTools = prev.header === "[assistant]" && prev.lines.every((l) => l.startsWith("* "));
      const curIsTools = sec.header === "[assistant]" && sec.lines.every((l) => l.startsWith("* "));
      if (!(prevIsTools && curIsTools)) {
        out.push("");
      }
    }
    out.push(sec.header);
    for (const line of sec.lines) {
      out.push(line);
    }
  }

  return out.join("\n");
};

/** Convenience: build sections from blocks and stringify to text */
export const compileBrief = (blocks: NormalizedBlock[]): string => stringifyBrief(buildBriefSections(blocks));

// ── core/rank.ts ──

export interface BriefRankingOptions {
  /** Maximum normalized blocks used to build the brief transcript. */
  maxBlocks?: number;
  /** Always keep this many latest blocks to preserve local continuity. */
  preserveRecentBlocks?: number;
  /** Hook-provided file activity, used as structural signal instead of prose guessing. */
  fileOps?: FileOps;
  /**
   * Optional size budget (in characters of rendered brief) for the selected
   * blocks. When set, this is the PRIMARY limit: blocks are added by score
   * until the budget is reached, and lower-value blocks are skipped rather
   * than truncating the tail. maxBlocks still applies as a safety upper bound.
   * Callers derive this from a token budget via charsPerToken.
   * When maxBriefCharsCeiling + briefCharsPerBlock are also set, this acts as
   * the FLOOR of a size-relative budget (see below).
   */
  maxBriefChars?: number;
  /**
   * Optional upper bound for a size-relative char budget. When set together
   * with maxBriefChars (floor) and briefCharsPerBlock (slope), the effective
   * budget becomes clamp(briefCharsPerBlock * blockCount, maxBriefChars,
   * maxBriefCharsCeiling): larger transcripts (which carry more high-value
   * long-tail -- edits, commands, tests) get more brief budget, while small
   * sessions stay at the floor and this hard ceiling prevents unbounded growth.
   */
  maxBriefCharsCeiling?: number;
  /** Per-block slope (chars) for the size-relative budget. Requires the ceiling. */
  briefCharsPerBlock?: number;
}

export interface RankedBlock {
  block: NormalizedBlock;
  index: number;
  score: number;
  reasons: string[];
}

const DEFAULT_MAX_BLOCKS = 80;
const DEFAULT_RECENT_BLOCKS = 16;

const EDIT_TOOL_RE = /^(edit|write|multiedit|quick_edit|target_edit|apply_patch)$/i;
const READ_TOOL_RE = /^(read|glob|grep|ls|find|semantic_query|semantic_grep|semantic_show)$/i;
const TEST_COMMAND_RE =
  /\b(?:bun|npm|pnpm|yarn|node|pytest|cargo|go|mvn|gradle)\b[^\n]*(?:test|spec|check|lint|build|tsc)/i;
const GH_PR_POLL_RE = /(?:^|\s)gh\s+pr\s+(?:view|checks)\s+(\d+)\b/i;
// Durable workflow facts: which PR/issue was acted on, and git state changes.
// Structural (command shape), not prose — same spirit as TEST_COMMAND_RE.
const WORKFLOW_COMMAND_RE =
  /(?:^|\s)(?:gh\s+(?:pr|issue)\s+[a-z-]+|git\s+(?:commit|push|merge|rebase|revert|cherry-pick|tag|reset|checkout|branch)\b)/i;
const MIN_SEGMENT_CLOSING_ASSISTANT_CHARS = 120;

// A bash block whose every meaningful line is pure scaffolding (set -e, cd,
// export, ls, echo, sleep, pwd, comments, heredoc bodies) carries no durable
// fact. Such blocks get a score penalty so the size-relative budget never
// pulls them in ahead of real edits/commands when spare chars appear.
const TRIVIAL_BASH_LINE_RE =
  /^(?:set\s+[-+]|cd(?:\s+\S+)?$|export\s+\w+=|(?:source|\.)\s+\S+|pwd$|true$|:$|#|ls(?:\s|$)|echo\b|clear$|sleep\b)/;
const TRIVIAL_BASH_PENALTY = 16;

const isTrivialOnlyBash = (raw: string): boolean => {
  const lines = raw.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    // Skip heredoc bodies (they are content, not scaffolding) using the same
    // hardened detection as brief.ts: only skip when the terminator exists
    // downstream, so a stray `<<` never swallows a later real command.
    const close = heredocCloseIndex(lines, i);
    if (close !== -1) i = close;
  }
  const meaningful = kept
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !TRIVIAL_BASH_LINE_RE.test(l));
  return meaningful.length === 0;
};

const asPathSet = (paths?: string[]): Set<string> => new Set((paths ?? []).filter(Boolean));

const bashCommandFromBlock = (block: NormalizedBlock): string | undefined => {
  if (block.kind === "bash") return block.command;
  if (block.kind === "tool_call" && /^bash$/i.test(block.name) && typeof block.args.command === "string") {
    return block.args.command;
  }
  return undefined;
};

const pathFromBlock = (block: NormalizedBlock): string | undefined => {
  if (block.kind === "tool_call") return extractPath(block.args) ?? undefined;
  if (block.kind === "bash") {
    const match = block.command.match(/(?:^|\s)([\w./-]+\.[\w-]+)(?:\s|$)/);
    return match?.[1];
  }
  return undefined;
};

const add = (ranked: RankedBlock, points: number, reason: string) => {
  ranked.score += points;
  ranked.reasons.push(reason);
};

const scoreBlock = (
  block: NormalizedBlock,
  index: number,
  total: number,
  modifiedFiles: Set<string>,
  readFiles: Set<string>,
): RankedBlock => {
  const ranked: RankedBlock = { block, index, score: 0, reasons: [] };
  const recency = total <= 1 ? 0 : Math.round((index / (total - 1)) * 12);
  add(ranked, recency, "recency");

  if (block.kind === "user") add(ranked, 18, "user-turn");
  if (block.kind === "assistant") add(ranked, 10, "assistant-context");
  if (block.kind === "tool_result") add(ranked, 1, "tool-result-low-value");

  if (block.kind === "tool_call") {
    const command = bashCommandFromBlock(block);
    if (EDIT_TOOL_RE.test(block.name)) add(ranked, 34, "edit-tool");
    else if (command && TEST_COMMAND_RE.test(command)) add(ranked, 26, "test-command");
    else if (READ_TOOL_RE.test(block.name)) add(ranked, 6, "read-tool");
    else add(ranked, 12, "tool-call");
    if (command && WORKFLOW_COMMAND_RE.test(command)) add(ranked, 14, "workflow-command");
    if (command && isTrivialOnlyBash(command)) add(ranked, -TRIVIAL_BASH_PENALTY, "trivial-bash");
  }

  if (block.kind === "bash") {
    add(ranked, 8, "bash");
    if (block.exitCode != null && block.exitCode !== 0) add(ranked, 24, "nonzero-exit");
    if (TEST_COMMAND_RE.test(block.command)) add(ranked, 22, "test-command");
    if (WORKFLOW_COMMAND_RE.test(block.command)) add(ranked, 14, "workflow-command");
    // Penalize scaffolding-only commands, but not ones that failed (a failed
    // `ls`/`cd` still records a real state fact via nonzero-exit).
    if (isTrivialOnlyBash(block.command) && !(block.exitCode != null && block.exitCode !== 0)) {
      add(ranked, -TRIVIAL_BASH_PENALTY, "trivial-bash");
    }
  }

  const path = pathFromBlock(block);
  if (path) {
    if (modifiedFiles.has(path)) add(ranked, 18, "hook-modified-file");
    if (readFiles.has(path)) add(ranked, 6, "hook-read-file");
  }

  if (block.kind === "tool_result" && block.text.length > 1000) add(ranked, -8, "long-tool-result");
  return ranked;
};

const boostAdjacency = (ranked: RankedBlock[]) => {
  const important = ranked
    .filter(
      (r) =>
        r.score >= 34 ||
        r.reasons.includes("edit-tool") ||
        r.reasons.includes("test-command") ||
        r.reasons.includes("nonzero-exit"),
    )
    .map((r) => r.index);

  for (const idx of important) {
    for (let i = idx - 1; i >= Math.max(0, idx - 8); i--) {
      if (ranked[i].block.kind === "user") {
        add(ranked[i], 10, "near-important-event");
        break;
      }
    }
    for (let i = idx - 1; i >= Math.max(0, idx - 4); i--) {
      if (ranked[i].block.kind === "assistant") {
        add(ranked[i], 7, "near-important-event");
        break;
      }
    }
    for (let i = idx + 1; i <= Math.min(ranked.length - 1, idx + 4); i++) {
      if (ranked[i].block.kind === "assistant" || ranked[i].block.kind === "bash") {
        add(ranked[i], 5, "after-important-event");
        break;
      }
    }
  }
};

const nextNonToolResult = (ranked: RankedBlock[], index: number): NormalizedBlock | undefined => {
  for (let i = index + 1; i < ranked.length; i++) {
    if (ranked[i].block.kind !== "tool_result") return ranked[i].block;
  }
  return undefined;
};

const boostSegmentClosingAssistants = (ranked: RankedBlock[]) => {
  for (let i = 0; i < ranked.length; i++) {
    const current = ranked[i];
    if (current.block.kind !== "assistant") continue;
    if (current.block.text.trim().length < MIN_SEGMENT_CLOSING_ASSISTANT_CHARS) continue;
    const next = nextNonToolResult(ranked, i);
    if (!next || next.kind === "user") {
      add(current, 14, "segment-closing-assistant");
    }
  }
};

const dedupKey = (block: NormalizedBlock): string | undefined => {
  const command = bashCommandFromBlock(block);
  const ghPrPoll = command?.match(GH_PR_POLL_RE);
  if (ghPrPoll) return `gh-pr-poll:${ghPrPoll[1]}`;
  if (command) {
    const normalized = command.replace(/\s+/g, " ").trim();
    return normalized ? `bash:${normalized}` : undefined;
  }
  if (block.kind === "tool_call") {
    const path = pathFromBlock(block);
    return path ? `tool:${block.name.toLowerCase()}:${path}` : undefined;
  }
  return undefined;
};

export const rankBriefBlocks = (blocks: NormalizedBlock[], options: BriefRankingOptions = {}): RankedBlock[] => {
  const modifiedFiles = asPathSet(options.fileOps?.modifiedFiles);
  const readFiles = asPathSet(options.fileOps?.readFiles);
  const ranked = blocks.map((block, index) => scoreBlock(block, index, blocks.length, modifiedFiles, readFiles));
  boostAdjacency(ranked);
  boostSegmentClosingAssistants(ranked);
  return ranked;
};

export const selectRankedBriefBlocks = (
  blocks: NormalizedBlock[],
  options: BriefRankingOptions = {},
): NormalizedBlock[] => {
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  // Size-relative budget: when a ceiling + slope are provided, the effective
  // char budget scales with transcript length (block count) between the floor
  // (maxBriefChars) and the ceiling. Larger transcripts carry more high-value
  // long-tail, so they earn more brief budget; small sessions stay at the floor.
  const maxBriefChars =
    options.maxBriefChars != null && options.maxBriefCharsCeiling != null && options.briefCharsPerBlock != null
      ? Math.round(
          Math.min(
            options.maxBriefCharsCeiling,
            Math.max(options.maxBriefChars, options.briefCharsPerBlock * blocks.length),
          ),
        )
      : options.maxBriefChars;
  // Fast path: nothing to trim by count and no char budget to enforce.
  if (blocks.length <= maxBlocks && maxBriefChars == null) return blocks;

  const preserveRecentBlocks = Math.min(options.preserveRecentBlocks ?? DEFAULT_RECENT_BLOCKS, maxBlocks);
  const ranked = rankBriefBlocks(blocks, options);
  const selected = new Set<number>();
  const seenKeys = new Set<string>();

  // Per-block rendered size, only computed when a char budget is active.
  const costs =
    maxBriefChars == null ? null : blocks.map((b) => (b.kind === "tool_result" ? 0 : compileBrief([b]).length + 1));
  let usedChars = 0;

  // Keep the latest blocks to preserve local continuity, iterating NEWEST first
  // so the most recent context is guaranteed. When a char budget is active these
  // are charged against it too and over-budget blocks are skipped -- otherwise a
  // run of large recent blocks could blow past maxBriefChars (the old bug on very
  // long transcripts, where preserve-recent alone exceeded the budget).
  for (let i = blocks.length - 1; i >= Math.max(0, blocks.length - preserveRecentBlocks); i--) {
    if (blocks[i].kind === "tool_result") continue;
    if (selected.has(i)) continue;
    if (costs && usedChars + costs[i] > (maxBriefChars as number)) continue;
    selected.add(i);
    if (costs) usedChars += costs[i];
    const key = dedupKey(blocks[i]);
    if (key) seenKeys.add(key);
  }

  const ordered = [...ranked].sort((a, b) => b.score - a.score || b.index - a.index);
  for (const item of ordered) {
    if (selected.size >= maxBlocks) break;
    if (selected.has(item.index)) continue;
    if (item.block.kind === "tool_result") continue;
    const key = dedupKey(item.block);
    if (key && seenKeys.has(key)) continue;
    if (costs) {
      // Skip (not break) so smaller high-value blocks can still fit the budget.
      if (usedChars + costs[item.index] > (maxBriefChars as number)) continue;
      usedChars += costs[item.index];
    }
    selected.add(item.index);
    if (key) seenKeys.add(key);
  }

  return [...selected].sort((a, b) => a - b).map((i) => blocks[i]);
};
