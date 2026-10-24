import type { Plugin } from "./llm.ts";
import { anthropicProvider } from "./providers/anthropic.ts";
import { openaiProvider } from "./providers/openai.ts";
import { bashTool, editTool, readTool, writeTool } from "./tools.ts";

/** Providers, tools and the base system prompt that ship with phi; loaded before any configured plugin. */
export const builtin: Plugin = {
  on: {
    session_start: ({ system }) => {
      system.push(
        `You are a coding agent. Working directory: ${process.cwd()}. Use tools to inspect and change files.`,
      );
    },
  },
  providers: {
    openai: {
      create: ({ apiKey, endpoint }) => openaiProvider({ apiKey, baseURL: endpoint }),
    },
    anthropic: {
      create: ({ apiKey, endpoint }) => anthropicProvider({ apiKey, baseURL: endpoint }),
    },
  },
  tools: [readTool, editTool, writeTool, bashTool],
};
