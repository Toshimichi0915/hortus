import type { TextProps } from "ink";
import stringWidth from "string-width";
import { theme } from "./entry.ts";

/** A run of text with one style; a rendered line is a list of these. */
export interface Span
  extends Pick<TextProps, "color" | "bold" | "italic" | "dimColor" | "strikethrough" | "underline"> {
  text: string;
}
type Style = Omit<Span, "text">;

// `code` | **bold** | __bold__ | ~~strike~~ | *italic* | _italic_ | [label](url)
const INLINE =
  /(`+)(.+?)\1|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*(\S(?:.*?\S)?)\*|\b_(\S(?:.*?\S)?)_\b|\[([^\]]+)\]\(([^)\s]+)\)/gs;

export function inline(text: string, style: Style = {}): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ ...style, text: text.slice(last, m.index) });
    const [, , code, b1, b2, strike, i1, i2, label, url] = m;
    const bold = b1 ?? b2;
    const italic = i1 ?? i2;
    if (code !== undefined) out.push({ ...style, color: theme.accent, text: code });
    else if (bold !== undefined) out.push(...inline(bold, { ...style, bold: true }));
    else if (strike !== undefined) out.push(...inline(strike, { ...style, strikethrough: true }));
    else if (italic !== undefined) out.push(...inline(italic, { ...style, italic: true }));
    else if (label !== undefined) {
      out.push(...inline(label, { ...style, color: theme.blue, underline: true }));
      if (url !== label) out.push({ ...style, color: theme.muted, text: ` (${url})` });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ ...style, text: text.slice(last) });
  return out;
}

const graphemes = (s: string) => Array.from(new Intl.Segmenter().segment(s), (g) => g.segment);

/** Word-wraps at `width` columns without dropping any character, so a row's text concatenates back to the line. */
export function wrap(line: string, width: number): string[] {
  const rows: string[] = [];
  let cur = "";
  let w = 0;
  let space = -1; // string index of the last space in `cur`
  for (const g of graphemes(line)) {
    const gw = stringWidth(g);
    if (w + gw > width && cur) {
      // break after the last space if there is one, else mid-word
      const cut = space > 0 ? space + 1 : cur.length;
      rows.push(cur.slice(0, cut));
      cur = cur.slice(cut);
      w = stringWidth(cur);
      space = -1;
    }
    if (g === " ") space = cur.length;
    cur += g;
    w += gw;
  }
  rows.push(cur);
  return rows;
}

/** Text between columns [from, to) of a row. */
export function sliceCols(text: string, from: number, to: number) {
  let col = 0;
  let out = "";
  for (const g of graphemes(text)) {
    if (col >= from && col < to) out += g;
    col += stringWidth(g);
  }
  return out;
}

/** The parts of `spans` between columns [from, to). */
export function cutCols(spans: Span[], from: number, to: number) {
  const out: Span[] = [];
  let col = 0;
  for (const s of spans) {
    const text = sliceCols(s.text, from - col, to - col);
    if (text) out.push({ ...s, text });
    col += stringWidth(s.text);
  }
  return out;
}

const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A table row's cells; `\|` escapes a pipe. ponytail: a `|` inside a code span still splits the cell. */
const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

const spanWidth = (spans: Span[]) => stringWidth(spans.map((s) => s.text).join(""));

/**
 * Lays out a table with columns padded to their widest cell. Wider than `width`, the widest columns shrink and
 * their cells wrap inside the column, so no line soft-wraps and breaks the borders.
 */
function table(rows: string[], width: number): Span[][] {
  const [head = [], delim = [], ...body] = rows.map(cells);
  const grid = [head, ...body].map((r) => head.map((_, c) => inline(r[c] ?? "", r === head ? { bold: true } : {})));
  const widths = head.map((_, c) => Math.max(1, ...grid.map((r) => spanWidth(r[c] ?? []))));
  // ponytail: shrinks one column per step, O(overflow × columns); fine for terminal-sized tables.
  // 2 columns minimum so a wide char still fits; below that the table soft-wraps.
  for (let over = widths.reduce((a, w) => a + w + 3, -3) - width; over > 0; over--) {
    const max = Math.max(...widths);
    if (max <= 2) break;
    widths[widths.indexOf(max)] = max - 1;
  }
  // one grid row → as many lines as its tallest wrapped cell
  const lines = (r: Span[][]) => {
    const parts = r.map((cell, c) => {
      let col = 0;
      return wrap(cell.map((s) => s.text).join(""), widths[c] ?? 1).map((t) => {
        const from = col;
        col += stringWidth(t);
        return cutCols(cell, from, col);
      });
    });
    return Array.from({ length: Math.max(...parts.map((p) => p.length)) }, (_, k) =>
      line(parts.map((p) => p[k] ?? [])),
    );
  };
  const line = (r: Span[][]) =>
    r.flatMap((cell, c) => {
      const pad = (widths[c] ?? 0) - spanWidth(cell);
      const d = delim[c] ?? "";
      const left = d.endsWith(":") ? (d.startsWith(":") ? Math.floor(pad / 2) : pad) : 0;
      return [
        ...(c ? [{ dimColor: true, text: " │ " }] : []),
        ...(left ? [{ text: " ".repeat(left) }] : []),
        ...cell,
        ...(pad - left ? [{ text: " ".repeat(pad - left) }] : []),
      ];
    });
  return [
    ...lines(grid[0] ?? []),
    [{ dimColor: true, text: widths.map((w) => "─".repeat(w)).join("─┼─") }],
    ...grid.slice(1).flatMap(lines),
  ];
}

/**
 * Renders markdown into one list of styled spans per output line: fences, headings, rules, tables, quotes,
 * bullets, and inline styles, which may span the lines of a paragraph, quote or list item.
 */
export function markdown(text: string, width: number): Span[][] {
  const lines = text.split("\n");
  const out: Span[][] = [];
  // the current paragraph, quote or list item: inline styles may cross its line breaks
  let group: { prefix: Span[]; text: string }[] = [];
  let kind: "para" | "quote" | "bullet" | undefined;
  const flush = (style: Style = kind === "quote" ? { color: theme.muted } : {}) => {
    if (!group.length) return;
    const split: Span[][] = [[]];
    for (const s of inline(group.map((g) => g.text).join("\n"), style))
      s.text.split("\n").forEach((t, k) => {
        if (k) split.push([]);
        if (t) split[split.length - 1]?.push({ ...s, text: t });
      });
    group.forEach((g, k) => {
      out.push([...g.prefix, ...(split[k] ?? [])]);
    });
    group = [];
    kind = undefined;
  };
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const open = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (open && (!fence || open.startsWith(fence))) {
      flush();
      fence = fence ? undefined : open;
      out.push([{ color: theme.muted, text: line }]);
      continue;
    }
    if (fence) {
      out.push([{ color: theme.green, text: line }]);
      continue;
    }
    if (!line.trim()) {
      flush();
      out.push([]);
      continue;
    }
    // setext heading: a paragraph underlined with === or ---
    if (kind === "para" && /^ {0,3}(=+|-+) *$/.test(line)) {
      flush({ color: theme.yellow, bold: true });
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const next = lines[i + 1] ?? "";
    if (heading) {
      flush();
      out.push(inline(heading[1] ?? "", { color: theme.yellow, bold: true }));
    } else if (line.includes("|") && next.includes("|") && DELIM.test(next)) {
      flush();
      let end = i + 2;
      while (lines[end]?.includes("|") && lines[end]?.trim()) end++;
      out.push(...table(lines.slice(i, end), width));
      i = end - 1;
    } else if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) {
      flush();
      out.push([{ color: theme.muted, text: "─".repeat(width) }]);
    } else {
      const quote = line.match(/^(\s*)>\s?(.*)$/);
      const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (quote) {
        if (kind !== "quote") flush();
        kind = "quote";
        group.push({ prefix: [{ color: theme.muted, text: `${quote[1]}│ ` }], text: quote[2] ?? "" });
      } else if (bullet) {
        flush();
        kind = "bullet";
        group.push({
          prefix: [...(bullet[1] ? [{ text: bullet[1] }] : []), { color: theme.accent, text: "• " }],
          text: bullet[2] ?? "",
        });
      } else {
        // a plain line continues a paragraph or list item
        if (kind === "quote") flush();
        kind ??= "para";
        group.push({ prefix: [], text: line });
      }
    }
  }
  flush();
  return out;
}
