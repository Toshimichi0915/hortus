import type { Answer, AskEvent, AskOption } from "@hortus/core";
import { Box, type Key, Text, useInput } from "ink";
import { useState } from "react";
import { CommandMenu } from "./command-menu.tsx";
import { PromptInput } from "./prompt-input.tsx";
import { useTheme } from "./api.ts";

/**
 * The generic `ask` dialog, in the prompt slot: the question, its options as a list (the `/` menu's rows: ↑/↓ select,
 * Enter picks; with `multi`, Tab, or Space while nothing is typed, ticks and Enter answers the ticked ones), and a
 * text line when `allowText` or there are no options (masked when `secret`; typed text is the answer). Without a text
 * line, typing filters the options (by label and description). Esc dismisses it (undefined), without aborting the run. Its first key engages the ask.
 */
export function AskDialog({ ask }: { ask: AskEvent }) {
  // its CommandMenu child re-renders with it
  const theme = useTheme();
  const options = ask.options ?? [];
  const typing = ask.allowText || ask.secret || !options.length;
  const [at, setAt] = useState(0);
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const [text, setText] = useState("");
  const [filter, setFilter] = useState("");
  const q = filter.toLowerCase();
  // indexes into `options` of the rows shown
  const shown = options.flatMap((o, i) =>
    !q || o.label.toLowerCase().includes(q) || o.description?.toLowerCase().includes(q) ? [i] : [],
  );
  const current = Math.min(at, shown.length - 1);
  const answer = (a: Answer | undefined) => ask.resolve(a);
  const pick = (typed = text) => {
    if (typing && typed) return answer(ask.multi ? [...picked(), typed] : typed);
    const i = shown[current];
    if (i === undefined) return;
    answer(ask.multi ? picked() : (options[i]?.label ?? ""));
  };
  const picked = () => options.filter((_, i) => ticked.has(i)).map((o) => o.label);
  const onKey = (input: string, key: Key) => {
    // someone is answering: racing handlers (an autopilot's countdown) back off
    ask.engage();
    if (key.escape) answer(undefined);
    else if (key.upArrow || key.downArrow)
      setAt(Math.max(0, Math.min(shown.length - 1, current + (key.upArrow ? -1 : 1))));
    // Space ticks only while nothing is typed, so filters and text can hold spaces; Tab ticks always
    else if (ask.multi && (key.tab || (input === " " && !text && !filter))) {
      const i = shown[current];
      if (i !== undefined)
        setTicked((t) => {
          const next = new Set(t);
          if (!next.delete(i)) next.add(i);
          return next;
        });
    } else if (key.return) pick();
    else if (typing) return false;
    else if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) {
      setFilter((f) => f + input);
      setAt(0);
    } else return false;
    return true;
  };
  // without a text line, the dialog reads the keys itself
  useInput((input, key) => void onKey(input, key), { isActive: !typing });
  const rows = shown.map((i) => {
    const o = options[i] as AskOption;
    return {
      label: ask.multi ? `${ticked.has(i) ? "[x]" : "[ ]"} ${o.label}` : o.label,
      value: o.label,
      ...(o.description && { description: o.description }),
    };
  });
  return (
    <Box flexShrink={0} flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent}>{ask.question}</Text>
      {filter && <Text color={theme.dim}>{`filter: ${filter}${shown.length ? "" : " (no match)"}`}</Text>}
      {rows.length > 0 && <CommandMenu rows={rows} at={current} />}
      {typing && (
        <Box>
          <Text color={theme.accent}>{"> "}</Text>
          <Box flexGrow={1}>
            <PromptInput
              value={text}
              onChange={setText}
              onSubmit={pick}
              onKey={(input, key) => (key.return && !key.shift && !key.meta ? false : onKey(input, key))}
              mask={ask.secret}
            />
          </Box>
        </Box>
      )}
      <Text color={theme.dim}>
        {[
          options.length && "↑↓ select",
          !typing && options.length > 1 && "type to filter",
          ask.multi && "space tick",
          "enter answer",
          "esc dismiss",
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
    </Box>
  );
}
