import { Box, Text } from "ink";
import { useShallow } from "zustand/react/shallow";
import { useSession, useUi } from "./api.ts";
import { theme, usageLine } from "./entry.ts";

/** Built-in status bar: token usage (or the last copy) on the left, provider and model on the right. */
export function StatusBar() {
  const messages = useSession((s) => s.messages);
  const { turn, status, copied } = useUi(useShallow(({ turn, status, copied }) => ({ turn, status, copied })));
  return (
    <Box justifyContent="space-between">
      <Text color={theme.dim} wrap="truncate">
        {copied === undefined ? usageLine([...messages, ...turn], status?.window) : `Copied ${copied} chars`}
      </Text>
      <Text color={theme.dim} wrap="truncate">
        {status && `(${status.name}) ${status.model}`}
      </Text>
    </Box>
  );
}
