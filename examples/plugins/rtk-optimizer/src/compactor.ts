import { resolve, sep } from "node:path";
import { stripVTControlCharacters as stripAnsiFast } from "node:util";
import type { RtkConfig } from "./config.ts";
import { filterBuildOutput } from "./techniques/build.ts";
import { compactGitOutput } from "./techniques/git.ts";
import { aggregateLinterOutput } from "./techniques/linter.ts";
import { groupSearchResults } from "./techniques/search.ts";
import { detectLanguage, filterSourceCode, smartTruncate } from "./techniques/source.ts";
import { aggregateTestOutput } from "./techniques/test-output.ts";
import { truncate } from "./techniques/truncate.ts";

export interface CompactionMetadata {
  applied: boolean;
  techniques: string[];
  truncated: boolean;
  originalCharCount: number;
  compactedCharCount: number;
  originalLineCount: number;
  compactedLineCount: number;
}

type Compaction = RtkConfig["outputCompaction"];
interface State {
  text: string;
  techniques: string[];
}
interface AnchoredLine {
  text: string;
  content: string;
}

const LOSSY = ["build", "test", "git", "linter", "search", "truncate", "smart-truncate"];
const READ_EXACT_OUTPUT_LINE_THRESHOLD = 80;
const BANNER_PREFIX = "[RTK compacted output:";
const ANCHORED_MIN_MATCHES = 2;
const ANCHORED_MIN_RATIO = 0.5;
const ANCHORED_SAMPLE_LIMIT = 200;
const ANCHORED_PATTERNS = [
  /^\s*(?:>>>|>>|[>+\-*]+)?\s*(\d+)\s*#\s*[A-Za-z0-9_-]{2,32}:(.*)$/,
  /^\s*(?:>>>|>>|[>+\-*]+)?\s*(\d+)\s*:\s*[A-Za-z0-9_-]{1,32}\|(.*)$/,
  /^\s*(?:>>>|>>|[>+\-*]+)?\s*(\d+)[a-z]{2}\|(.*)$/,
];
const ANCHORED_INFORMATIONAL = /^\s*(?:$|<\/?file>|\.{3}|\[[^\]]+\]|Read\s+.+:\s+\d+\s+lines\b)/;

const isUnder = (path: string, root: string) => {
  const [p, r] = [resolve(path), resolve(root)].map((x) => (process.platform === "win32" ? x.toLowerCase() : x));
  return p === r || (p as string).startsWith((r as string).endsWith(sep) ? (r as string) : `${r}${sep}`);
};

function countLines(text: string): number {
  if (!text) return 0;
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized ? normalized.split("\n").length : 1;
}

function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (!text) return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function parseAnchored(line: string): (AnchoredLine & { lineNumber: number }) | undefined {
  for (const pattern of ANCHORED_PATTERNS) {
    const match = line.match(pattern);
    const lineNumber = Number.parseInt(match?.[1] ?? "", 10);
    if (match && Number.isSafeInteger(lineNumber) && lineNumber > 0)
      return { lineNumber, content: match[2] ?? "", text: line };
  }
  return undefined;
}

/** Hashline-style read output (`12#ab:code`, `12:ab|code`, `12ab|code`): mostly lines with increasing anchors. */
function looksAnchored(text: string): boolean {
  let matches = 0;
  let relevant = 0;
  let previous: number | undefined;
  let increasing = false;
  for (const line of splitLines(text).lines.slice(0, ANCHORED_SAMPLE_LIMIT)) {
    if (!ANCHORED_INFORMATIONAL.test(line)) relevant += 1;
    const n = parseAnchored(line)?.lineNumber;
    if (n === undefined) continue;
    matches += 1;
    if (previous !== undefined && n > previous) increasing = true;
    previous = n;
  }
  return matches >= ANCHORED_MIN_MATCHES && increasing && matches / Math.max(relevant, matches) >= ANCHORED_MIN_RATIO;
}

/** Only filter source when a later line/char safeguard would trigger anyway. */
const sourceFilteringDue = (text: string, c: Compaction) =>
  (c.smartTruncate.enabled && countLines(text) > c.smartTruncate.maxLines) ||
  (c.truncate.enabled && text.length > c.truncate.maxChars);

/** Maps transformed contents back to their anchored lines, so kept lines keep their whole anchor. */
function remap(source: AnchoredLine[], transformed: string): AnchoredLine[] {
  const out: AnchoredLine[] = [];
  let from = 0;
  for (const line of splitLines(transformed).lines) {
    const i = source.findIndex((s, j) => j >= from && s.content === line);
    if (i === -1) out.push({ text: line, content: line });
    else {
      out.push(source[i] as AnchoredLine);
      from = i + 1;
    }
  }
  return out;
}

