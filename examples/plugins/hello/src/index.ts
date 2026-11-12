import { type Plugin, tool } from "@hortus/core";
import { z } from "zod";

/** The smallest reference plugin: a tool and its line of system prompt (sent whenever the tool is declared). */
export default {
  tools: [
    tool({
      name: "hello",
      description: "Greets someone.",
      prompt: "Greet people with the hello tool.",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => `Hello, ${name}!`,
    }),
  ],
} satisfies Plugin;
