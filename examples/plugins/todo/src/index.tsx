import { type CliPlugin, theme, useSession, useTheme } from "@hortus/cli";
import { type PluginEntry, type SessionState, tool } from "@hortus/core";
import { Box, Text } from "ink";
import type { ComponentType } from "react";
import { z } from "zod";

const Item = z.object({ text: z.string(), done: z.boolean() });
export type Item = z.infer<typeof Item>;

/** The session branch's list, as its last `todo:list` entry left it. */
export const items = (state: SessionState) => (state.data.todo as Item[] | undefined) ?? [];

const show = (list: Item[]) => list.map((i) => `[${i.done ? "x" : " "}] ${i.text}`).join("\n") || "(empty)";

/**
 * A todo list kept in the session: each `todo` call saves the whole list as a `todo:list` entry, and replaying the
 * session (resuming, or branching from an earlier entry) rebuilds it in `state.data.todo`. In the TUI, the list shows
 * above the input (the `aboveInput` slot) while it has items.
 */
export default {
  tools: [
    tool({
      name: "todo",
      description: "Replace the todo list of this session with `items` (all of them, in order); returns the list.",
      prompt: "For work of several steps, keep a todo list with the todo tool and tick items off as you finish them.",
      inputSchema: z.object({ items: z.array(Item) }),
      execute: async ({ items: list }, ctx) => {
        if (!ctx.session) throw new Error("No session to keep the list in");
        await ctx.session.appendEntry("todo:list", list);
        return show(list);
      },
    }),
  ],
  entries: {
    list: (entry: PluginEntry<Item[]>, state) => {
      state.data.todo = entry.data;
    },
  },
  cli: { aboveInput: TodoPanel },
} satisfies CliPlugin;

/** The shown session's list above the input (and whatever an earlier plugin put there, below it). */
function TodoPanel({ Default }: { Default: ComponentType }) {
  // the entry's own array: a stable reference until the next `todo` call replaces it
  const list = useSession((s) => s.data.todo as Item[] | undefined);
  useTheme();
  return (
    <Box flexDirection="column" flexShrink={0}>
      {list?.length ? (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          {list.map((i, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items are positional
            <Text key={n} color={i.done ? theme.dim : theme.text} strikethrough={i.done}>
              {`${i.done ? "✔" : "○"} ${i.text}`}
            </Text>
          ))}
        </Box>
      ) : null}
      <Default />
    </Box>
  );
}
