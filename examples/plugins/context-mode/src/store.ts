/**
 * The knowledge base: indexed content (tool output, files, fetched pages) split into titled chunks, searched with BM25,
 * so large output stays out of the context and comes back a section at a time. A port of context-mode's FTS5
 * `ContentStore`.
 *
 * ponytail: an in-memory array saved as one JSON file and a linear BM25 scan with a crude suffix stemmer, in place of
 * SQLite FTS5 (porter + trigram tables, reciprocal rank fusion, proximity rerank, Levenshtein typo correction); fine
 * for a session's few thousand chunks, move to `node:sqlite` FTS5 when stores grow past that.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Chunk {
  source: string;
  title: string;
  content: string;
  code: boolean;
}

const MAX_CHUNK = 4096;
const STOPWORDS = new Set(
  "the and for are but not you all any can had her was one our out has his how its may new now old see way who did get let say she too use that with have this will your from they been more when what were them than then some into only also just over such each which their there these those would could should about after other where while".split(
    " ",
  ),
);

const stem = (w: string) => (w.length > 4 ? w.replace(/(?:ing|ed|es|s)$/, "") : w);
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
    .map(stem);

/** Markdown split by H1–H4 headings (titles are the heading path) and `---` rules, code blocks kept whole. */
export function chunkMarkdown(text: string): Omit<Chunk, "source">[] {
  const chunks: Omit<Chunk, "source">[] = [];
  const stack: { level: number; text: string }[] = [];
  let current: string[] = [];
  const flush = () => {
    const joined = current.join("\n").trim();
    current = [];
    if (!joined) return;
    const title = stack.map((h) => h.text).join(" > ") || "Untitled";
    if (joined.length <= MAX_CHUNK) {
      chunks.push({ title, content: joined, code: /^`{3,}/m.test(joined) });
      return;
    }
    // too big: split at paragraphs
    const paragraphs = joined.split(/\n\n+/);
    let part: string[] = [];
    let n = 1;
    const push = () => {
      const content = part.join("\n\n").trim();
      if (content) chunks.push({ title: `${title} (${n++})`, content, code: content.includes("```") });
      part = [];
    };
    for (const p of paragraphs) {
      if (part.length > 0 && [...part, p].join("\n\n").length > MAX_CHUNK) push();
      part.push(p);
    }
    push();
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^[-_*]{3,}\s*$/.test(line)) {
      flush();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flush();
      const level = heading[1]?.length ?? 1;
      while ((stack.at(-1)?.level ?? 0) >= level) stack.pop();
      stack.push({ level, text: heading[2]?.trim() ?? "" });
      current.push(line);
      continue;
    }
    const fence = line.match(/^(`{3,})/)?.[1];
    if (fence) {
      current.push(line);
      while (++i < lines.length) {
        current.push(lines[i] ?? "");
        if (lines[i]?.trim() === fence) break;
      }
      continue;
    }
    current.push(line);
  }
  flush();
  return chunks;
}

/** Plain output: by blank lines when it has 3–200 small sections, else 20-line groups overlapping by 2. */
export function chunkPlainText(text: string, linesPerChunk = 20): Omit<Chunk, "source">[] {
  const sections = text.split(/\n\s*\n/);
  if (sections.length >= 3 && sections.length <= 200 && sections.every((s) => s.length < 5000))
    return sections
      .map((s) => s.trim())
      .filter(Boolean)
      .map((content, i) => ({
        title: content.split("\n")[0]?.slice(0, 80) || `Section ${i + 1}`,
        content,
        code: false,
      }));
  const lines = text.split("\n");
  if (lines.length <= linesPerChunk) return [{ title: "Output", content: text, code: false }];
  const chunks: Omit<Chunk, "source">[] = [];
  for (let i = 0; i < lines.length; i += linesPerChunk - 2) {
    const slice = lines.slice(i, i + linesPerChunk);
    const title = slice[0]?.trim().slice(0, 80) || `Lines ${i + 1}-${i + slice.length}`;
    // ponytail: no byte cap on a group of very long lines
    chunks.push({ title, content: slice.join("\n"), code: false });
    if (i + linesPerChunk >= lines.length) break;
  }
  return chunks;
}

/** Up to `max` chars of `content` around the first query term it contains. */
export function snippet(content: string, query: string, max = 1500): string {
  if (content.length <= max) return content;
  const lower = content.toLowerCase();
  const at = Math.min(
    ...query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => lower.indexOf(t))
      .filter((i) => i >= 0),
    Number.POSITIVE_INFINITY,
  );
  const start = Number.isFinite(at) ? Math.max(0, at - Math.floor(max / 4)) : 0;
  return `${start > 0 ? "…" : ""}${content.slice(start, start + max)}…`;
}

export class KnowledgeBase {
  chunks: Chunk[] = [];
  constructor(readonly path?: string) {
    if (!path) return;
    try {
      this.chunks = JSON.parse(readFileSync(path, "utf8")).chunks;
    } catch {
      // none yet
    }
  }

  /** Indexes `text` as `source` (replacing an earlier source of that name), as markdown or plain output. */
  index(text: string, source: string, plain = false): { source: string; total: number; code: number } {
    const chunks = (plain ? chunkPlainText(text) : chunkMarkdown(text)).map((c) => ({ ...c, source }));
    this.chunks = [...this.chunks.filter((c) => c.source !== source), ...chunks];
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      // sync, so parallel tool calls never save an older state over a newer one
      writeFileSync(this.path, JSON.stringify({ chunks: this.chunks }));
    }
    return { source, total: chunks.length, code: chunks.filter((c) => c.code).length };
  }

  /**
   * The best `limit` chunks for `query` by BM25, from sources whose name contains `source`, `extra` (session events)
   * included; when no term matches, chunks containing the query as a substring.
   */
  search(query: string, limit = 3, source?: string, extra: Chunk[] = []): Chunk[] {
    const pool = [...this.chunks, ...extra].filter((c) => !source || c.source.includes(source));
    const terms = [...new Set(words(query))];
    const docs = pool.map((c) => words(`${c.title}\n${c.content}`));
    const avg = docs.reduce((n, d) => n + d.length, 0) / (docs.length || 1);
    const idf = new Map(
      terms.map((t) => {
        const df = docs.filter((d) => d.includes(t)).length;
        return [t, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))];
      }),
    );
    const scored = pool
      .map((chunk, i) => {
        const doc = docs[i] ?? [];
        let score = 0;
        for (const t of terms) {
          const tf = doc.filter((w) => w === t).length;
          if (tf) score += ((idf.get(t) ?? 0) * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * doc.length) / avg));
        }
        return { chunk, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length > 0) return scored.slice(0, limit).map((s) => s.chunk);
    const q = query.toLowerCase().trim();
    return pool.filter((c) => q && c.content.toLowerCase().includes(q)).slice(0, limit);
  }

  /** Words that set `source` apart: in at least 2 of its chunks but at most 40%, by rarity, length and identifier shape. */
  terms(source: string, max = 40): string[] {
    const chunks = this.chunks.filter((c) => c.source === source);
    if (chunks.length < 3) return [];
    const df = new Map<string, number>();
    for (const c of chunks)
      for (const w of new Set(
        c.content
          .toLowerCase()
          .split(/[^\p{L}\p{N}_-]+/u)
          .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
      ))
        df.set(w, (df.get(w) ?? 0) + 1);
    const most = Math.max(3, Math.ceil(chunks.length * 0.4));
    return [...df]
      .filter(([, n]) => n >= 2 && n <= most)
      .map(([w, n]) => ({
        w,
        score:
          Math.log(chunks.length / n) +
          Math.min(w.length / 20, 0.5) +
          (w.includes("_") ? 1.5 : w.length >= 12 ? 0.8 : 0),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map((s) => s.w);
  }

  /** Chunk counts by source. */
  sources(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const c of this.chunks) counts.set(c.source, (counts.get(c.source) ?? 0) + 1);
    return counts;
  }
}
