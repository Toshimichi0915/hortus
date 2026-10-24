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

  const insert = (text: string) => {
    onChange(chars.slice(0, pos).join("") + text + chars.slice(pos).join(""));
    setCursor(pos + [...text].length);
  };

  useInput((input, key) => {
    if (key.return) {
      if (key.shift || key.meta) insert("\n");
      else onSubmit(value);
    } else if (key.leftArrow) setCursor(Math.max(0, pos - 1));
    else if (key.rightArrow) setCursor(Math.min(chars.length, pos + 1));
    else if (key.backspace || key.delete) {
      if (pos > 0) {
        onChange(chars.slice(0, pos - 1).join("") + chars.slice(pos).join(""));
        setCursor(pos - 1);
      }
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

  // the real terminal cursor sits on the caret, so the IME draws its preedit there; hidden when scrolled out of view
  const [screen, setScreen] = useState<CursorPosition>();
  const { setCursorPosition } = useCursor();
  setCursorPosition(screen);
  useEffect(() => {
    if (!ref.current) return;
    const box = screenBox(ref.current);
    const y = box.y + caret.row;
    const next = y >= box.top && y < box.bottom ? { x: box.x + caret.col, y } : undefined;
    if (next?.x !== screen?.x || next?.y !== screen?.y) setScreen(next);
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
