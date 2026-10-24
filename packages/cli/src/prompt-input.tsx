import {
  Box,
  type CursorPosition,
  type DOMElement,
  measureElement,
  Text,
  useBoxMetrics,
  useCursor,
  useInput,
} from "ink";
import { useEffect, useRef, useState } from "react";
import stringWidth from "string-width";
import { wrap } from "./markdown.ts";

/** `node`'s top-left on screen plus the visible row range of its clipping ancestors, undoing every `contentOffsetY`. */
function screenBox(node: DOMElement) {
  const chain: DOMElement[] = [];
  for (let n: DOMElement | undefined = node; n; n = n.parentNode) chain.unshift(n);
  let shift = 0;
  let top = 0;
  let bottom = Number.POSITIVE_INFINITY;
  for (const n of chain) {
    const m = measureElement(n);
    if (n.style.overflow === "hidden" || n.style.overflowY === "hidden") {
      top = Math.max(top, m.y - shift);
      bottom = Math.min(bottom, m.y - shift + m.height);
    }
    shift += n.style.contentOffsetY ?? 0;
  }
  const m = measureElement(node);
  return { x: m.x, y: m.y - shift, top, bottom };
}

/** Visual rows, as code-point ranges into `chars`, and the caret's row/column. */
function layout(chars: string[], pos: number, width: number) {
  // `end` is where the row's line ends, `last` whether the row ends it
  const rows: { text: string; start: number; end: number; last: boolean }[] = [];
  let lineStart = 0;
  for (const line of chars.join("").split("\n")) {
    const end = lineStart + [...line].length;
    // a caret at the end of a line still needs a cell, so wrap with a space there
    const wrapped = wrap(pos === end ? `${line} ` : line, width);
    let start = lineStart;
    for (const [r, text] of wrapped.entries()) {
      rows.push({ text, start, end, last: r === wrapped.length - 1 });
      start += [...text].length;
    }
    lineStart = end + 1;
  }
  const found = rows.findIndex((r) => pos < r.start + [...r.text].length);
  const row = found === -1 ? rows.length - 1 : found;
  const col = stringWidth(chars.slice(rows[row]?.start ?? 0, pos).join(""));
  return { rows, caret: { row, col } };
}

/** Where ↑ (`-1`) / ↓ (`1`) takes the caret: the closest column on the neighbouring visual row; undefined past either end. */
export function moveRow(chars: string[], pos: number, width: number, dir: -1 | 1) {
  const { rows, caret } = layout(chars, pos, width);
  const to = rows[caret.row + dir];
  if (!to) return;
  // not past the row: a wrapped row's last position belongs to the next one
  const max = to.last ? to.end : to.start + [...to.text].length - 1;
  let at = to.start;
  while (at < max && stringWidth(chars.slice(to.start, at + 1).join("")) <= caret.col) at++;
  return at;
}

/** Multi-line text input: Enter submits, Shift+Enter (or Alt+Enter where the terminal can't report Shift) inserts a newline.
 * ↑/↓ move between visual rows; `onCaretRow` reports the caret's row counted from the bottom, so a scroller can follow it. */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  onCaretRow,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCaretRow?: (fromBottom: number) => void;
}) {
  // cursor counts code points, so emoji move as one step
  const chars = [...value];
  const [cursor, setCursor] = useState(chars.length);
  // the parent may shorten the value (submit, clear)
  const pos = Math.min(cursor, chars.length);

  // wrap ourselves (instead of letting Ink) so we know which row/column the caret lands on
  const ref = useRef<DOMElement>(null);
  const width = useBoxMetrics(ref).width || Number.MAX_SAFE_INTEGER;
  const { rows, caret } = layout(chars, pos, width);

  // keys can arrive faster than renders (e.g. held Backspace while a reply streams), so each one
  // builds on the previous key's result, not on this render's possibly stale props
  const latest = useRef({ chars, pos });
  latest.current = { chars, pos };
  const update = (next: string[], at: number) => {
    latest.current = { chars: next, pos: at };
    onChange(next.join(""));
    setCursor(at);
    const { rows, caret } = layout(next, at, width);
    onCaretRow?.(rows.length - 1 - caret.row);
  };

  useInput((input, key) => {
    const { chars, pos } = latest.current;
    const insert = (text: string) =>
      update([...chars.slice(0, pos), ...text, ...chars.slice(pos)], pos + [...text].length);
    if (key.return) {
      if (key.shift || key.meta) insert("\n");
      else onSubmit(chars.join(""));
    } else if (key.upArrow || key.downArrow) {
      const at = moveRow(chars, pos, width, key.upArrow ? -1 : 1);
      if (at !== undefined) update(chars, at);
    } else if (key.leftArrow || (key.ctrl && input === "b")) update(chars, Math.max(0, pos - 1));
    else if (key.rightArrow || (key.ctrl && input === "f")) update(chars, Math.min(chars.length, pos + 1));
    // Home/End stay within the current line of a multi-line input
    else if (key.home || (key.ctrl && input === "a")) update(chars, chars.slice(0, pos).lastIndexOf("\n") + 1);
    else if (key.end || (key.ctrl && input === "e")) {
      const nl = chars.indexOf("\n", pos);
      update(chars, nl === -1 ? chars.length : nl);
    } else if (key.backspace) {
      if (pos > 0) update([...chars.slice(0, pos - 1), ...chars.slice(pos)], pos - 1);
    } else if (key.delete) {
      if (pos < chars.length) update([...chars.slice(0, pos), ...chars.slice(pos + 1)], pos);
    } else if (input && !key.ctrl && !key.meta) insert(input.replace(/\r\n?/g, "\n"));
  });

  // the real terminal cursor sits on the caret, so the IME draws its preedit there; hidden when scrolled out of view.
  // only the box's screen position needs layout (from the last frame); the caret is placed from this render so it doesn't lag a frame
  const [box, setBox] = useState<ReturnType<typeof screenBox>>();
  const { setCursorPosition } = useCursor();
  const y = box && box.y + caret.row;
  const screen: CursorPosition | undefined =
    box && y !== undefined && y >= box.top && y < box.bottom ? { x: box.x + caret.col, y } : undefined;
  setCursorPosition(screen);
  useEffect(() => {
    if (!ref.current) return;
    const next = screenBox(ref.current);
    if (next.x !== box?.x || next.y !== box?.y || next.top !== box?.top || next.bottom !== box?.bottom) setBox(next);
  });

  return (
    <Box ref={ref} flexDirection="column" width="100%">
      {rows.map(({ text }, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
        <Text key={i}>{text || " "}</Text>
      ))}
    </Box>
  );
}
