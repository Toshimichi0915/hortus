import { stdout } from "node:process";
import { Box, type DOMElement, Text, useBoxMetrics, useInput, useStdin } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import { type Entry, styles } from "./entry.ts";
import { markdown, type Span } from "./markdown.ts";

/**
 * One screen row. `text` is its plain text and `spans` the same text styled.
 * `cont` = soft-wrapped continuation of the previous row (joined without a newline on copy).
 */
export type Row = { kind: Entry["kind"]; text: string; spans: Span[]; cont: boolean; bold?: boolean };
type Point = { row: number; col: number };

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

export function toRows(entries: Entry[], width: number): Row[] {
  const rows: Row[] = [];
  for (const e of entries) {
    const block = !!styles[e.kind].backgroundColor;
    if (e.kind === "user" || block) rows.push({ kind: "info", text: "", spans: [], cont: false });
    // a block's header is its first non-blank line
    const head = block ? e.text.split("\n").findIndex(Boolean) : -1;
    const text = `${styles[e.kind].prefix ?? ""}${e.text}`;
    const lines = e.kind === "assistant" ? markdown(text, width) : text.split("\n").map((t) => [{ text: t }]);
    lines.forEach((spans, l) => {
      let col = 0;
      wrap(spans.map((s) => s.text).join(""), Math.max(1, width)).forEach((text, i) => {
        const w = stringWidth(text);
        rows.push({ kind: e.kind, text, spans: cutCols(spans, col, col + w), cont: i > 0, bold: l === head });
        col += w;
      });
    });
  }
  return rows;
}

/** Text between columns [from, to) of a row. */
function sliceCols(text: string, from: number, to: number) {
  let col = 0;
  let out = "";
  for (const g of graphemes(text)) {
    if (col >= from && col < to) out += g;
    col += stringWidth(g);
  }
  return out;
}

/** The parts of `spans` between columns [from, to). */
function cutCols(spans: Span[], from: number, to: number) {
  const out: Span[] = [];
  let col = 0;
  for (const s of spans) {
    const text = sliceCols(s.text, from - col, to - col);
    if (text) out.push({ ...s, text });
    col += stringWidth(s.text);
  }
  return out;
}

const show = (spans: Span[]) =>
  spans.map(({ text, ...style }, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional
    <Text key={i} {...style}>
      {text}
    </Text>
  ));

const order = (a: Point, b: Point) => (a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a]);

/** Columns [from, to) of `row` covered by the selection, or undefined. */
function selectedCols(sel: { a: Point; b: Point } | undefined, row: number) {
  if (!sel) return;
  const [s, e] = order(sel.a, sel.b) as [Point, Point];
  if (row < s.row || row > e.row) return;
  return [row === s.row ? s.col : 0, row === e.row ? e.col + 1 : Number.POSITIVE_INFINITY] as const;
}

export function selectionText(rows: Row[], a: Point, b: Point) {
  const [s, e] = order(a, b) as [Point, Point];
  let out = "";
  for (let r = s.row; r <= e.row; r++) {
    const row = rows[r];
    if (!row) continue;
    if (r > s.row && !row.cont) out += "\n";
    out += sliceCols(row.text, r === s.row ? s.col : 0, r === e.row ? e.col + 1 : Number.POSITIVE_INFINITY);
  }
  return out;
}

// SGR mouse report: ESC [ < button ; x ; y (M = press/drag, m = release)
const MOUSE = /\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * Fullscreen transcript: own scrolling (wheel, PgUp/PgDn) and own selection, since the app captures the mouse.
 * Drag selects, release copies via OSC 52. Wheel events below the pane go to `onWheelBelow`.
 */
