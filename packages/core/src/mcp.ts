import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { hortusDir } from "./config.ts";
import type { Image, Tool } from "./llm.ts";
import { expandEnv } from "./secrets.ts";

const Common = { enabled: z.boolean().optional() };
/** One `mcpServers` entry; the same format as pi, Claude Code and Cursor, so entries copy over as is. */
const StdioSchema = z.looseObject({
  ...Common,
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});
const HttpSchema = z.looseObject({ ...Common, url: z.url(), headers: z.record(z.string(), z.string()).optional() });
/** fields it doesn't know are kept, for plugins reading the same file (a server's lifecycle, say) */
const ServerSchema = z.union([StdioSchema, HttpSchema]);
/** One server's entry (`mcpServers.<name>`, an `mcp_servers` event's `servers.<name>`). */
export type McpServer = z.infer<typeof ServerSchema>;
export const McpConfigSchema = z.looseObject({ mcpServers: z.record(z.string(), ServerSchema).default({}) });
export type McpConfig = z.infer<typeof McpConfigSchema>;

export async function loadMcpConfig(path = join(hortusDir(), "mcp.json")): Promise<McpConfig> {
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
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, expandEnv(v)]));

/** `mcp__<server>__<tool>`, every character other than letters, digits and `_` replaced by `_`. */
export const mcpToolName = (server: string, tool: string) => `mcp__${server}__${tool}`.replace(/\W/g, "_");

interface Content {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/**
 * A tool's result as `execute` returns it: structured content as is, otherwise its text, with every image attached
 * (the text on the first). An `isError` result throws, so the model gets it as an error.
 */
export function mcpResult(r: Record<string, unknown>): unknown {
  const content = (Array.isArray(r.content) ? r.content : []) as Content[];
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (r.isError) throw new Error(text || "MCP tool failed");
  if (r.structuredContent !== undefined) return r.structuredContent;
  const images = content
    .filter((c) => c.type === "image" && c.data)
    .map(
      (c, i): Image => ({
        type: "image",
        mediaType: c.mimeType as Image["mediaType"],
        data: c.data as string,
        ...(i ? {} : { text }),
      }),
    );
  return images.length > 1 ? images : (images[0] ?? text);
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
export async function connectMcp(
  config: McpConfig,
  roots: string[] = [process.cwd()],
  /** per server, for connecting and listing its tools; one past it fails like one that errors */
  // ponytail: one timeout for every server; a per-server mcp.json field if a slow starter (npx install) needs more
  timeout = 30_000,
): Promise<Mcp> {
  const clients: Client[] = [];
  const results = await Promise.allSettled(
    Object.entries(config.mcpServers)
      .filter(([, s]) => s.enabled !== false)
      .map(async ([name, s]) => {
        let stderr = "";
        const stdio = typeof s.command === "string" ? (s as z.infer<typeof StdioSchema>) : undefined;
        const transport = stdio
          ? new StdioClientTransport({
              command: stdio.command,
              args: stdio.args,
              env: stdio.env && { ...(process.env as Record<string, string>), ...expand(stdio.env) },
              cwd: stdio.cwd,
              // piped, not inherited, so a server's logs don't draw over the TUI; kept for the error message
              stderr: "pipe",
            })
          : new StreamableHTTPClientTransport(new URL(String(s.url)), {
              requestInit: { headers: expand((s as z.infer<typeof HttpSchema>).headers) },
            });
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
        let timer: NodeJS.Timeout | undefined;
        const open = async () => {
          await client.connect(transport);
          clients.push(client);
          // ponytail: listed once at connect; handle notifications/tools/list_changed if a server's tools change
          const tools: Tool[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.listTools({ cursor });
            tools.push(
              ...page.tools.map(
                (t): Tool => ({
                  name: mcpToolName(name, t.name),
                  description: t.description ?? "",
                  // declared as the server's schema, as is; the server validates the input
                  inputSchema: z.looseObject({}),
                  jsonSchema: t.inputSchema,
                  meta: { mcp: { server: name, tool: t.name, ...(t.annotations && { annotations: t.annotations }) } },
                  ...(t.annotations?.readOnlyHint && { effects: { readOnly: true } }),
                  // its structured content is the result's `value`, which codemode declares by this
                  ...(t.outputSchema && { outputSchema: t.outputSchema }),
                  execute: async (input: Record<string, unknown>) =>
                    mcpResult(await client.callTool({ name: t.name, arguments: input })),
                }),
              ),
            );
            cursor = page.nextCursor;
          } while (cursor);
          return tools;
        };
        try {
          return await Promise.race([
            open(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`timed out after ${timeout / 1000}s`)), timeout);
            }),
          ]);
        } catch (e) {
          await client.close().catch(() => {});
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`MCP server ${name}: ${msg}${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
        } finally {
          clearTimeout(timer);
        }
      }),
  );
  return {
    tools: results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
    errors: results.flatMap((r) => (r.status === "rejected" ? [(r.reason as Error).message] : [])),
    close: async () => void (await Promise.allSettled(clients.map((c) => c.close()))),
  };
}
