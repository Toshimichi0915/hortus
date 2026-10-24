import type { TextProps } from "ink";
import stringWidth from "string-width";

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
    if (code !== undefined) out.push({ ...style, color: "yellow", text: code });
    else if (bold !== undefined) out.push(...inline(bold, { ...style, bold: true }));
    else if (strike !== undefined) out.push(...inline(strike, { ...style, strikethrough: true }));
    else if (italic !== undefined) out.push(...inline(italic, { ...style, italic: true }));
    else if (label !== undefined) {
      out.push(...inline(label, { ...style, underline: true }));
      if (url !== label) out.push({ ...style, dimColor: true, text: ` (${url})` });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ ...style, text: text.slice(last) });
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

/** Lays out a table with columns padded to their widest cell. ponytail: wider than the pane, it soft-wraps. */
function table(rows: string[]): Span[][] {
  const [head = [], delim = [], ...body] = rows.map(cells);
  const grid = [head, ...body].map((r) => head.map((_, c) => inline(r[c] ?? "", r === head ? { bold: true } : {})));
  const widths = head.map((_, c) => Math.max(...grid.map((r) => spanWidth(r[c] ?? []))));
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
    line(grid[0] ?? []),
    [{ dimColor: true, text: widths.map((w) => "─".repeat(w)).join("─┼─") }],
    ...grid.slice(1).map(line),
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
  const flush = (style: Style = kind === "quote" ? { dimColor: true } : {}) => {
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
      out.push([{ dimColor: true, text: line }]);
      continue;
    }
    if (fence) {
      out.push([{ color: "yellow", text: line }]);
      continue;
    }
    if (!line.trim()) {
      flush();
      out.push([]);
      continue;
    }
    // setext heading: a paragraph underlined with === or ---
    if (kind === "para" && /^ {0,3}(=+|-+) *$/.test(line)) {
      flush({ bold: true });
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const next = lines[i + 1] ?? "";
    if (heading) {
      flush();
      out.push(inline(heading[1] ?? "", { bold: true }));
    } else if (line.includes("|") && next.includes("|") && DELIM.test(next)) {
      flush();
      let end = i + 2;
      while (lines[end]?.includes("|") && lines[end]?.trim()) end++;
      out.push(...table(lines.slice(i, end)));
      i = end - 1;
    } else if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) {
      flush();
      out.push([{ dimColor: true, text: "─".repeat(width) }]);
    } else {
      const quote = line.match(/^(\s*)>\s?(.*)$/);
      const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (quote) {
        if (kind !== "quote") flush();
        kind = "quote";
        group.push({ prefix: [{ dimColor: true, text: `${quote[1]}│ ` }], text: quote[2] ?? "" });
      } else if (bullet) {
        flush();
        kind = "bullet";
        group.push({ prefix: [{ text: `${bullet[1]}• ` }], text: bullet[2] ?? "" });
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
