import { randomBytes } from "node:crypto";
import type { PluginEntry, SessionState } from "@hortus/core";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** One query's outcome (Pi's `QueryResultData`). */
export interface QueryResult {
  query: string;
  answer: string;
  results: SearchResult[];
  error: string | null;
  provider?: string;
  providers?: string[];
}

/** One fetched URL (Pi's `ExtractedContent`). */
export interface Extracted {
  url: string;
  title: string;
  content: string;
  error: string | null;
  mimeType?: string;
  status?: number;
}

export interface Research {
  claim: string;
  provider?: string;
  summary?: string;
  sources: (SearchResult & { rank: number })[];
  passages: { rank: number; url: string; text: string }[];
  errors?: { query: string; error: string }[];
}

/** What `get_search_content` reads back by `responseId`: saved as a `<plugin>:results` entry. */
export type Stored = { id: string; timestamp: number } & (
  | { type: "search"; queries: QueryResult[] }
  | { type: "fetch"; urls: Extracted[] }
  | { type: "research"; artifact: Research }
);

/** This plugin's slice of `SessionState.data`, rebuilt from its entries on replay (resume, branch). */
export interface Data {
  results: Record<string, Stored>;
  /** `web_enable` was called on this branch (dynamic activation) */
  enabled?: boolean;
}

export const MAX_STORED = 50;
export const newId = () => randomBytes(8).toString("hex");

export const dataOf = (state: SessionState, plugin: string): Data =>
  (state.data[plugin] as Data | undefined) ?? { results: {} };

/** Reducers: values in `state.data` are replaced, never mutated. */
export const entries = {
  results: (e: PluginEntry<Stored>, state: SessionState, plugin: string) => {
    const prev = dataOf(state, plugin);
    const all = Object.values({ ...prev.results, [e.data.id]: e.data }).sort((a, b) => a.timestamp - b.timestamp);
    state.data[plugin] = { ...prev, results: Object.fromEntries(all.slice(-MAX_STORED).map((r) => [r.id, r])) };
  },
  deleted: (e: PluginEntry<{ id: string }>, state: SessionState, plugin: string) => {
    const { [e.data.id]: _, ...results } = dataOf(state, plugin).results;
    state.data[plugin] = { ...dataOf(state, plugin), results };
  },
  enabled: (_: PluginEntry, state: SessionState, plugin: string) => {
    state.data[plugin] = { ...dataOf(state, plugin), enabled: true };
  },
};

export type FindMode = "exact" | "case-insensitive" | "fuzzy";

/**
 * Passages of `text` around each query's matches (Pi's `findContent`, simplified): literal matches, or with "fuzzy"
 * paragraphs holding every word of the query. Overlapping windows merge; at most 20 passages.
 */
export function findContent(text: string, queries: string[], mode: FindMode) {
  const ranges: { start: number; end: number; q: string }[] = [];
  const queryResults = queries.map((q) => {
    let count = 0;
    if (mode === "fuzzy") {
      const words = q.toLowerCase().split(/\W+/).filter(Boolean);
      for (const m of text.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g)) {
        const p = m[0].toLowerCase();
        if (words.length && words.every((w) => p.includes(w))) {
          ranges.push({ start: m.index, end: m.index + m[0].length, q });
          count++;
        }
      }
    } else {
      const hay = mode === "exact" ? text : text.toLowerCase();
      const needle = mode === "exact" ? q : q.toLowerCase();
      for (let i = hay.indexOf(needle); needle && i >= 0; i = hay.indexOf(needle, i + needle.length)) {
        ranges.push({ start: Math.max(0, i - 200), end: Math.min(text.length, i + needle.length + 200), q });
        count++;
      }
    }
    return { query: q, matchCount: count };
  });
  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number; qs: Set<string> }[] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
      last.qs.add(r.q);
    } else merged.push({ start: r.start, end: r.end, qs: new Set([r.q]) });
  }
  const shown = merged.slice(0, 20);
  const missing = queryResults.filter((r) => !r.matchCount).map((r) => `"${r.query}"`);
  const body = shown
    .map((r, i) => {
      const snippet = text.slice(r.start, r.end).replace(/\s+/g, " ").trim();
      return `${i + 1}. [${[...r.qs].map((q) => `"${q}"`).join(", ")}] ${r.start > 0 ? "…" : ""}${snippet}${r.end < text.length ? "…" : ""}`;
    })
    .join("\n\n");
  const matchCount = ranges.length;
  return {
    text: [
      `Text matches (${mode})${matchCount ? "" : ": no matches"}`,
      body,
      missing.length ? `No matches: ${missing.join(", ")}` : "",
      merged.length > shown.length ? `[${merged.length - shown.length} more passages omitted; narrow findText]` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    matchCount,
    returnedMatches: shown.length,
    queryResults,
  };
}

/** Where a slice of `content` from `offset` should end: at a line break near `end` when there is one. */
function pageEnd(content: string, offset: number, end: number): number {
  if (end >= content.length) return content.length;
  const nl = content.lastIndexOf("\n", end);
  return nl > offset + (end - offset) / 2 ? nl + 1 : end;
}

export interface Page {
  text: string;
  endOffset: number;
}

/** `content` from `offset`, at most `limit` chars; the continuation hint is the caller's. */
export function slice(content: string, offset: number, limit: number): Page {
  const endOffset = pageEnd(content, offset, Math.min(offset + limit, content.length));
  return { text: content.slice(offset, endOffset), endOffset };
}

export function formatFullResults(q: QueryResult): string {
  const providers = q.providers ?? (q.provider ? [q.provider] : []);
  let out = `## Results for: "${q.query}"\n\n`;
  if (providers.length) out += `**Provider${providers.length === 1 ? "" : "s"}:** ${providers.join(", ")}\n\n`;
  if (q.answer) out += `${q.answer}\n\n---\n\n`;
  for (const r of q.results) out += `### ${r.title}\n${r.url}${r.snippet ? `\n\n${r.snippet}` : ""}\n\n`;
  return out;
}

export function formatSearchSummary(results: SearchResult[], answer: string): string {
  if (!results.length) return answer ? `${answer}\n\n---\n\n**Sources:**\nNo sources returned.` : "No results found.";
  return `${answer ? `${answer}\n\n---\n\n**Sources:**\n` : ""}${results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n")}`;
}
