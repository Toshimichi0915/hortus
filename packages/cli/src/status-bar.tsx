import { Box, Text } from "ink";
import { useShallow } from "zustand/react/shallow";
import { useSession, useUi } from "./api.ts";
import { runEffort } from "./cli.ts";
import { usageLine } from "./entry.ts";
import { theme } from "./themes.ts";

/**
 * Built-in status bar: token usage (or the last copy) and plugins' statuses (`ctx.status`, each in its `color` token)
 * on the left, provider, model
 * and effort on the right.
 */
export function StatusBar() {
  const messages = useSession((s) => s.messages);
  const extra = useSession((s) => s.usage);
  const { status, copied, statuses } = useUi(
    useShallow(({ status, copied, statuses }) => ({ status, copied, statuses })),
  );
  // the one runs use, so an effort the model doesn't take isn't shown
  const effort = useUi(runEffort);
  useUi((s) => s.theme);
  const left = copied === undefined ? usageLine(messages, status?.window, extra) : `Copied ${copied} chars`;
  return (
    <Box justifyContent="space-between">
      <Text color={theme.dim} wrap="truncate">
        {left}
        {Object.entries(statuses).map(([key, { text, color }]) => (
          <Text key={key}>
            {" · "}
            <Text color={(color && theme[color]) || theme.dim}>{text}</Text>
          </Text>
        ))}
      </Text>
      <Text color={theme.dim} wrap="truncate">
        {status && `(${status.name}) ${status.model}${effort ? ` · ${effort}` : ""}`}
      </Text>
    </Box>
  );
}