function truncateAnchored(lines: AnchoredLine[], maxChars: number): AnchoredLine[] {
  const body = (ls: AnchoredLine[]) => ls.map((l) => l.text).join("\n");
  if (body(lines).length <= maxChars) return lines;
  const marker = "[RTK anchor-safe truncate: remaining anchored read lines omitted to preserve complete anchors]";
  const kept: AnchoredLine[] = [];
  let chars = 0;
  for (const [i, line] of lines.entries()) {
    const next = chars + (kept.length > 0 ? 1 : 0) + line.text.length;
    const markerLength = lines.length - i - 1 > 0 ? (next > 0 ? 1 : 0) + marker.length : 0;
    if (next + markerLength > maxChars) return [...kept, { text: marker, content: marker }];
    kept.push(line);
    chars = next;
  }
  return kept;
}

function compactAnchoredRead(text: string, filePath: string, c: Compaction): State {
  const { lines: all, trailingNewline } = splitLines(text);
  const parsed = all.map(parseAnchored);
  const first = parsed.findIndex(Boolean);
  const last = parsed.length - 1 - [...parsed].reverse().findIndex(Boolean);
  if (first === -1 || parsed.slice(first, last + 1).some((l) => !l)) return { text, techniques: [] };
  const prefix = all.slice(0, first);
  const suffix = all.slice(last + 1);
  let lines = parsed
    .slice(first, last + 1)
    .map((l) => ({ text: (l as AnchoredLine).text, content: (l as AnchoredLine).content }));
  const render = (ls: AnchoredLine[]) => {
    const joined = [...prefix, ...ls.map((l) => l.text), ...suffix].join("\n");
    return trailingNewline && joined ? `${joined}\n` : joined;
  };
  const body = (ls: AnchoredLine[]) => ls.map((l) => l.text).join("\n");
  const contents = () => lines.map((l) => l.content).join("\n");
  const techniques: string[] = [];
  const language = detectLanguage(filePath);
  const tryLines = (next: AnchoredLine[], technique: string) => {
    if (body(next) === body(lines)) return;
    lines = next;
    techniques.push(technique);
  };

  if (c.sourceCodeFilteringEnabled && c.sourceCodeFiltering !== "none" && sourceFilteringDue(text, c)) {
    const current = contents();
    const filtered = filterSourceCode(current, language, c.sourceCodeFiltering) ?? current;
    tryLines(remap(lines, filtered), `source:${c.sourceCodeFiltering}`);
  }
  if (c.smartTruncate.enabled && lines.length > c.smartTruncate.maxLines)
    tryLines(remap(lines, smartTruncate(contents(), c.smartTruncate.maxLines, language)), "smart-truncate");
  if (c.truncate.enabled && render(lines).length > c.truncate.maxChars)
    tryLines(truncateAnchored(lines, Math.max(1, c.truncate.maxChars - render([]).length)), "truncate");
  return { text: render(lines), techniques };
}

/** Runs `transform` and records `technique` when it changed the text (`null` = not applicable). */
function apply(state: State, transform: (text: string) => string | null, technique: string, enabled = true) {
  if (!enabled) return;
  const next = transform(state.text) ?? state.text;
  if (next === state.text) return;
  state.text = next;
  state.techniques.push(technique);
}

function begin(text: string, c: Compaction): State {
  const state = { text, techniques: [] };
  apply(state, stripAnsiFast, "ansi", c.stripAnsi);
  return state;
}

const hardTruncate = (state: State, c: Compaction) =>
  apply(
    state,
    (t) => truncate(t, c.truncate.maxChars),
    "truncate",
    c.truncate.enabled && state.text.length > c.truncate.maxChars,
  );

function banner(state: State): State {
  if (state.techniques.length > 0 && !state.text.startsWith(BANNER_PREFIX))
    state.text = `${BANNER_PREFIX} ${state.techniques.join(", ")}]\n${state.text}`;
  return state;
}

function compactBash(text: string, command: string | undefined, c: Compaction): State {
  const state = begin(text, c);
  apply(state, (t) => filterBuildOutput(t, command), "build", c.filterBuildOutput);
  apply(state, (t) => aggregateTestOutput(t, command), "test", c.aggregateTestOutput);
  apply(state, (t) => compactGitOutput(t, command), "git", c.compactGitOutput);
  apply(state, (t) => aggregateLinterOutput(t, command), "linter", c.aggregateLinterOutput);
  hardTruncate(state, c);
  return state;
}

