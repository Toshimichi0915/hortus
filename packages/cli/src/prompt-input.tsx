import { Text, useInput } from "ink";
import { useState } from "react";

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

  // a newline under the cursor still needs a visible cell, so draw a space before it
  const at = chars[pos];
  const onBreak = at === undefined || at === "\n";
  return (
    <Text>
      {chars.slice(0, pos).join("")}
      <Text inverse>{onBreak ? " " : at}</Text>
      {chars.slice(onBreak ? pos : pos + 1).join("")}
    </Text>
  );
}