export function Transcript({
  entries,
  onWheelBelow,
  onCopy,
}: {
  entries: Entry[];
  onWheelBelow: (delta: number) => void;
  onCopy: (chars: number) => void;
}) {
  const pane = useRef<DOMElement>(null);
  const { width, height } = useBoxMetrics(pane);
  // ponytail: re-wraps the whole history every render; cache rows per entry if long sessions get slow
  const rows = useMemo(() => toRows(entries, width), [entries, width]);
  const maxTop = Math.max(0, rows.length - height);
  // undefined = follow the bottom; a number pins the top row so new output doesn't move the view
  const [pinned, setPinned] = useState<number>();
  const top = Math.min(pinned ?? maxTop, maxTop);
  const [sel, setSel] = useState<{ a: Point; b: Point; dragged: boolean }>();

  // a resize re-wraps every row, so old selection coordinates mean nothing
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on width change only
  useEffect(() => setSel(undefined), [width]);

  const scrollBy = (delta: number) =>
    setPinned((p) => {
      const next = Math.max(0, (p ?? maxTop) + delta);
      return next >= maxTop ? undefined : next;
    });

  useInput((_, key) => {
    if (key.pageUp) scrollBy(-Math.max(1, Math.floor(height / 2)));
    else if (key.pageDown) scrollBy(Math.max(1, Math.floor(height / 2)));
  });

  // Ink drops mouse reports before useInput, so read the raw chunks it pulls from stdin.
  // Handlers read the latest render's values through a ref instead of re-subscribing every render.
  const latest = useRef({ rows, top, height, sel, scrollBy, onWheelBelow, onCopy });
  latest.current = { rows, top, height, sel, scrollBy, onWheelBelow, onCopy };
  const { stdin } = useStdin();
  useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      for (const [, b, x, y, kind] of String(chunk).matchAll(MOUSE)) {
        const { rows, top, height, sel, scrollBy, onWheelBelow, onCopy } = latest.current;
        const button = Number(b) & ~(4 | 8 | 16); // drop shift/alt/ctrl bits
        const screenRow = Number(y) - 1; // the pane starts at the top-left of the alternate screen
        const point = (): Point => ({
          row: Math.max(0, Math.min(rows.length - 1, top + Math.max(0, Math.min(height - 1, screenRow)))),
          col: Number(x) - 1,
        });

        if (button === 64 || button === 65) {
          const delta = button === 64 ? -3 : 3;
          if (screenRow < height) scrollBy(delta);
          else onWheelBelow(-delta);
        } else if (button === 0 && kind === "M") {
          // press starts a new selection (only inside the pane)
          setSel(screenRow < height ? { a: point(), b: point(), dragged: false } : undefined);
        } else if (button === 32 && kind === "M" && sel) {
          // drag past the edges scrolls; ponytail: only while the mouse moves, add a timer for hold-to-scroll
          if (screenRow < 0) scrollBy(-1);
          else if (screenRow >= height) scrollBy(1);
          setSel({ ...sel, b: point(), dragged: true });
        } else if (kind === "m" && sel) {
          if (!sel.dragged) setSel(undefined);
          else {
            const text = selectionText(rows, sel.a, sel.b);
            // OSC 52: ask the terminal to put the text on the system clipboard
            stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
            onCopy(text.length);
          }
        }
      }
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [stdin]);

  return (
    <Box ref={pane} flexGrow={1} flexBasis={0} flexDirection="column" overflow="hidden">
      {rows.slice(top, top + height).map((row, i) => {
        const { prefix: _, ...style } = styles[row.kind];
        const cols = selectedCols(sel, top + i);
        // fill the rest of the row so a block's background spans the pane
        const fill = style.backgroundColor ? " ".repeat(Math.max(0, width - stringWidth(row.text))) : "";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
          <Text key={i} wrap="truncate" bold={row.bold} {...style}>
            {cols ? (
              <>
                {show(cutCols(row.spans, 0, cols[0]))}
                <Text inverse>{sliceCols(row.text, cols[0], cols[1]) ? show(cutCols(row.spans, ...cols)) : " "}</Text>
                {show(cutCols(row.spans, cols[1], Number.POSITIVE_INFINITY))}
              </>
            ) : row.text ? (
              show(row.spans)
            ) : (
              " "
            )}
            {fill}
          </Text>
        );
      })}
    </Box>
  );
}
