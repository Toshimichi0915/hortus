import { stripVTControlCharacters } from "node:util";
import { Box, type DOMElement, Text, useBoxMetrics, useInput, useStdin } from "ink";
import { Fragment, memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import { type Entry, styleOf, type TextEntry, type ToolEntry, toolBackground } from "./entry.ts";
import { cutCols, markdown, type Span, sliceCols, wrap } from "./markdown.ts";
import { theme, themeVersion } from "./themes.ts";
import type { EntryBlock, ToolBlock, ToolView } from "./tools.tsx";

/**
 * One screen row. `text` is its plain text and `spans` the same text styled.
 * `cont` = soft-wrapped continuation of the previous row (joined without a newline on copy).
 * `md` = an assistant row's markdown source and the [from, to] source lines it renders, copied instead of `text`.
 * `block` = a row of a tool block: drawn by the block, its text read from the block's renderer only when selected.
 */
export interface Row {
  kind: string;
  text: string;
  spans: Span[];
  cont: boolean;
  md?: { lines: string[]; from: number; to: number };
  block?: { entry: Entry; line: number };
}
interface Point {
  row: number;
  col: number;
}
/** Each tool's renderer, by tool name. */
export type ToolLookup = (name: string) => ToolBlock;

/**
 * What draws blocks: each tool's renderer, the renderer of text kinds a plugin draws (`cli.entries`; none: drawn as
 * rows here), and whether tool blocks show everything.
 */
export interface Renderers {
  tools: ToolLookup;
  texts?: (kind: string) => EntryBlock | undefined;
  expanded?: boolean;
}

// rows per entry, reused while its text, the width and the theme are unchanged
const cache = new WeakMap<TextEntry, { text: string; width: number; version: number; rows: Row[] }>();

function entryRows(e: TextEntry, width: number): Row[] {
  const hit = cache.get(e);
  if (hit && hit.text === e.text && hit.width === width && hit.version === themeVersion) return hit.rows;
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
  cache.set(e, { text: e.text, width, version: themeVersion, rows });
  return rows;
}

/** A text kind's own drawing as a block: `Default` for a plugin's `cli.entries` renderer of that kind. */
export const textBlock: EntryBlock = {
  Render: ({ entry, width }) => (
    <Box flexDirection="column">
      {entryRows(entry, width).map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
        <RowLine key={i} row={row} width={width} />
      ))}
    </Box>
  ),
  text: ({ entry, width }) =>
    entryRows(entry, width)
      .map((r) => r.text)
      .join("\n"),
};

// a block's placeholder rows, reused while its height is unchanged
const blockCache = new WeakMap<Entry, Row[]>();

