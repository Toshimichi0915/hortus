import { codemodeTool } from "./codemode.ts";
import { loadConfig } from "./config.ts";
import type { Effort, Image, Message, Tool, ToolCall, ToolResult } from "./llm.ts";
import { connectMcp, loadMcpConfig } from "./mcp.ts";
import { type LoadOptions, loadPlugins } from "./plugins.ts";
import { loadSecrets } from "./secrets.ts";
import { saveImage } from "./tools.ts";

/** Runs `call` with one of `tools`; a call to a tool in `codemodeOnly` is told how to reach it instead. */
export async function runTool(tools: Tool[], call: ToolCall, codemodeOnly: Tool[] = []): Promise<ToolResult> {
  const t = tools.find((t) => t.name === call.name);
  if (!t) {
    const hint = codemodeOnly.some((t) => t.name === call.name)
      ? ` (it is only reachable from codemode: call \`await tools.${call.name.replace(/\W/g, "_")}(input)\` in a codemode script)`
      : "";
    return { id: call.id, output: `Unknown tool: ${call.name}${hint}`, isError: true };
  }
  const input = t.inputSchema.safeParse(call.input);
  if (!input.success) return { id: call.id, output: `Invalid input: ${input.error.message}`, isError: true };
  try {
    const output = await t.execute(input.data as never);
    if ((output as Image | undefined)?.type === "image") {
      const { text = "", ...image } = output as Image;
      if (image.path) return { id: call.id, output: text, image };
      // named in the output, so the model can refer to the file later
      const path = saveImage(image);
      return { id: call.id, output: `${text ? `${text}\n` : ""}[Image saved to ${path}]`, image: { ...image, path } };
    }
    return { id: call.id, output: typeof output === "string" ? output : JSON.stringify(output) };
  } catch (e) {
    return { id: call.id, output: e instanceof Error ? e.message : String(e), isError: true };
  }
}

export interface RunOptions {
  model?: string;
  provider?: string;
  /** passed as is, not defaulted from config: unset means the provider's default */
  effort?: Effort;
  /** stops the run: the current stream rejects, running tools finish and their results are kept */
  signal?: AbortSignal;
}

/**
 * Loads config and plugins once (built-ins, ~/.hortus/plugins, then `opts.extra`). `run` reports progress as events
 * (`text`, `tool_call`, `message`) to every plugin, so a plugin in `extra` is how a caller observes a run.
 */
export async function createAgent(opts?: LoadOptions) {
  const config = await loadConfig();
  const { providers, tools: pluginTools, emit, plugins } = await loadPlugins(undefined, opts);
  // connects in the background, so a slow server doesn't hold up startup; the first run waits for it. An invalid
  // mcp.json is reported like a failed server, so the rest still works.
  const mcp = loadMcpConfig().then(connectMcp, (e: Error) => ({
    tools: [],
    errors: [e.message],
    close: async () => {},
  }));
  // codemode reaches every tool; MCP tools are then only listed in its description, not declared one by one. Without
  // MCP tools it adds nothing, so it is left out.
  const tools = mcp.then(({ tools: mcpTools }) =>
    mcpTools.length > 0 && config.codemode !== false
      ? { declared: [...pluginTools, codemodeTool([...pluginTools, ...mcpTools])], codemodeOnly: mcpTools }
      : { declared: [...pluginTools, ...mcpTools], codemodeOnly: [] },
  );

  /** Provider name, model and provider instance a run with `opts` would use; throws if any is missing. */
  async function resolve(opts: Pick<RunOptions, "model" | "provider"> = {}) {
    const name = opts.provider ?? config.provider;
    if (!name) throw new Error("No provider selected. Set 'provider' in ~/.hortus/config.json or use /model");
    // read per run so a key set mid-session applies; explicit so the SDKs never fall back to their env vars
    const secret = (await loadSecrets())[name];
    if (!secret) throw new Error(`No API key for ${name}. Add it to ~/.hortus/secrets.json`);
    const def = providers[secret.type];
    if (!def) throw new Error(`Unknown provider type: ${secret.type} (${Object.keys(providers).join(", ")})`);
    const provider = def.create(secret);
    // config.model belongs to config.provider, so it doesn't carry over to another provider
    const model = opts.model ?? (name === config.provider ? config.model : undefined);
    if (!model) throw new Error("No model selected. Set 'model' in ~/.hortus/config.json or use /model");
    return { name, model, provider };
  }

  /** Models of every provider in secrets.json whose type is a known plugin provider. */
  async function listModels() {
    const lists = await Promise.allSettled(
      Object.entries(await loadSecrets()).map(async ([name, secret]) => {
        const def = secret && providers[secret.type];
        if (!secret || !def) return [];
        return (await def.create(secret).listModels()).map((id) => ({ provider: name, id }));
      }),
    );
    // a provider whose listing fails is skipped, so one bad key doesn't hide the others' models
    return lists.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  /** Runs the tool loop on top of `history` until the model stops calling tools. `model`/`provider` override the config. */
  async function run(history: Message[], opts: RunOptions = {}): Promise<void> {
    const { model, provider } = await resolve(opts);
    const { declared: runTools, codemodeOnly } = await tools;
    const start = { system: [] as string[] };
    await emit("session_start", start);
    const system = start.system.join("\n\n");
    const messages = [...history];
    for (;;) {
      if (opts.signal?.aborted) return;
      const assistant = await provider.complete(
        { model, system, messages, tools: runTools, effort: opts.effort, signal: opts.signal },
        (text) => void emit("text", text),
        (text) => void emit("thinking", text),
      );
      messages.push(assistant);
      await emit("message", assistant);
      if (!assistant.toolCalls.length) return;

      for (const call of assistant.toolCalls) await emit("tool_call", call);
      const results: Message = {
        role: "tool",
        results: await Promise.all(assistant.toolCalls.map((c) => runTool(runTools, c, codemodeOnly))),
      };
      messages.push(results);
      await emit("message", results);
    }
  }

  return {
    providers,
    plugins,
    resolve,
    listModels,
    run,
    /** MCP connection errors, one line per server, once every server has connected or failed */
    mcpErrors: () => mcp.then((m) => m.errors),
    /** stops the MCP servers; their child processes would otherwise keep the process alive */
    close: () => mcp.then((m) => m.close()),
  };
}

export type Agent = Awaited<ReturnType<typeof createAgent>>;
