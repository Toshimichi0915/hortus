import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { type Image, type Plugin, tool } from "./llm.ts";
import { anthropicProvider } from "./providers/anthropic.ts";
import { openaiProvider } from "./providers/openai.ts";
import { openrouterProvider } from "./providers/openrouter.ts";

const sh = promisify(exec);

const imageTypes: Record<string, Image["mediaType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

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
  tools: [
    tool({
      name: "read",
      description: "Read a file and return its contents. Images (png, jpg, gif, webp) are returned as images.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const mediaType = imageTypes[extname(path).toLowerCase()];
        if (!mediaType) return readFile(path, "utf8");
        return { type: "image", mediaType, data: await readFile(path, "base64") } satisfies Image;
      },
    }),
    tool({
      name: "write",
      description: "Write content to a file, overwriting it.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        await writeFile(path, content);
        return `Wrote ${content.length} chars to ${path}`;
      },
    }),
    tool({
      name: "bash",
      description: "Run a bash command and return stdout/stderr.",
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }) => {
        try {
          const { stdout, stderr } = await sh(command, { shell: "/bin/bash", timeout: 120_000 });
          return { stdout, stderr };
        } catch (e) {
          const err = e as { code?: number; stdout?: string; stderr?: string; message: string };
          return { exitCode: err.code, stdout: err.stdout, stderr: err.stderr ?? err.message };
        }
      },
    }),
  ],
};
