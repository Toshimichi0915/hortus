import { connectMcp, type Ctx, loadMcpConfig, type Mcp, type McpServer, type Piece, version } from "../index.ts";

/** this agent's connection set (`ctx.state`, per agent) */
const state = (ctx: Ctx) => ctx.state as { mcp?: Promise<Mcp | undefined> };
const hasHost = (tools: readonly { codemodeHost?: boolean }[]) => tools.some((t) => t.codemodeHost);

/** `mcp.json`'s servers plus those plugins add in `mcp_servers` (`mcp.json` wins a name), connected; errors notified. */
async function connect(ctx: Ctx): Promise<Mcp> {
  let file: Record<string, McpServer> = {};
  try {
    file = (await loadMcpConfig()).mcpServers;
  } catch (e) {
    // an invalid mcp.json is reported like a failed server, so plugins' servers still connect
    void ctx.notify(e instanceof Error ? e.message : String(e), "error");
  }
  const p = { servers: { ...file } };
  await ctx.emit("mcp_servers", p);
  const m = await connectMcp({ mcpServers: { ...p.servers, ...file } });
  for (const e of m.errors) void ctx.notify(e, "error");
  return m;
}

/**
 * MCP servers' tools, as `mcp__<server>__<tool>`: connected in the background at `ready` (after every plugin's `init`),
 * then added to the agent's tools (host `ctx.tools`), reachable only from codemode when a codemode host (a tool with
 * `codemodeHost`) is there, else declared; a run started before that waits for them. A run whose tools have no codemode
 * host when its `run_start` reaches this plugin gets them declared. Stopped at `close`.
 */
export default {
  name: "builtin:mcp",
  version,
  plugin: {
    on: {
      ready: (_, ctx) => {
        const mcp = connect(ctx).then(
          (m) => {
            const exposure = hasHost(ctx.tools) ? "codemode" : "direct";
            const tools = m.tools.map((t) => ({ ...t, exposure, plugin: "builtin:mcp" }) as const);
            ctx.tools.push(...tools);
            return { ...m, tools };
          },
          (e) => {
            void ctx.notify(`MCP: ${e instanceof Error ? e.message : String(e)}`, "error");
            return undefined;
          },
        );
        state(ctx).mcp = mcp;
      },
      run_start: async (p, ctx) => {
        const m = await state(ctx).mcp;
        // required, not a fallback: a run that copied the agent's tools before they connected, or a child run (whose tools
        // come from its plugins, never the host's), gets them only here; one already there by name (e.g. replaced) is kept
        // ponytail: also re-adds one an earlier run_start handler removed (only builtins come before this one)
        for (const t of m?.tools ?? []) if (!p.tools.some((x) => x.name === t.name)) p.tools.push(t);
        // no codemode host in this run (removed, or builtin:codemode disabled): its MCP tools are declared, as copies
        if (!hasHost(p.tools))
          p.tools.forEach((t, i) => {
            if (m?.tools.includes(t)) p.tools[i] = { ...t, exposure: "direct" };
          });
      },
      close: async (_, ctx) => {
        const m = await state(ctx).mcp;
        state(ctx).mcp = undefined;
        await m?.close();
      },
    },
  },
} satisfies Piece;
