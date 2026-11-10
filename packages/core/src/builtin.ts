import { contextPrompt, discoverSkills, loadAgentsMd } from "./context.ts";
import type { Plugin } from "./llm.ts";
import { anthropicProvider } from "./providers/anthropic.ts";
import { openaiProvider, openaiResponsesProvider } from "./providers/openai.ts";
import { bashTool, editTool, readTool, writeTool } from "./tools.ts";

/** Providers, tools and the base system prompt that ship with hortus; loaded before any configured plugin. */
export const builtin: Plugin = {
  on: {
    // read on every run, so edits to AGENTS.md and skills apply from the next turn
    skills: async (p) => {
      p.skills.push(...(await discoverSkills()));
    },
    session_start: async ({ system, skills }) => {
      system.push(
        [
          `You are a coding agent. Working directory: ${process.cwd()}. Use tools to inspect and change files.`,
          ...contextPrompt(await loadAgentsMd(), skills),
        ].join("\n\n"),
      );
    },
  },
  providers: {
    openai: {
      create: ({ apiKey, endpoint }) => openaiProvider({ apiKey, baseURL: endpoint }),
    },
    "openai-responses": {
      create: ({ apiKey, endpoint }) => openaiResponsesProvider({ apiKey, baseURL: endpoint }),
    },
    anthropic: {
      create: ({ apiKey, endpoint }) => anthropicProvider({ apiKey, baseURL: endpoint }),
    },
  },
  tools: [readTool, editTool, writeTool, bashTool],
};
