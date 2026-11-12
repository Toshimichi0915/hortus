import type { CliPlugin } from "@hortus/cli";
import type { Tool } from "@hortus/core";
import { Box, Text } from "ink";

/** What the wrapped `read` reports as its result's `details`. */
export interface ReadDetails {
  lines: number;
}

/** Wraps the `read` tool to report how many lines it read, and its block to show that under the built-in one. */
export default {
  tools: [
    {
      name: "read",
      wrap: (Default): Tool => ({
        ...Default,
        execute: async (input, ctx) => {
          const output = await Default.execute(input, ctx);
          if (typeof output === "string") ctx.update({ lines: output.split("\n").length } satisfies ReadDetails);
          return output;
        },
      }),
    },
  ],
  cli: {
    tools: {
      read: {
        Render: ({ Default, ...view }) => (
          <Box flexDirection="column">
            <Default {...view} />
            {view.details ? <Text dimColor>{(view.details as ReadDetails).lines} lines read</Text> : null}
          </Box>
        ),
      },
    },
  },
} satisfies CliPlugin;
