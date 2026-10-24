import { loadConfig } from "./config.ts";
import type { Message, Tool, ToolCall, ToolResult } from "./llm.ts";
import { loadPlugins } from "./plugins.ts";
import { loadSecrets } from "./secrets.ts";

// resolved per run (not at import) so `phi config` works before a key is set, and config edits apply without restart
async function resolveProvider(model?: string, providerOverride?: string) {
  const config = await loadConfig();
  const { providers, tools } = await loadPlugins(config.plugins ?? []);
  const name = providerOverride ?? config.provider;
  if (!name) throw new Error("No provider selected. Run: phi config set-provider <provider>");
  const def = providers[name];
  if (!def) throw new Error(`Unknown provider: ${name} (${Object.keys(providers).join(", ")})`);
  // explicit key so the SDKs never fall back to their env vars
  const apiKey = (await loadSecrets())[name]?.apiKey;
  if (!apiKey) throw new Error(`No API key for ${name}. Run: phi config set-key ${name}`);
  // config.model belongs to config.provider, so it doesn't carry over to another provider
  const resolved = model ?? (name === config.provider ? config.model : undefined) ?? def.defaultModel;
  return { provider: def.create(apiKey), model: resolved, tools };
}

/** Models of every provider that has an API key set. */
export async function listModels() {
  const [{ providers }, secrets] = await Promise.all([loadPlugins(), loadSecrets()]);
  const lists = await Promise.all(
    Object.entries(providers).map(async ([name, def]) => {
      const apiKey = secrets[name]?.apiKey;
      if (!apiKey) return [];
      return (await def.create(apiKey).listModels()).map((id) => ({ provider: name, id }));
    }),
  );
  return lists.flat();
}

const system = `You are a coding agent. Working directory: ${process.cwd()}. Use tools to inspect and change files.`;
const maxSteps = 50;

async function runTool(tools: Tool[], call: ToolCall): Promise<ToolResult> {
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
  providerOverride?: string,
): AsyncGenerator<AgentEvent> {
  const { provider, model, tools } = await resolveProvider(modelOverride, providerOverride);
  const messages = [...history];
  for (let step = 0; step < maxSteps; step++) {
    const assistant = await provider.complete({ model, system, messages, tools }, onText);
    messages.push(assistant);
    yield { type: "message", message: assistant };
    if (!assistant.toolCalls.length) return;

    for (const call of assistant.toolCalls) yield { type: "tool-call", call };
    const results: Message = {
      role: "tool",
      results: await Promise.all(assistant.toolCalls.map((c) => runTool(tools, c))),
    };
    messages.push(results);
    yield { type: "message", message: results };
  }
}
