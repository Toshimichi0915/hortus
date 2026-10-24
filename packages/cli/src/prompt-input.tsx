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

/** Multi-line text input: Enter submits, Shift+Enter (or Alt+Enter where the terminal can't report Shift) inserts a newline. */
export function PromptInput({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  // cursor counts code points, so emoji move as one step
  const chars = [...value];
  const [cursor, setCursor] = useState(chars.length);
  // the parent may shorten the value (submit, clear)
  const pos = Math.min(cursor, chars.length);

  // keys can arrive faster than renders (e.g. held Backspace while a reply streams), so each one
  // builds on the previous key's result, not on this render's possibly stale props
  const latest = useRef({ chars, pos });
  latest.current = { chars, pos };
  const update = (next: string[], at: number) => {
    latest.current = { chars: next, pos: at };
    onChange(next.join(""));
    setCursor(at);
  };

  useInput((input, key) => {
    const { chars, pos } = latest.current;
    const insert = (text: string) =>
      update([...chars.slice(0, pos), ...text, ...chars.slice(pos)], pos + [...text].length);
    if (key.return) {
      if (key.shift || key.meta) insert("\n");
      else onSubmit(chars.join(""));
    } else if (key.leftArrow) update(chars, Math.max(0, pos - 1));
    else if (key.rightArrow) update(chars, Math.min(chars.length, pos + 1));
    else if (key.backspace || key.delete) {
      if (pos > 0) update([...chars.slice(0, pos - 1), ...chars.slice(pos)], pos - 1);
    } else if (input && !key.ctrl && !key.meta) insert(input.replace(/\r\n?/g, "\n"));
  });

  // wrap ourselves (instead of letting Ink) so we know which row/column the caret lands on
  const ref = useRef<DOMElement>(null);
  const width = useBoxMetrics(ref).width || Number.MAX_SAFE_INTEGER;
  const before = chars.slice(0, pos).join("").split("\n");
  const lines = value.split("\n");
  const caretLine = before.length - 1;
  const caretIdx = (before[caretLine] ?? "").length;
  const rows: string[] = [];
  let caret = { row: 0, col: 0 };
  lines.forEach((line, i) => {
    // a caret at the end of a line still needs a cell, so wrap with a space there
    const wrapped = wrap(i === caretLine && caretIdx === line.length ? `${line} ` : line, width);
    if (i === caretLine) {
      let rest = caretIdx;
      for (const [r, text] of wrapped.entries()) {
        if (rest < text.length || r === wrapped.length - 1) {
          caret = { row: rows.length + r, col: stringWidth(text.slice(0, rest)) };
          break;
        }
        rest -= text.length;
      }
    }
    rows.push(...wrapped);
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
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
        <Text key={i}>{row || " "}</Text>
      ))}
    </Box>
  );
}
