import type { Plugin } from "./llm.ts";
import { anthropicProvider } from "./providers/anthropic.ts";
import { openaiProvider } from "./providers/openai.ts";
import { openrouterProvider } from "./providers/openrouter.ts";
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
    openrouter: { create: (apiKey) => openrouterProvider({ apiKey }), defaultModel: "anthropic/claude-sonnet-5.5" },
    openai: { create: (apiKey) => openaiProvider({ apiKey }), defaultModel: "gpt-5" },
    anthropic: { create: (apiKey) => anthropicProvider({ apiKey }), defaultModel: "claude-opus-5-5" },
  },
  tools: [readTool, editTool, writeTool, bashTool],
};
