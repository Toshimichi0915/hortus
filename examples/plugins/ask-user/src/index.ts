import { type Plugin, tool } from "@hortus/core";
import { z } from "zod";

/**
 * pi-ask-user: an `ask_user` tool whose `execute` awaits `ctx.ask`, so whoever answers asks (the TUI's dialog in the
 * prompt slot, a remote approver, an autopilot) gives the model its answer; with no one to answer it says so.
 */
export default {
  tools: [
    tool({
      name: "ask_user",
      description:
        "Ask the user a question and wait for the answer: pick one of `options` (several with `multi`), or type free text (`allowText`, or when there are no options). Use it when a decision is the user's to make; don't use it for things you can find out yourself.",
      inputSchema: z.object({
        question: z.string().describe("The question, self-contained"),
        options: z
          .array(z.object({ label: z.string(), description: z.string().optional() }))
          .optional()
          .describe("Choices to pick from"),
        multi: z.boolean().optional().describe("Several options may be picked"),
        allowText: z.boolean().optional().describe("Free text may be typed instead"),
      }),
      execute: async (input, ctx) => {
        const answer = await ctx.ask(input);
        if (answer === undefined)
          return "The user didn't answer (no one could be asked, or they dismissed it). Decide yourself if you safely can, or stop and say what you need.";
        return Array.isArray(answer) ? `The user picked: ${answer.join(", ")}` : `The user answered: ${answer}`;
      },
    }),
  ],
} satisfies Plugin;
