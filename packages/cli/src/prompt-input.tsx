import {
  Box,
  type CursorPosition,
  type DOMElement,
  type Key,
  measureElement,
  Text,
  useBoxMetrics,
  useCursor,
  useInput,
  useStdin,
} from "ink";
import { useEffect, useRef, useState } from "react";
import stringWidth from "string-width";
import { wrap } from "./markdown.ts";
import { theme } from "./themes.ts";

// SGR mouse report: ESC [ < button ; x ; y (M = press/drag, m = release)
const MOUSE = /\[<(\d+);(\d+);(\d+)([Mm])/g;

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

/** The code-point index under visual row `row`, column `col` (clamped to the text). */
export function posAt(chars: string[], pos: number, width: number, row: number, col: number) {
  const { rows } = layout(chars, pos, width);
  const r = rows[Math.max(0, Math.min(rows.length - 1, row))];
  if (!r) return 0;
  const max = r.last ? r.end : r.start + [...r.text].length;
  let at = r.start;
  while (at < max && stringWidth(chars.slice(r.start, at + 1).join("")) <= col) at++;
  return at;
}

/** A drag's code points [from, to): both end cells included. */
const span = ({ a, b }: { a: number; b: number }, length: number) =>
  [Math.min(a, b), Math.min(length, Math.max(a, b) + 1)] as const;

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
 * ↑/↓ move between visual rows; `onCaretRow` reports the caret's row counted from the bottom, so a scroller can follow it.
 * `onKey` sees every key first; returning true keeps it from the input. `mask` draws each character as `*`. `onChange`
 * also gets the caret (a code-point index); a `caret` prop other than the one last reported moves it there (undefined:
 * a `value` the parent changed puts it at the end). With `onCopy`, a mouse drag over it selects (copied on release) and a
 * click moves the caret. */
export function PromptInput({
  value,
  caret: wanted,
  onChange,
  onSubmit,
  onKey,
  onCaretRow,
  onCopy,
  mask,
}: {
  value: string;
  caret?: number;
  onChange: (value: string, caret: number) => void;
  onSubmit: (value: string) => void;
  onKey?: (input: string, key: Key) => boolean;
  onCaretRow?: (fromBottom: number) => void;
  onCopy?: (text: string) => void;
  mask?: boolean;
}) {
  // cursor counts code points, so emoji move as one step
  const chars = [...value];
  // what's drawn (and so laid out): one `*` per character when masked
  const shown = (c: string[]) => (mask ? c.map((ch) => (ch === "\n" ? ch : "*")) : c);
  // kept with the value it was placed in: a value the parent put there instead (the clear on submit, a menu fill)
  // puts the caret at its end
  const [cursor, setCursor] = useState({ value, pos: chars.length });
  const placed = wanted === undefined ? undefined : Math.max(0, Math.min(wanted, chars.length));
  const pos =
    cursor.value === value && (placed === undefined || placed === cursor.pos) ? cursor.pos : (placed ?? chars.length);

  // wrap ourselves (instead of letting Ink) so we know which row/column the caret lands on
  const ref = useRef<DOMElement>(null);
  const width = useBoxMetrics(ref).width || Number.MAX_SAFE_INTEGER;
  const { rows, caret } = layout(shown(chars), pos, width);

  // keys can arrive faster than renders (e.g. held Backspace while a reply streams), so each one
  // builds on the previous key's result, not on this render's possibly stale props
  const latest = useRef({ chars, pos });
  latest.current = { chars, pos };
  const update = (next: string[], at: number) => {
    const text = next.join("");
    latest.current = { chars: next, pos: at };
    onChange(text, at);
    setCursor({ value: text, pos: at });
    const { rows, caret } = layout(shown(next), at, width);
    onCaretRow?.(rows.length - 1 - caret.row);
  };

  useInput((input, key) => {
    if (onKey?.(input, key)) return;
    const { chars, pos } = latest.current;
    const insert = (text: string) =>
      update([...chars.slice(0, pos), ...text, ...chars.slice(pos)], pos + [...text].length);
    if (key.return) {
      if (key.shift || key.meta) insert("\n");
      else onSubmit(chars.join(""));
    } else if (key.upArrow || key.downArrow) {
      const at = moveRow(shown(chars), pos, width, key.upArrow ? -1 : 1);
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

  // a drag's [anchor, head] code points, kept with the value it was made on: an edit drops it
  const [sel, setSel] = useState<{ value: string; a: number; b: number; dragged: boolean }>();
  const [from, to] = sel?.value === value && sel.dragged ? span(sel, chars.length) : [0, 0];

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

  // Ink drops mouse reports before useInput, so read the raw chunks (as the transcript does)
  const mouse = useRef({ box, width, sel, update, onCopy });
  mouse.current = { box, width, sel, update, onCopy };
  const { stdin } = useStdin();
  const selectable = !!onCopy && !mask;
  useEffect(() => {
    if (!selectable) return;
    const onData = (chunk: Buffer | string) => {
      for (const [, b, x, y, kind] of String(chunk).matchAll(MOUSE)) {
        const { box, width, sel, update, onCopy } = mouse.current;
        if (!box) continue;
        const { chars, pos } = latest.current;
        const button = Number(b) & ~(4 | 8 | 16); // drop shift/alt/ctrl bits
        const sy = Number(y) - 1;
        const at = () =>
          posAt(chars, pos, width, Math.max(box.top, Math.min(box.bottom - 1, sy)) - box.y, Number(x) - 1 - box.x);
        const value = chars.join("");
        // reports can come several to a chunk, faster than renders
        const select = (next: typeof sel) => {
          mouse.current.sel = next;
          setSel(next);
        };
        if (button === 0 && kind === "M") {
          const inside = sy >= box.top && sy < box.bottom && Number(x) - 1 >= box.x && Number(x) - 1 < box.x + width;
          select(inside ? { value, a: at(), b: at(), dragged: false } : undefined);
        } else if (button === 32 && kind === "M" && sel) select({ ...sel, b: at(), dragged: true });
        else if (kind === "m" && sel) {
          if (sel.dragged && sel.value === value) onCopy?.(chars.slice(...span(sel, chars.length)).join(""));
          else {
            select(undefined);
            if (sel.value === value) update(chars, sel.a);
          }
        }
      }
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [stdin, selectable]);

  const hl = theme.selectedBg ? { backgroundColor: theme.selectedBg } : { inverse: true };
  return (
    <Box ref={ref} flexDirection="column" width="100%">
      {rows.map(({ text, start }, i) => {
        const cs = [...text];
        const s = Math.max(0, Math.min(cs.length, from - start));
        const e = Math.max(0, Math.min(cs.length, to - start));
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
        if (s >= e) return <Text key={i}>{text || " "}</Text>;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
          <Text key={i}>
            {cs.slice(0, s).join("")}
            <Text {...hl}>{cs.slice(s, e).join("")}</Text>
            {cs.slice(e).join("")}
          </Text>
        );
      })}
    </Box>
  );
}
