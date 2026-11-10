import { stdout } from "node:process";
import { stripVTControlCharacters } from "node:util";
import { Box, type DOMElement, Text, useBoxMetrics, useInput, useStdin } from "ink";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import { type Entry, styles, type TextEntry, type ToolEntry, toolBackground } from "./entry.ts";
import { cutCols, markdown, type Span, sliceCols, wrap } from "./markdown.ts";
import type { ToolBlock } from "./tools.tsx";

/**
 * One screen row. `text` is its plain text and `spans` the same text styled.
 * `cont` = soft-wrapped continuation of the previous row (joined without a newline on copy).
 * `md` = an assistant row's markdown source and the [from, to] source lines it renders, copied instead of `text`.
 * `block` = a row of a tool block: drawn by the block, its text read from the block's renderer only when selected.
 */
export interface Row {
  kind: TextEntry["kind"] | "tool";
  text: string;
  spans: Span[];
  cont: boolean;
  md?: { lines: string[]; from: number; to: number };
  block?: { entry: ToolEntry; line: number };
}
interface Point {
  row: number;
  col: number;
}
/** Each tool's renderer, by tool name. */
export type ToolLookup = (name: string) => ToolBlock;

// rows per entry, reused while its text and the width are unchanged
const cache = new WeakMap<TextEntry, { text: string; width: number; rows: Row[] }>();

function entryRows(e: TextEntry, width: number): Row[] {
  const hit = cache.get(e);
  if (hit && hit.text === e.text && hit.width === width) return hit.rows;
  const rows: Row[] = [];
  const split = e.text.split("\n");
  const src: [number, number][] = [];
  const lines = e.kind === "assistant" ? markdown(e.text, width, src) : split.map((text) => [{ text }]);
  lines.forEach((spans, l) => {
    let col = 0;
    const s = src[l];
    const md = s && { lines: split, from: s[0], to: s[1] };
    wrap(spans.map((s) => s.text).join(""), Math.max(1, width)).forEach((text, i) => {
      const w = stringWidth(text);
      rows.push({ kind: e.kind, text, spans: cutCols(spans, col, col + w), cont: i > 0, md });
      col += w;
    });
  });
  cache.set(e, { text: e.text, width, rows });
  return rows;
}

// a block's placeholder rows, reused while its height is unchanged
const blockCache = new WeakMap<ToolEntry, Row[]>();

function blockRows(e: ToolEntry, height: number): Row[] {
  const hit = blockCache.get(e);
  if (hit?.length === height) return hit;
  const rows = Array.from(
    { length: height },
    (_, line): Row => ({
      kind: "tool",
      text: "",
      spans: [],
      cont: false,
      block: { entry: e, line },
    }),
  );
  blockCache.set(e, rows);
  return rows;
}

/** An entry's place in the rows: from `start`, `height` rows, the first a blank separator when `gap`. */
interface Segment {
  entry: Entry;
  start: number;
  height: number;
  gap: boolean;
}

/** rows a block is taken to have before it was ever measured: its background's top and bottom, and a header */
const UNMEASURED = 3;

/** Every entry's rows, and where each entry's rows are; a tool block has `heightOf(block)` rows. */
export function layout(entries: Entry[], width: number, heightOf: (e: ToolEntry) => number = () => UNMEASURED) {
  const rows: Row[] = [];
  const segments: Segment[] = [];
  for (const e of entries) {
    const start = rows.length;
    // a blank row between user input, thinking, output and tool blocks
    const gap = rows.length > 0 && e.kind !== "info" && e.kind !== "error";
    if (gap) rows.push({ kind: "info", text: "", spans: [], cont: false });
    for (const r of e.kind === "tool" ? blockRows(e, heightOf(e)) : entryRows(e, width)) rows.push(r);
    segments.push({ entry: e, start, height: rows.length - start, gap });
  }
  return { rows, segments };
}

export const toRows = (entries: Entry[], width: number, heightOf?: (e: ToolEntry) => number) =>
  layout(entries, width, heightOf).rows;

// a block's text by width; computed outside render (see `blockLines`), so render only peeks at it
const texts = new WeakMap<ToolEntry, { width: number; lines: string[] }>();

/**
 * A block's rows as plain text: its background's blank top row, its renderer's text, then the blank bottom row. Only
 * call it outside render: a renderer without `text` is rendered to a string, which comes out empty inside a render.
 */
