import { loadConfig } from "./config.ts";
import type { Image, Message, Plugin, Tool, ToolCall, ToolResult } from "./llm.ts";
import { loadPlugins } from "./plugins.ts";
import { loadSecrets } from "./secrets.ts";

/** Models of every provider in secrets.json whose type is a known plugin provider. */
export async function listModels() {
  const [{ providers }, secrets] = await Promise.all([loadPlugins(), loadSecrets()]);
  const lists = await Promise.all(
    Object.entries(secrets).map(async ([name, secret]) => {
      const def = secret && providers[secret.type];
      if (!secret || !def) return [];
      return (await def.create(secret).listModels()).map((id) => ({ provider: name, id }));
    }),
  );
  return lists.flat();
}

const maxSteps = 50;

async function runTool(tools: Tool[], call: ToolCall): Promise<ToolResult> {
  const t = tools.find((t) => t.name === call.name);
  if (!t) return { id: call.id, output: `Unknown tool: ${call.name}`, isError: true };
  const input = t.inputSchema.safeParse(call.input);
  if (!input.success) return { id: call.id, output: `Invalid input: ${input.error.message}`, isError: true };
  try {
    const output = await t.execute(input.data as never);
    if ((output as Image | undefined)?.type === "image") return { id: call.id, output: "", image: output as Image };
    return { id: call.id, output: typeof output === "string" ? output : JSON.stringify(output) };
  } catch (e) {
    return { id: call.id, output: e instanceof Error ? e.message : String(e), isError: true };
  }
}

export interface RunOptions {
  model?: string;
  provider?: string;
  /** stops the run: the current stream rejects, running tools finish and their results are kept */
  signal?: AbortSignal;
}

/**
 * Loads config and plugins once (built-ins, ~/.phi/plugins, then `plugin`). `run` reports progress as events
 * (`text`, `tool_call`, `message`) to every plugin, so `plugin` is how a caller observes a run.
 */
export async function createAgent(plugin?: Plugin) {
  const config = await loadConfig();
  const { providers, tools, emit } = await loadPlugins(undefined, plugin ? [plugin] : []);

  /** Runs the tool loop on top of `history` until the model stops calling tools. `model`/`provider` override the config. */
  async function run(history: Message[], opts: RunOptions = {}): Promise<void> {
    const name = opts.provider ?? config.provider;
    if (!name) throw new Error("No provider selected. Run: phi config set-provider <provider>");
    // read per run so a key set mid-session applies; explicit so the SDKs never fall back to their env vars
    const secret = (await loadSecrets())[name];
    if (!secret) throw new Error(`No API key for ${name}. Run: phi config set-key ${name}`);
    const def = providers[secret.type];
    if (!def) throw new Error(`Unknown provider type: ${secret.type} (${Object.keys(providers).join(", ")})`);
    const provider = def.create(secret);
    // config.model belongs to config.provider, so it doesn't carry over to another provider
    const model = opts.model ?? (name === config.provider ? config.model : undefined) ?? def.defaultModel;

    const start = { system: [] as string[] };
    await emit("session_start", start);
    const system = start.system.join("\n\n");
    const messages = [...history];
    for (let step = 0; step < maxSteps; step++) {
      if (opts.signal?.aborted) return;
      const assistant = await provider.complete(
        { model, system, messages, tools, signal: opts.signal },
        (text) => void emit("text", text),
        (text) => void emit("thinking", text),
      );
      messages.push(assistant);
      await emit("message", assistant);
      if (!assistant.toolCalls.length) return;

      for (const call of assistant.toolCalls) await emit("tool_call", call);
      const results: Message = {
        role: "tool",
        results: await Promise.all(assistant.toolCalls.map((c) => runTool(tools, c))),
      };
      messages.push(results);
      await emit("message", results);
    }
  }

  return { providers, run };
}

export type Agent = Awaited<ReturnType<typeof createAgent>>;
