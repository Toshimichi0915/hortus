import type { SessionInfo } from "@hortus/core";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useState } from "react";
import { stamp, theme } from "./entry.ts";

/** Sessions whose first user message contains every word of `query`, ignoring case. */
export function filterSessions(sessions: SessionInfo[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return sessions.filter((s) => words.every((w) => s.title.toLowerCase().includes(w)));
}

/** Pick a session to resume: type to filter by first message, ↑/↓ to move, Enter to pick, Esc to quit. */
export function SessionPicker({
  sessions,
  onPick,
}: {
  sessions: SessionInfo[];
  onPick: (s: SessionInfo | undefined) => void;
}) {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const shown = filterSessions(sessions, query);
  const at = Math.min(sel, Math.max(0, shown.length - 1));
  const done = (s: SessionInfo | undefined) => {
    onPick(s);
    exit();
  };
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) done(undefined);
    else if (key.return) shown[at] && done(shown[at]);
    else if (key.upArrow) setSel(Math.max(0, at - 1));
    else if (key.downArrow) setSel(Math.min(shown.length - 1, at + 1));
    // most terminals send DEL for Backspace, which Ink reports as `delete`
    else if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
      setSel(0);
    }
  });
  // keep the selection in view: a window of `height` rows around it
  const height = Math.max(1, rows - 3);
  const start = Math.max(0, Math.min(at - Math.floor(height / 2), shown.length - height));
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.accent}>Resume session › </Text>
        {query}
        <Text inverse> </Text>
      </Text>
      {shown.length === 0 && <Text color={theme.dim}>No matching sessions</Text>}
      {shown.slice(start, start + height).map((s, i) => {
        const color = start + i === at ? theme.accent : undefined;
        return (
          <Text key={s.id} wrap="truncate-end" color={color}>
            <Text color={color ?? theme.dim}>{stamp(s.created)}  </Text>
            {s.title.replace(/\s+/g, " ") || "(no messages)"}
          </Text>
        );
      })}
    </Box>
  );
}
