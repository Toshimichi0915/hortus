import { agentsMdPrompt, loadAgentsMd, type Piece, version } from "../index.ts";

/**
 * The base system prompt and AGENTS.md: the files are re-read every run (so edits apply from the next turn) into
 * `run_start.context`, where later plugins may change them, and rendered in `prompt`.
 */
export default {
  name: "builtin:prompt",
  version,
  plugin: {
    on: {
      run_start: async ({ context }, ctx) => {
        context.push(...(await loadAgentsMd(ctx.cwd)));
      },
      prompt: ({ system, context }, ctx) => {
        system.push(
          `You are a coding agent. Working directory: ${ctx.cwd}. Use tools to inspect and change files.`,
          agentsMdPrompt(context),
        );
      },
    },
  },
} satisfies Piece;