export function blockLines(e: ToolEntry, width: number, tools: ToolLookup): string[] {
  const hit = texts.get(e);
  if (hit?.width === width) return hit.lines;
  const text = tools(e.call.name).text({ call: e.call, result: e.result, details: e.details, width });
  const lines = [
    "",
    ...stripVTControlCharacters(text)
      .split("\n")
      .map((l) => l.trimEnd()),
    "",
  ];
  texts.set(e, { width, lines });
  return lines;
}

const peekLines = (e: ToolEntry, width: number) => {
  const hit = texts.get(e);
  return hit?.width === width ? hit.lines : undefined;
};

/** `rows` with the block rows between `a` and `b` given their text, for copying. */
export function withBlockText(rows: Row[], a: Point, b: Point, width: number, tools: ToolLookup): Row[] {
  const [s, e] = order(a, b) as [Point, Point];
  return rows.map((r, i) =>
    r.block && i >= s.row && i <= e.row
      ? { ...r, text: blockLines(r.block.entry, width, tools)[r.block.line] ?? "" }
      : r,
  );
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

/**
 * The selected text. Across rows, assistant output copies as its markdown source, whole lines: every source line
 * from the first selected one's to the last's, including ones that render to nothing (a setext underline).
 */
export function selectionText(rows: Row[], a: Point, b: Point) {
  const [s, e] = order(a, b) as [Point, Point];
  let out = "";
  let last: { lines: string[]; to: number } | undefined;
  for (let r = s.row; r <= e.row; r++) {
    const row = rows[r];
    if (!row) continue;
    if (row.md && s.row !== e.row) {
      const { lines, from, to } = row.md;
      const start = last?.lines === lines ? last.to + 1 : from;
      for (let l = start; l <= to; l++) out += `${r > s.row || l > start ? "\n" : ""}${lines[l]}`;
      last = { lines, to: Math.max(to, start - 1) };
      continue;
    }
    last = undefined;
    if (r > s.row && !row.cont) out += "\n";
    out += sliceCols(row.text, r === s.row ? s.col : 0, r === e.row ? e.col + 1 : Number.POSITIVE_INFINITY);
  }
  return out;
}

/** A text row, the selected part inverted. */
function RowLine({ row, cols, width }: { row: Row; cols?: readonly [number, number]; width: number }) {
  const style = row.kind === "tool" ? {} : styles[row.kind];
  // fill the rest of the row so a background spans the pane; a blank row is drawn as one space
  const fill = style.backgroundColor ? " ".repeat(Math.max(0, width - Math.max(1, stringWidth(row.text)))) : "";
  return (
    <Text wrap="truncate" {...style}>
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
}

/** A selected part of a block's row: `text` from column `col` of block row `line`, drawn inverted over the block. */
interface Highlight {
  line: number;
  col: number;
  text: string;
}

/**
 * A tool block, always mounted so its renderer keeps its state. Off screen it's hidden (`display: none`, which Ink
 * neither lays out nor draws) inside a box of its last measured height; on screen it's laid out and measured again.
 */
const Block = memo(function Block({
  entry,
  width,
  hidden,
  height,
  tools,
  highlights,
  onMeasure,
}: {
  entry: ToolEntry;
  width: number;
  hidden: boolean;
  height: number;
  tools: ToolLookup;
  highlights?: Highlight[];
  onMeasure: (id: number, width: number, height: number) => void;
}) {
  const shell = useRef<DOMElement>(null);
  const m = useBoxMetrics(shell);
  useEffect(() => {
    // a block is at least its background's two rows, so 0 is a hidden or stale measurement
    if (!hidden && m.hasMeasured && m.width === width && m.height > 0) onMeasure(entry.id, width, m.height);
  }, [hidden, m.hasMeasured, m.width, m.height, width, entry.id, onMeasure]);
  const { Render } = tools(entry.call.name);
  return (
    <Box flexDirection="column" flexShrink={0} height={hidden ? height : undefined}>
      <Box
        ref={shell}
        display={hidden ? "none" : "flex"}
        flexDirection="column"
        flexShrink={0}
        paddingY={1}
        backgroundColor={toolBackground(entry)}
      >
        <Render call={entry.call} result={entry.result} details={entry.details} width={width} />
      </Box>
      {highlights?.map((h) => (
        <Box key={h.line} position="absolute" top={h.line} left={h.col}>
          <Text inverse>{h.text || " "}</Text>
        </Box>
      ))}
    </Box>
  );
});

// SGR mouse report: ESC [ < button ; x ; y (M = press/drag, m = release)
const MOUSE = /\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * Fullscreen transcript: own scrolling (wheel, PgUp/PgDn) and own selection, since the app captures the mouse.
 * Drag selects, release copies via OSC 52. Wheel events below the pane go to `onWheelBelow`.
 */
export function Transcript({
  entries,
  tools,
  onWheelBelow,
  onCopy,
}: {
  entries: Entry[];
  tools: ToolLookup;
  onWheelBelow: (delta: number) => void;
  onCopy: (chars: number) => void;
}) {
  const pane = useRef<DOMElement>(null);
  const { width, height } = useBoxMetrics(pane);

  // blocks' heights as last measured, by entry id; a change re-lays out the rows
  const measured = useRef(new Map<number, { width: number; height: number }>());
  const [version, setVersion] = useState(0);
  const onMeasure = useCallback((id: number, width: number, height: number) => {
    const m = measured.current.get(id);
    if (m?.width === width && m.height === height) return;
    measured.current.set(id, { width, height });
    setVersion((v) => v + 1);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` stands for `measured`'s contents
  const { rows, segments } = useMemo(
    () => layout(entries, width, (e) => measured.current.get(e.id)?.height ?? UNMEASURED),
    [entries, width, version],
  );

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
  const latest = useRef({ rows, top, height, width, tools, sel, scrollBy, onWheelBelow, onCopy });
  latest.current = { rows, top, height, width, tools, sel, scrollBy, onWheelBelow, onCopy };
  const { stdin } = useStdin();
  useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      for (const [, b, x, y, kind] of String(chunk).matchAll(MOUSE)) {
        const { rows, top, height, width, tools, sel, scrollBy, onWheelBelow, onCopy } = latest.current;
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
          const next = { ...sel, b: point(), dragged: true };
          // selected blocks' text, so render can draw their highlight (it can't compute it there)
          withBlockText(rows, next.a, next.b, width, tools);
          setSel(next);
        } else if (kind === "m" && sel) {
          if (!sel.dragged) setSel(undefined);
          else {
            const text = selectionText(withBlockText(rows, sel.a, sel.b, width, tools), sel.a, sel.b);
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

  const bottom = top + height;
  return (
    <Box ref={pane} flexGrow={1} flexBasis={0} flexDirection="column" overflow="hidden" contentOffsetY={top}>
      <Box flexDirection="column" flexShrink={0} width="100%">
        {segments.map(({ entry: e, start, height: h, gap }) => {
          const end = start + h;
          if (e.kind === "tool") {
            const from = start + (gap ? 1 : 0);
            const m = measured.current.get(e.id);
            // laid out on screen, and wherever it was never measured at this width (once, to measure it)
            const hidden = m?.width === width && (end <= top || from >= bottom);
            return (
              <Fragment key={e.id}>
                {gap && <Box height={1} flexShrink={0} />}
                <Block
                  entry={e}
                  width={width}
                  hidden={hidden}
                  height={end - from}
                  tools={tools}
                  highlights={hidden ? undefined : highlights(e, from, end, sel, width)}
                  onMeasure={onMeasure}
                />
              </Fragment>
            );
          }
          // only rows on screen are drawn; the box keeps the entry's full height so what follows lines up
          const first = Math.max(start, top);
          const last = Math.min(end, bottom);
          return (
            <Box key={e.id} height={h} flexShrink={0} flexDirection="column">
              {first < last && (
                <Box marginTop={first - start} flexShrink={0} flexDirection="column">
                  {rows.slice(first, last).map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
                    <RowLine key={i} row={row} cols={selectedCols(sel, first + i)} width={width} />
                  ))}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

/** The selected parts of a block's rows [from, to), with the text the drag handler worked out for them. */
function highlights(e: ToolEntry, from: number, to: number, sel: { a: Point; b: Point } | undefined, width: number) {
  if (!sel) return;
  const lines = peekLines(e, width);
  // ponytail: a block updated mid-selection has no text yet, so it shows unselected until the mouse moves again
  if (!lines) return;
  const out: Highlight[] = [];
  for (let r = from; r < to; r++) {
    const cols = selectedCols(sel, r);
    if (!cols) continue;
    const line = r - from;
    out.push({ line, col: cols[0], text: sliceCols(lines[line] ?? "", cols[0], cols[1]) });
  }
  return out.length ? out : undefined;
}
