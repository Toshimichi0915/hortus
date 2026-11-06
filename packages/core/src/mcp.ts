import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { HORTUS_DIR } from "./config.ts";
import type { Image, Tool } from "./llm.ts";

const Common = { enabled: z.boolean().optional() };
/** One `mcpServers` entry; the same format as pi, Claude Code and Cursor, so entries copy over as is. */
const ServerSchema = z.union([
  z.object({
    ...Common,
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  }),
  z.object({ ...Common, url: z.url(), headers: z.record(z.string(), z.string()).optional() }),
]);
export const McpConfigSchema = z.object({ mcpServers: z.record(z.string(), ServerSchema).default({}) });
export type McpConfig = z.infer<typeof McpConfigSchema>;

export async function loadMcpConfig(path = join(HORTUS_DIR, "mcp.json")): Promise<McpConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { mcpServers: {} };
    throw e;
  }
  try {
    return McpConfigSchema.parse(JSON.parse(text.replace(/^﻿/, "")));
  } catch (e) {
    throw new Error(`Invalid ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** `${VAR}` in env and header values reads the environment, so secrets can stay out of mcp.json. */
const expand = (values: Record<string, string> = {}) =>
  Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, v.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")]),
  );

/** `mcp__<server>__<tool>`, every character other than letters, digits and `_` replaced by `_`. */
export const mcpToolName = (server: string, tool: string) => `mcp__${server}__${tool}`.replace(/\W/g, "_");

interface Content {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/**
 * A tool's result as `execute` returns it: structured content as is, otherwise its text, with the first image
 * attached. An `isError` result throws, so the model gets it as an error.
 */
export function mcpResult(r: Record<string, unknown>): unknown {
  const content = (Array.isArray(r.content) ? r.content : []) as Content[];
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (r.isError) throw new Error(text || "MCP tool failed");
  if (r.structuredContent !== undefined) return r.structuredContent;
  // ponytail: only the first image reaches the model; ToolResult holds one
  const img = content.find((c) => c.type === "image");
  if (img?.data) return { type: "image", mediaType: img.mimeType as Image["mediaType"], data: img.data, text } as Image;
  return text;
}

export interface Mcp {
  /** every connected server's tools, named by `mcpToolName` */
  tools: Tool[];
  /** one line per server that failed to connect or list its tools */
  errors: string[];
  close(): Promise<void>;
}

/**
 * Connects every enabled server in parallel; one that fails is reported in `errors` and skipped.
 *
 * `roots` (default: the cwd) is advertised as the MCP roots capability. Without it a server that sandboxes file
 * access to workspace roots (chrome-devtools-mcp confines screenshots and downloads to them) refuses every path
 * outside the OS temp directory, so `--allow-unrestricted-paths` is the server-side alternative to this.
 */
export async function connectMcp(config: McpConfig, roots: string[] = [process.cwd()]): Promise<Mcp> {
  const clients: Client[] = [];
  const results = await Promise.allSettled(
    Object.entries(config.mcpServers)
      .filter(([, s]) => s.enabled !== false)
      .map(async ([name, s]) => {
        let stderr = "";
        const transport =
          "command" in s
            ? new StdioClientTransport({
                command: s.command,
                args: s.args,
                env: s.env && { ...(process.env as Record<string, string>), ...expand(s.env) },
                cwd: s.cwd,
                // piped, not inherited, so a server's logs don't draw over the TUI; kept for the error message
                stderr: "pipe",
              })
            : new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: expand(s.headers) } });
        if (transport instanceof StdioClientTransport)
          transport.stderr?.on("data", (d: Buffer) => {
            stderr = (stderr + d.toString()).slice(-2000);
          });
        const client = new Client(
          { name: "hortus", version: "0.1.0" },
          roots.length ? { capabilities: { roots: { listChanged: false } } } : undefined,
        );
        // the list is fixed for the run, so `listChanged: false` and no notifications/roots/list_changed
        if (roots.length)
          client.setRequestHandler(ListRootsRequestSchema, async () => ({
            roots: roots.map((r) => ({ uri: pathToFileURL(r).href, name: r })),
          }));
        try {
          await client.connect(transport);
          clients.push(client);
          // ponytail: listed once at connect; handle notifications/tools/list_changed if a server's tools change
          const tools: Tool[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.listTools({ cursor });
            tools.push(
              ...page.tools.map((t) => {
                let inputSchema: z.ZodObject;
                try {
                  const s = z.fromJSONSchema(t.inputSchema as z.core.JSONSchema.JSONSchema);
                  inputSchema = s instanceof z.ZodObject ? s : z.looseObject({});
                } catch {
                  // ponytail: a schema zod can't read is sent as "any object"; the server still validates it
                  inputSchema = z.looseObject({});
                }
                return {
                  name: mcpToolName(name, t.name),
                  description: t.description ?? "",
                  inputSchema,
                  execute: async (input: Record<string, unknown>) =>
                    mcpResult(await client.callTool({ name: t.name, arguments: input })),
                } as Tool;
              }),
            );
            cursor = page.nextCursor;
          } while (cursor);
          return tools;
        } catch (e) {
          await client.close().catch(() => {});
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`MCP server ${name}: ${msg}${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
        }
      }),
  );
  return {
    tools: results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
    errors: results.flatMap((r) => (r.status === "rejected" ? [(r.reason as Error).message] : [])),
    close: async () => void (await Promise.allSettled(clients.map((c) => c.close()))),
  };
}