function blockRows(e: Entry, height: number): Row[] {
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

/**
 * Every entry's rows, and where each entry's rows are; a block (a tool's, or an entry `isBlock` says a renderer draws)
 * has `heightOf(block)` rows, and none, not even a gap, when it drew nothing.
 */
export function layout(
  entries: Entry[],
  width: number,
  heightOf: (e: Entry) => number = () => UNMEASURED,
  isBlock: (e: Entry) => boolean = (e) => e.kind === "tool",
) {
  const rows: Row[] = [];
  const segments: Segment[] = [];
  for (const e of entries) {
    const start = rows.length;
    const block = isBlock(e);
    const height = block ? heightOf(e) : 0;
    // a blank row between user input, thinking, output and tool blocks
    const gap = rows.length > 0 && !["info", "warn", "error"].includes(e.kind) && (!block || height > 0);
    if (gap) rows.push({ kind: "info", text: "", spans: [], cont: false });
    for (const r of block ? blockRows(e, height) : entryRows(e as TextEntry, width)) rows.push(r);
    segments.push({ entry: e, start, height: rows.length - start, gap });
  }
  return { rows, segments };
}

export const toRows = (entries: Entry[], width: number, heightOf?: (e: Entry) => number) =>
  layout(entries, width, heightOf).rows;

/** The view a tool block's renderer gets. */
export const toolView = (e: ToolEntry, width: number, expanded = false): ToolView => ({
  call: e.call,
  result: e.result,
  details: e.details,
  width,
  expanded,
  ...(e.partial !== undefined && { partial: e.partial }),
  siblings: e.siblings ?? [],
});

/**
 * How `e` is drawn as a block: its component and props, its text, and (tools) its background and padding (its
 * renderer's `chrome`); undefined: as rows.
 */
export function drawn(e: Entry, width: number, r: Renderers) {
  if (e.kind === "tool") {
    const b = r.tools(e.call.name);
    const view = toolView(e, width, r.expanded);
    const chrome = b.chrome?.(view) ?? {};
    const background = chrome.background === false ? undefined : (chrome.background ?? toolBackground(e));
    return {
      Render: b.Render as (v: object) => ReactNode,
      view,
      text: () => b.text(view),
      background,
      padding: chrome.padding ?? !!background,
    };
  }
  const b = r.texts?.(e.kind);
  if (!b) return undefined;
  const view = { entry: e as TextEntry, width };
  return {
    Render: b.Render as (v: object) => ReactNode,
    view,
    text: () => b.text(view),
    background: undefined,
    padding: false,
  };
}

// a block's text by width (and expansion); computed outside render (see `blockLines`), so render only peeks at it
const texts = new WeakMap<Entry, { key: string; lines: string[] }>();
const textKey = (width: number, r: Renderers) => `${width}/${r.expanded ?? false}`;

/**
 * A block's rows as plain text: a tool's background's blank top row, its renderer's text, then the blank bottom row
 * (none at all when it draws nothing). Only call it outside render: a renderer without `text` is rendered to a string,
 * which comes out empty inside a render.
 */
export function blockLines(e: Entry, width: number, r: Renderers | ToolLookup): string[] {
  const renderers = typeof r === "function" ? { tools: r } : r;
  const key = textKey(width, renderers);
  const hit = texts.get(e);
  if (hit?.key === key) return hit.lines;
  const d = drawn(e, width, renderers);
  const text = d ? stripVTControlCharacters(d.text()) : "";
  const body = text ? text.split("\n").map((l) => l.trimEnd()) : [];
  const lines = d?.padding && body.length ? ["", ...body, ""] : body;
  texts.set(e, { key, lines });
  return lines;
}

const peekLines = (e: Entry, width: number, r: Renderers) => {
  const hit = texts.get(e);
  return hit?.key === textKey(width, r) ? hit.lines : undefined;
};

/** `rows` with the block rows between `a` and `b` given their text, for copying. */
export function withBlockText(rows: Row[], a: Point, b: Point, width: number, r: Renderers | ToolLookup): Row[] {
  const [s, e] = order(a, b) as [Point, Point];
  return rows.map((row, i) =>
    row.block && i >= s.row && i <= e.row
      ? { ...row, text: blockLines(row.block.entry, width, r)[row.block.line] ?? "" }
      : row,
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

/** How a selection over background `under` is drawn: on `selectedBg`, or inverted when that's "" or `under` itself. */
const selected = (under?: string) =>
  theme.selectedBg && theme.selectedBg !== under ? { backgroundColor: theme.selectedBg } : { inverse: true };

/** A text row, the selected part highlighted (see `selected`). */
function RowLine({ row, cols, width }: { row: Row; cols?: readonly [number, number]; width: number }) {
  const style = row.kind === "tool" ? {} : styleOf(row.kind);
  // fill the rest of the row so a background spans the pane; a blank row is drawn as one space
  const fill = style.backgroundColor ? " ".repeat(Math.max(0, width - Math.max(1, stringWidth(row.text)))) : "";
  return (
    <Text wrap="truncate" {...style}>
      {cols ? (
        <>
          {show(cutCols(row.spans, 0, cols[0]))}
          <Text {...selected(style.backgroundColor)}>
            {sliceCols(row.text, cols[0], cols[1]) ? show(cutCols(row.spans, ...cols)) : " "}
          </Text>
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

/** A selected part of a block's row: `text` from column `col` of block row `line`, highlighted over the block. */
interface Highlight {
  line: number;
  col: number;
  text: string;
}

/**
 * A block (a tool's, or a text entry a plugin draws), always mounted so its renderer keeps its state. Off screen it's
 * hidden (`display: none`, which Ink neither lays out nor draws) inside a box of its last measured height; on screen
 * it's laid out and measured again. One that draws nothing takes no rows (a tool's has no background then).
 */
const Block = memo(function Block({
  entry,
  width,
  hidden,
  height,
  renderers,
  highlights,
  onMeasure,
}: {
  entry: Entry;
  width: number;
  hidden: boolean;
  height: number;
  renderers: Renderers;
  /** the theme's name: a switch re-renders the block */
  theme?: string;
  highlights?: Highlight[];
  onMeasure: (id: number, key: string, height: number) => void;
}) {
  const shell = useRef<DOMElement>(null);
  const content = useRef<DOMElement>(null);
  const m = useBoxMetrics(shell);
  const c = useBoxMetrics(content);
  const empty = c.hasMeasured && c.height === 0;
  const key = textKey(width, renderers);
  useEffect(() => {
    // a drawn block is at least one row, so 0 is a hidden or stale measurement unless its content is empty
    if (!hidden && m.hasMeasured && m.width === width && (m.height > 0 || empty)) onMeasure(entry.id, key, m.height);
  }, [hidden, m.hasMeasured, m.width, m.height, empty, width, key, entry.id, onMeasure]);
  const d = drawn(entry, width, renderers);
  if (!d) return null;
  const { Render, view, background, padding } = d;
  return (
    <Box flexDirection="column" flexShrink={0} height={hidden ? height : undefined}>
      <Box
        ref={shell}
        display={hidden ? "none" : "flex"}
        flexDirection="column"
        flexShrink={0}
        paddingY={padding && !empty ? 1 : 0}
        backgroundColor={empty ? undefined : background}
      >
        <Box ref={content} flexDirection="column" flexShrink={0}>
          <Render {...view} />
        </Box>
      </Box>
      {highlights?.map((h) => (
        <Box key={h.line} position="absolute" top={h.line} left={h.col}>
          <Text {...selected(background)}>{h.text || " "}</Text>
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
  texts,
  expanded = false,
  theme,
  onWheelBelow,
  onCopy,
  onScroller,
}: {
  entries: Entry[];
  tools: ToolLookup;
  /** renderers of text kinds plugins draw (see `Renderers`) */
  texts?: Renderers["texts"];
  expanded?: boolean;
  /** the theme's name: a switch redraws every row */
  theme?: string;
  onWheelBelow: (delta: number) => void;
  /** the selected text, to put on the clipboard (`cli.copy`) */
  onCopy: (text: string) => void;
  /** gets a function scrolling the pane by rows, or to its "top" / "bottom" (`cli.scroll`); undefined on unmount */
  onScroller?: (scroll: ((to: number | "top" | "bottom") => void) | undefined) => void;
}) {
  const pane = useRef<DOMElement>(null);
  const { width, height } = useBoxMetrics(pane);
  const renderers = useMemo(() => ({ tools, texts, expanded }), [tools, texts, expanded]);
  const key = textKey(width, renderers);

  // blocks' heights as last measured, by entry id, with the width and expansion they were measured at; a change
  // re-lays out the rows
  const measured = useRef(new Map<number, { key: string; height: number }>());
  const [version, setVersion] = useState(0);
  const onMeasure = useCallback((id: number, key: string, height: number) => {
    const m = measured.current.get(id);
    if (m?.key === key && m.height === height) return;
    measured.current.set(id, { key, height });
    setVersion((v) => v + 1);
  }, []);
  const isBlock = useCallback((e: Entry) => e.kind === "tool" || !!texts?.(e.kind), [texts]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` stands for `measured`'s contents, `theme` for the rows' colors
  const { rows, segments } = useMemo(
    () =>
      layout(
        entries,
        width,
        (e) => {
          const m = measured.current.get(e.id);
          return m?.key === key ? m.height : UNMEASURED;
        },
        isBlock,
      ),
    [entries, width, version, key, isBlock, theme],
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

  const scrollRef = useRef(scrollBy);
  scrollRef.current = scrollBy;
  useEffect(() => {
    onScroller?.((to) =>
      // the top by scrolling all the way up: pinned only when there's somewhere to scroll
      to === "top" ? scrollRef.current(-Infinity) : to === "bottom" ? setPinned(undefined) : scrollRef.current(to),
    );
    return () => onScroller?.(undefined);
  }, [onScroller]);

  useInput((_, key) => {
    if (key.pageUp) scrollBy(-Math.max(1, Math.floor(height / 2)));
    else if (key.pageDown) scrollBy(Math.max(1, Math.floor(height / 2)));
  });

  // Ink drops mouse reports before useInput, so read the raw chunks it pulls from stdin.
  // Handlers read the latest render's values through a ref instead of re-subscribing every render.
  const latest = useRef({ rows, top, height, width, renderers, sel, scrollBy, onWheelBelow, onCopy });
  latest.current = { rows, top, height, width, renderers, sel, scrollBy, onWheelBelow, onCopy };
  const { stdin } = useStdin();
  useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      for (const [, b, x, y, kind] of String(chunk).matchAll(MOUSE)) {
        const { rows, top, height, width, renderers, sel, scrollBy, onWheelBelow, onCopy } = latest.current;
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
          withBlockText(rows, next.a, next.b, width, renderers);
          setSel(next);
        } else if (kind === "m" && sel) {
          if (!sel.dragged) setSel(undefined);
          else {
            const text = selectionText(withBlockText(rows, sel.a, sel.b, width, renderers), sel.a, sel.b);
            onCopy(text);
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
          if (isBlock(e)) {
            const from = start + (gap ? 1 : 0);
            const m = measured.current.get(e.id);
            // laid out on screen, and wherever it was never measured at this width (once, to measure it)
            const hidden = m?.key === key && (end <= top || from >= bottom);
            return (
              <Fragment key={e.id}>
                {gap && <Box height={1} flexShrink={0} />}
                <Block
                  entry={e}
                  width={width}
                  hidden={hidden}
                  height={end - from}
                  renderers={renderers}
                  theme={theme}
                  highlights={hidden ? undefined : highlights(e, from, end, sel, width, renderers)}
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
function highlights(
  e: Entry,
  from: number,
  to: number,
  sel: { a: Point; b: Point } | undefined,
  width: number,
  r: Renderers,
) {
  if (!sel) return;
  const lines = peekLines(e, width, r);
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
