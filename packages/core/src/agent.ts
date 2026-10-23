import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { loadConfig, PROVIDERS, type ProviderName } from "./config.ts";
import { type Message, type Provider, type ToolCall, type ToolResult, tool } from "./llm.ts";
import { anthropicProvider } from "./providers/anthropic.ts";
import { openaiProvider } from "./providers/openai.ts";
import { openrouterProvider } from "./providers/openrouter.ts";
import { loadSecrets } from "./secrets.ts";

const sh = promisify(exec);

const providers: Record<ProviderName, (apiKey: string) => { provider: Provider; defaultModel: string }> = {
  openrouter: (apiKey) => ({ provider: openrouterProvider({ apiKey }), defaultModel: "anthropic/claude-sonnet-5.5" }),
  openai: (apiKey) => ({ provider: openaiProvider({ apiKey }), defaultModel: "gpt-5" }),
  anthropic: (apiKey) => ({ provider: anthropicProvider({ apiKey }), defaultModel: "claude-opus-5-5" }),
};

// resolved per run (not at import) so `kanai config` works before a key is set, and config edits apply without restart
async function resolveProvider(model?: string, providerOverride?: ProviderName) {
  const config = await loadConfig();
  const name = providerOverride ?? config.provider;
  if (!name) throw new Error("No provider selected. Run: kanai config set-provider <provider>");
  // explicit key so the SDKs never fall back to their env vars
  const apiKey = (await loadSecrets())[name]?.apiKey;
  if (!apiKey) throw new Error(`No API key for ${name}. Run: kanai config set-key ${name}`);
  const { provider, defaultModel } = providers[name](apiKey);
  // config.model belongs to config.provider, so it doesn't carry over to another provider
  return { provider, model: model ?? (name === config.provider ? config.model : undefined) ?? defaultModel };
}

/** Models of every provider that has an API key set. */
export async function listModels() {
  const secrets = await loadSecrets();
  const lists = await Promise.all(
    PROVIDERS.map(async (name) => {
      const apiKey = secrets[name]?.apiKey;
      if (!apiKey) return [];
      return (await providers[name](apiKey).provider.listModels()).map((id) => ({ provider: name, id }));
    }),
  );
  return lists.flat();
}

const system = `You are a coding agent. Working directory: ${process.cwd()}. Use tools to inspect and change files.`;
const maxSteps = 50;

const tools = [
  tool({
    name: "read",
    description: "Read a file and return its contents.",
    inputSchema: z.object({ path: z.string() }),
    execute: ({ path }) => readFile(path, "utf8"),
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
];

async function runTool(call: ToolCall): Promise<ToolResult> {
  const t = tools.find((t) => t.name === call.name);
  if (!t) return { id: call.id, output: `Unknown tool: ${call.name}`, isError: true };
  const input = t.inputSchema.safeParse(call.input);
  if (!input.success) return { id: call.id, output: `Invalid input: ${input.error.message}`, isError: true };
  try {
    const output = await t.execute(input.data as never);
    return { id: call.id, output: typeof output === "string" ? output : JSON.stringify(output) };
  } catch (e) {
    return { id: call.id, output: e instanceof Error ? e.message : String(e), isError: true };
  }
}

export type AgentEvent =
  | { type: "tool-call"; call: ToolCall }
  /** a new message to append to the history */
  | { type: "message"; message: Message };

/** Runs the tool loop on top of `history` until the model stops calling tools. `model` overrides the config. */
export async function* runAgent(
  history: Message[],
  onText: (text: string) => void,
  modelOverride?: string,
  providerOverride?: ProviderName,
): AsyncGenerator<AgentEvent> {
  const { provider, model } = await resolveProvider(modelOverride, providerOverride);
  const messages = [...history];
  for (let step = 0; step < maxSteps; step++) {
    const assistant = await provider.complete({ model, system, messages, tools }, onText);
    messages.push(assistant);
    yield { type: "message", message: assistant };
    if (!assistant.toolCalls.length) return;

    for (const call of assistant.toolCalls) yield { type: "tool-call", call };
    const results: Message = { role: "tool", results: await Promise.all(assistant.toolCalls.map(runTool)) };
    messages.push(results);
    yield { type: "message", message: results };
  }
}