function compactRead(text: string, filePath: string, c: Compaction): State {
  const state = begin(text, c);
  if (looksAnchored(state.text)) {
    const anchored = compactAnchoredRead(state.text, filePath, c);
    return banner({ text: anchored.text, techniques: [...state.techniques, ...anchored.techniques] });
  }
  const language = detectLanguage(filePath);
  apply(
    state,
    (t) => filterSourceCode(t, language, c.sourceCodeFiltering),
    `source:${c.sourceCodeFiltering}`,
    c.sourceCodeFilteringEnabled && c.sourceCodeFiltering !== "none" && sourceFilteringDue(text, c),
  );
  apply(
    state,
    (t) => smartTruncate(t, c.smartTruncate.maxLines, language),
    "smart-truncate",
    c.smartTruncate.enabled && state.text.split("\n").length > c.smartTruncate.maxLines,
  );
  hardTruncate(state, c);
  return banner(state);
}

function compactGrep(text: string, c: Compaction): State {
  const state = begin(text, c);
  apply(state, (t) => groupSearchResults(t), "search", c.groupSearchOutput);
  hardTruncate(state, c);
  return state;
}

/** Reads stay exact unless read compaction is on, no range was asked for, it's no skill file (if so set) and it's long. */
function preserveRead(text: string, input: Record<string, unknown>, config: RtkConfig, skillDirs: string[]): boolean {
  const c = config.outputCompaction;
  if (!c.readCompaction.enabled || input.offset !== undefined || input.limit !== undefined) return true;
  const path = typeof input.path === "string" ? input.path : "";
  if (c.preserveExactSkillReads && path.trim() && skillDirs.some((dir) => isUnder(path, dir))) return true;
  return countLines(text) <= READ_EXACT_OUTPUT_LINE_THRESHOLD;
}

/**
 * Compacts a `bash`, `read` or `grep` result's text (other tools are left alone); `undefined` when nothing changed.
 * `skillDirs` are the directories of the run's skills, whose files `preserveExactSkillReads` keeps exact.
 */
export function compactToolOutput(
  toolName: string,
  input: unknown,
  text: string,
  config: RtkConfig,
  skillDirs: string[] = [],
): { text: string; metadata: CompactionMetadata } | undefined {
  const c = config.outputCompaction;
  if (!c.enabled) return undefined;
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  let state: State | undefined;
  if (toolName === "bash") {
    const command = typeof args.command === "string" && args.command.trim() ? args.command : undefined;
    state = compactBash(text, command, c);
  } else if (toolName === "read") {
    const path = typeof args.path === "string" ? args.path : "";
    if (!preserveRead(text, args, config, skillDirs)) state = compactRead(text, path, c);
  } else if (toolName === "grep") state = compactGrep(text, c);
  if (!state || state.text === text) return undefined;
  if (c.trackSavings) trackSavings(text, state.text, toolName);
  const techniques = [...new Set(state.techniques)];
  return {
    text: state.text,
    metadata: {
      applied: true,
      techniques,
      truncated: techniques.some((t) => LOSSY.includes(t) || t.startsWith("source:")),
      originalCharCount: text.length,
      compactedCharCount: state.text.length,
      originalLineCount: countLines(text),
      compactedLineCount: countLines(state.text),
    },
  };
}

// ponytail: process-wide, as in Pi (not per session); session entries (`Plugin.entries`) could keep them per session
const metrics: { tool: string; originalChars: number; filteredChars: number }[] = [];

function trackSavings(original: string, filtered: string, tool: string) {
  metrics.push({ tool, originalChars: original.length, filteredChars: filtered.length });
}

export const clearMetrics = () => {
  metrics.length = 0;
};

export function metricsSummary(): string {
  if (metrics.length === 0) return "RTK output compaction metrics: no data yet.";
  const line = (calls: string, original: number, filtered: number) =>
    `${calls}, saved ${(original - filtered).toLocaleString()} chars (${(original > 0 ? ((original - filtered) / original) * 100 : 0).toFixed(1)}%)`;
  const byTool = new Map<string, { count: number; originalChars: number; filteredChars: number }>();
  for (const m of metrics) {
    const s = byTool.get(m.tool) ?? { count: 0, originalChars: 0, filteredChars: 0 };
    s.count += 1;
    s.originalChars += m.originalChars;
    s.filteredChars += m.filteredChars;
    byTool.set(m.tool, s);
  }
  const sum = (k: "originalChars" | "filteredChars") => metrics.reduce((n, m) => n + m[k], 0);
  return [
    "RTK output compaction metrics",
    line(`calls=${metrics.length}`, sum("originalChars"), sum("filteredChars")).replace(", saved ", ", saved="),
    ...[...byTool].map(([tool, s]) => `- ${tool}: ${line(`${s.count} calls`, s.originalChars, s.filteredChars)}`),
  ].join("\n");
}
