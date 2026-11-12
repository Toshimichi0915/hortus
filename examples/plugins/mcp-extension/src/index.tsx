import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CliPlugin, ToolRenderer, ToolView } from "@hortus/cli";
import { type Ctx, expandEnv, hortusDir, type Image, type Tool, tool } from "@hortus/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Box, Text } from "ink";
import { z } from "zod";

const NAME = "mcp-extension";
const MAX_NAME = 64;
const RETRY_DELAYS = [1_000, 3_000, 5_000, 10_000, 30_000];

// ── Config ────────────────────────────────────────────────────────────────────

const Transport = z.enum(["stdio", "streamable-http", "http", "sse"]);
const Entry = z.looseObject({
  transport: Transport.optional(),
  type: Transport.optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  lifecycle: z.enum(["eager", "lazy"]).optional(),
  enabled: z.boolean().optional(),
  requestTimeoutMs: z.number().positive().optional(),
  timeout: z.number().positive().optional(),
  healthCheckIntervalMs: z.number().positive().optional(),
  auth: z.unknown().optional(),
  oauth: z.unknown().optional(),
});
type Entry = z.infer<typeof Entry>;
const Settings = z.object({
  toolPrefix: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  requestTimeoutMs: z.number().positive(),
  maxRetries: z.number().int().min(0).max(10),
});
type Settings = z.infer<typeof Settings>;
const ConfigFile = z.object({
  settings: Settings.partial().optional(),
  mcpServers: z.record(z.string(), Entry).default({}),
});
type ConfigFile = z.infer<typeof ConfigFile>;
const DEFAULTS: Settings = { toolPrefix: "mcp", requestTimeoutMs: 30_000, maxRetries: 5 };

type Source = "global" | "project" | "extension";
interface ServerConfig {
  transport: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  lifecycle: "eager" | "lazy";
  requestTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  source: Source;
}

/** One entry as a server config: `type`/`http`/`timeout`/`enabled` aliases normalized, required fields checked. */
function normalize(e: Entry, source: Source, lifecycle: "eager" | "lazy"): ServerConfig {
  const t = e.transport ?? e.type ?? (e.url && !e.command ? "streamable-http" : "stdio");
  const transport = t === "http" ? "streamable-http" : t;
  if (e.auth !== undefined || e.oauth !== undefined)
    throw new Error("OAuth is not supported by this port; use static headers");
  if (transport === "stdio" && !e.command) throw new Error("command is required for stdio");
  if (transport !== "stdio" && !e.url) throw new Error(`url is required for ${transport}`);
  if (transport !== "stdio" && e.cwd) throw new Error(`cwd only applies to stdio`);
  const requestTimeoutMs = e.requestTimeoutMs ?? (e.timeout && e.timeout * 1000);
  return {
    transport,
    ...(transport === "stdio"
      ? { command: e.command, args: e.args ?? [], env: e.env, cwd: e.cwd }
      : { url: e.url, headers: e.headers }),
    lifecycle: e.enabled === false ? "lazy" : (e.lifecycle ?? lifecycle),
    ...(requestTimeoutMs && { requestTimeoutMs }),
    ...(e.healthCheckIntervalMs && { healthCheckIntervalMs: e.healthCheckIntervalMs }),
    source,
  };
}

// ponytail: plain JSON, no JSONC comments (hortus's own mcp.json is JSON); strip comments if users ask
async function readConfig(path: string, errors: string[]): Promise<ConfigFile | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return ConfigFile.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (e) {
    errors.push(`${path}: ${message(e)}`);
    return undefined;
  }
}

const projectPath = () => join(process.cwd(), ".hortus", "mcp.json");
const OVERRIDABLE = new Set(["enabled", "lifecycle", "exposure", "toolExposure"]);

// ── Runtime state ─────────────────────────────────────────────────────────────

interface Server {
  name: string;
  config: ServerConfig;
  state: "stopped" | "starting" | "ready" | "failed";
  client?: Client;
  /** this server's tools, as hortus tools (also when stopped: the last discovered set) */
  tools: Tool[];
  error?: string;
  stderr: string;
  retries: number;
  starting?: Promise<void>;
  abort?: AbortController;
  retry?: NodeJS.Timeout;
  health?: NodeJS.Timeout;
}

interface State {
  /** this plugin's host ctx, from `ready`: notifications, status and the agent's tools outside any run */
  ctx: Ctx;
  settings: Settings;
  servers: Map<string, Server>;
  /** the project's .hortus/mcp.json is trusted (`ctx.trust`): undefined until trusted or answered */
  trusted?: boolean;
  /**
   * per running run: its tools (`ctx.tools`), where servers connecting or stopping mid-run add or remove theirs; the MCP
   * tools offered at its `run_start`; and (from its first turn) those a later run_start handler removed from it, a
   * restriction: they stay off, even when their server reconnects
   */
  runs: Map<string, { tools: Tool[]; offered: Set<string>; blocked?: Set<string> }>;
  queue: Promise<void>;
  closed: boolean;
}

/** this agent's state (`ctx.state`: per agent, shared by this plugin's handlers, tools and commands), from `ready` */
const stateIn = (ctx: Ctx) => ctx.state as { st?: State };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const byName = (a: Tool, b: Tool) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const activeTools = (st: State) =>
  new Map([...st.servers.values()].filter(isReady).flatMap((s) => s.tools.map((t) => [t.name, t])));
const isReady = (s: Server) => s.state === "ready";
const ownsName = (st: State, name: string) =>
  [...st.servers.values()].some((s) => s.tools.some((t) => t.name === name));

/** Sorts the tools `mine` picks among the slots they hold, so connect order never changes what is declared. */
function order(tools: Tool[], mine: (t: Tool) => boolean) {
  const slots = tools.flatMap((t, i) => (mine(t) ? [i] : []));
  const sorted = slots.map((i) => tools[i] as Tool).sort(byName);
  slots.forEach((i, k) => {
    tools[i] = sorted[k] as Tool;
  });
}

function status(st: State) {
  const all = [...st.servers.values()];
  const ready = all.filter(isReady).length;
  void st.ctx.status(NAME, all.length ? `MCP ${ready}/${all.length}` : undefined);
}

// ── Tool bridge ───────────────────────────────────────────────────────────────

/**
 * `<prefix>_<server>_<tool>` (`[a-zA-Z0-9_]`, at most 64 chars), with an 8-char SHA-256 suffix when truncated or taken.
 * Names that need no substitution claim the unhashed form first, then code-point order: never `tools/list` order.
 */
function toolNames(prefix: string, server: string, raw: string[], taken: Set<string>) {
  const lossless = (t: string) => /^[a-zA-Z0-9_]+$/.test(t);
  const sorted = [...raw].sort((a, b) => Number(lossless(b)) - Number(lossless(a)) || (a < b ? -1 : a > b ? 1 : 0));
  const names = new Map<string, string>();
  for (const t of sorted) {
    let n = `${prefix}_${server}_${t}`.replace(/[^a-zA-Z0-9_]/g, "_");
    if (n.length > MAX_NAME || taken.has(n)) {
      const hash = createHash("sha256").update(`${prefix}\0${server}\0${t}`).digest("hex").slice(0, 8);
      n = `${n.slice(0, MAX_NAME - 9)}_${hash}`;
    }
    taken.add(n);
    names.set(t, n);
  }
  return names;
}

interface Block {
  type?: string;
  text?: string;
  data?: string;
  blob?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  title?: string;
  description?: string;
  resource?: Block;
}
type Part = string | Image;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** A resource's contents: its text, an image, or a size summary of a binary blob (never the blob itself). */
function resourcePart(r: Block): Part {
  if (r.text !== undefined) return r.text;
  if (r.blob && IMAGE_TYPES.includes(r.mimeType ?? ""))
    return { type: "image", mediaType: r.mimeType as Image["mediaType"], data: r.blob };
  const bytes = Buffer.from(r.blob ?? "", "base64").length;
  return `[Binary resource: ${r.uri} (${r.mimeType ?? "unknown"}, ${bytes} bytes)]`;
}

function part(c: Block): Part {
  switch (c.type) {
    case "text":
      return c.text ?? "";
    case "image":
      return resourcePart({ uri: "image", blob: c.data, mimeType: c.mimeType ?? "image/png" });
    case "audio":
      return `[Audio: ${c.mimeType ?? "unknown"}, base64 encoded]`;
    case "resource":
      return resourcePart(c.resource ?? {});
    case "resource_link": {
      const title = c.title ?? c.name;
      const desc = c.description ? `\n${c.description}` : "";
      return `[Resource link: ${c.uri}${title ? ` ${JSON.stringify(title)}` : ""}${c.mimeType ? ` (${c.mimeType})` : ""} — Use mcp_read_resource to read]${desc}`;
    }
    default:
      return JSON.stringify(c);
  }
}

/** Parts as a tool's return value: the text, or every image with the text on the first. */
function combine(parts: Part[]): string | Image[] {
  const text = parts.filter((p) => typeof p === "string").join("\n");
  const images = parts.filter((p): p is Image => typeof p !== "string");
  return images.length ? images.map((img, i) => (i ? img : { ...img, text })) : text;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** Progress a running MCP tool reports (`ctx.update`), drawn under its block in the TUI. */
export interface McpProgress {
  mcpProgress: string;
}

function bridge(st: State, s: Server, client: Client, list: McpTool[]): Tool[] {
  const others = new Set([...st.servers.values()].filter((o) => o !== s).flatMap((o) => o.tools.map((t) => t.name)));
  const names = toolNames(
    st.settings.toolPrefix,
    s.name,
    list.map((t) => t.name),
    others,
  );
  return list.map((t) => {
    const a = t.annotations ?? {};
    const hints = [
      a.readOnlyHint && "read-only",
      a.destructiveHint && "destructive",
      a.idempotentHint && "idempotent",
      a.openWorldHint && "may have side effects",
    ].filter(Boolean);
    return {
      name: names.get(t.name) as string,
      description: `${t.description ?? `MCP tool: ${t.name}`}${hints.length ? ` [${hints.join(", ")}]` : ""}`,
      // declared as the server's schema, as is; the server validates the input
      inputSchema: z.looseObject({}),
      jsonSchema: t.inputSchema as Record<string, unknown>,
      meta: { mcp: { server: s.name, tool: t.name, ...(t.annotations && { annotations: t.annotations }) } },
      plugin: NAME,
      execute: async (input: Record<string, unknown>, ctx) => {
        if (s.client !== client)
          throw new Error(`MCP server ${s.name} is not connected. Use mcp_connect to connect it.`);
        let last: string | undefined;
        const r = await client.callTool({ name: t.name, arguments: input }, undefined, {
          signal: ctx.signal,
          timeout: s.config.requestTimeoutMs ?? st.settings.requestTimeoutMs,
          // progress arriving with the result can be lost (the SDK drops the handler before the notification runs)
          // every progress notification restarts the timeout: a tool that keeps reporting isn't cut off
          resetTimeoutOnProgress: true,
          onprogress: (p) => {
            const text =
              p.message?.trim().slice(0, 200) || `Progress ${p.progress}${p.total === undefined ? "" : `/${p.total}`}`;
            if (text === last) return;
            last = text;
            ctx.update({ mcpProgress: text } satisfies McpProgress);
          },
        });
        const content = (Array.isArray(r.content) ? r.content : []) as Block[];
        const parts = content.map(part);
        if (!parts.length && r.structuredContent !== undefined)
          parts.push(JSON.stringify(r.structuredContent, null, 2));
        const out = combine(parts);
        if (r.isError) throw new Error(parts.filter((p) => typeof p === "string").join("\n") || "MCP tool failed");
        return out;
      },
    } as Tool;
  });
}

/**
 * Puts `s`'s tools (rebuilt from `list`) into the agent's tools, in name order among the MCP slots, and into every
 * running run's (core declares them from its next request on), except those a run blocked.
 */
function activate(st: State, s: Server, client: Client, list: McpTool[]) {
  deactivate(st, s);
  s.tools = bridge(st, s, client, list);
  st.ctx.tools.push(...s.tools);
  order(st.ctx.tools, (t) => ownsName(st, t.name));
  for (const run of st.runs.values())
    for (const t of s.tools)
      if (!run.blocked?.has(t.name) && !run.tools.some((x) => x.name === t.name)) run.tools.push(t);
}

/** Takes `s`'s tools out of the agent's tools and every running run's. */
function deactivate(st: State, s: Server) {
  for (const tools of [st.ctx.tools, ...[...st.runs.values()].map((r) => r.tools)])
    for (let i = tools.length - 1; i >= 0; i--) if (s.tools.includes(tools[i] as Tool)) tools.splice(i, 1);
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

function transportOf(c: ServerConfig, s: Server) {
  const expand = (v: Record<string, string> = {}) =>
    Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandEnv(x)]));
  if (c.transport === "stdio") {
    const cwd = c.cwd && resolve(process.cwd(), c.cwd.replace(/^~(?=$|\/)/, homedir()));
    const t = new StdioClientTransport({
      command: c.command as string,
      args: c.args,
      env: c.env && { ...(process.env as Record<string, string>), ...expand(c.env) },
      cwd,
      // piped, not inherited, so a server's logs don't draw over the TUI; kept for /mcp <name>
      stderr: "pipe",
    });
    t.stderr?.on("data", (d: Buffer) => {
      s.stderr = (s.stderr + d.toString()).slice(-4000);
    });
    return t;
  }
  const opts = { requestInit: { headers: expand(c.headers) } };
  return c.transport === "sse"
    ? new SSEClientTransport(new URL(c.url as string), opts)
    : new StreamableHTTPClientTransport(new URL(c.url as string), opts);
}

/** Connects `s` and activates its tools; joins a connect already going on. Throws when it fails. */
function start(st: State, s: Server): Promise<void> {
  if (s.state === "ready") return Promise.resolve();
  s.starting ??= open(st, s).finally(() => {
    s.starting = undefined;
  });
  return s.starting;
}

async function open(st: State, s: Server) {
  clearTimeout(s.retry);
  const abort = new AbortController();
  s.abort = abort;
  s.state = "starting";
  s.error = undefined;
  status(st);
  const timeout = s.config.requestTimeoutMs ?? st.settings.requestTimeoutMs;
  const client = new Client(
    { name: "hortus-mcp-extension", version: "0.1.0" },
    {
      listChanged: {
        tools: {
          onChanged: (e, tools) => {
            if (!e && tools && s.client === client) activate(st, s, client, tools as McpTool[]);
          },
        },
      },
    },
  );
  try {
    await client.connect(transportOf(s.config, s), { timeout, signal: abort.signal });
    const list: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor }, { timeout, signal: abort.signal });
      list.push(...(page.tools as McpTool[]));
      cursor = page.nextCursor;
    } while (cursor);
    if (abort.signal.aborted || st.closed) throw new Error("stopped");
    s.client = client;
    s.state = "ready";
    s.retries = 0;
    client.onclose = () => {
      if (s.client === client) dropped(st, s, "connection closed");
    };
    if (s.config.healthCheckIntervalMs)
      s.health = setInterval(
        () => void client.ping({ timeout }).catch(() => client.close()),
        s.config.healthCheckIntervalMs,
      ).unref();
    activate(st, s, client, list);
    status(st);
  } catch (e) {
    await client.close().catch(() => {});
    if (abort.signal.aborted || st.closed) return;
    s.state = "failed";
    s.error = message(e);
    status(st);
    throw new Error(`${s.name}: ${s.error}${s.stderr.trim() ? `\n${s.stderr.trim()}` : ""}`);
  }
}

/** The connection went away on its own: tools off, then reconnect on the retry schedule. */
function dropped(st: State, s: Server, why: string) {
  clearInterval(s.health);
  deactivate(st, s);
  s.client = undefined;
  s.state = "failed";
  s.error = why;
  status(st);
  retry(st, s);
}

function retry(st: State, s: Server) {
  if (st.closed) return;
  if (s.retries >= st.settings.maxRetries) {
    if (s.retries) void st.ctx.notify(`${NAME}: gave up on ${s.name} after ${s.retries} retries — ${s.error}`, "error");
    return;
  }
  const delay = RETRY_DELAYS[Math.min(s.retries, RETRY_DELAYS.length - 1)];
  s.retries++;
  s.retry = setTimeout(() => start(st, s).catch(() => retry(st, s)), delay).unref();
}

async function stop(st: State, s: Server) {
  clearTimeout(s.retry);
  clearInterval(s.health);
  s.abort?.abort();
  const client = s.client;
  s.client = undefined;
  deactivate(st, s);
  s.state = "stopped";
  s.retries = 0;
  status(st);
  await client?.close().catch(() => {});
}

/** Starts an eager server in the background: failures are notified, then retried. */
const startEager = (st: State, s: Server) =>
  start(st, s).catch((e) => {
    void st.ctx.notify(`${NAME}: Failed to start ${message(e)}`, "error");
    retry(st, s);
  });

/**
 * Reads the config (global `~/.hortus/mcp.json`, a trusted project's `.hortus/mcp.json`, servers plugins push in
 * `mcp_servers`; mcp.json wins a name, the project file overrides the global one) and applies it: removed or changed
 * servers stop, new eager ones start.
 */
async function reconcile(st: State, ctx: Ctx) {
  const errors: string[] = [];
  const globalPath = join(hortusDir(), "mcp.json");
  const global = await readConfig(globalPath, errors);
  let project: ConfigFile | undefined;
  const path = projectPath();
  if (existsSync(path)) {
    const trusted = await ctx.trust(dirname(dirname(path)), { reason: `(${path} starts MCP servers)` });
    // settled once trusted or answered; else asked again at `interactive`
    if (trusted || ctx.host.interactive) st.trusted = trusted;
    if (trusted) project = await readConfig(path, errors);
  }
  const ext = { servers: {} };
  await ctx.emit("mcp_servers", ext);
  st.settings = { ...DEFAULTS, ...global?.settings, ...project?.settings };

  const configs = new Map<string, ServerConfig>();
  const add = (where: string, name: string, f: () => ServerConfig) => {
    try {
      configs.set(name, f());
    } catch (e) {
      errors.push(`${where}: ${name}: ${message(e)}`);
    }
  };
  for (const [name, e] of Object.entries(ext.servers))
    add("mcp_servers", name, () => normalize(e as Entry, "extension", "eager"));
  const globals = global?.mcpServers ?? {};
  for (const [name, e] of Object.entries(globals)) add(globalPath, name, () => normalize(e, "global", "lazy"));
  for (const [name, e] of Object.entries(project?.mcpServers ?? {}))
    add(path, name, () => {
      if (e.command || e.url || e.type || e.transport) return normalize(e, "project", "lazy");
      // a partial override: per-project switches over the global entry (whose credentials the project can't set)
      const base = globals[name];
      if (!base) throw new Error("override for a server the global mcp.json doesn't define");
      const bad = Object.keys(e).filter((k) => !OVERRIDABLE.has(k));
      if (bad.length) throw new Error(`an override can't set ${bad.join(", ")}`);
      return { ...normalize({ ...base, ...e }, "global", "lazy"), source: "project" };
    });
  for (const e of errors) void ctx.notify(`${NAME}: Config error — ${e}`, "error");

  for (const [name, s] of st.servers)
    if (JSON.stringify(configs.get(name)) !== JSON.stringify(s.config)) {
      await stop(st, s);
      st.servers.delete(name);
    }
  const starts: Promise<void>[] = [];
  for (const [name, config] of configs) {
    if (st.servers.has(name)) continue;
    const s: Server = { name, config, state: "stopped", tools: [], stderr: "", retries: 0 };
    st.servers.set(name, s);
    if (config.lifecycle === "eager") starts.push(startEager(st, s));
  }
  status(st);
  await Promise.all(starts);
}

// ── Inspection ────────────────────────────────────────────────────────────────

function stateOf(ctx: Ctx): State {
  const { st } = stateIn(ctx);
  if (!st) throw new Error(`${NAME} hasn't started`);
  return st;
}

function server(st: State, name: string): Server {
  const s = st.servers.get(name);
  if (!s) throw new Error(`No MCP server named "${name}". Use mcp_status (or /mcp) to list configured servers.`);
  return s;
}

function connected(s: Server): Client {
  if (!s.client) throw new Error(`MCP server ${s.name} is not connected. Use mcp_connect (or /mcp:start ${s.name}).`);
  return s.client;
}

const instructions = (s: Server) => s.client?.getInstructions()?.replace(/\s+/g, " ").trim().slice(0, 500) || undefined;
/** `s`'s tools in `tools` (a run's, or the agent's), against those it discovered */
const activity = (s: Server, tools: Tool[]) => ({
  discovered: s.tools.length,
  active: s.state === "ready" ? s.tools.filter((t) => tools.some((x) => x.name === t.name)).length : 0,
});

function summary(st: State): string {
  const all = [...st.servers.values()];
  if (!all.length) return `${NAME}: No servers configured (create ~/.hortus/mcp.json)`;
  const lines = all.map((s) => {
    const icon = s.state === "ready" ? "✓" : s.state === "starting" ? "⟳" : "✗";
    return `  ${icon} ${s.name} (${s.state})${s.error ? ` — ${s.error}` : ""}`;
  });
  return [`MCP: ${all.filter(isReady).length}/${all.length} servers ready`, ...lines].join("\n");
}

function detail(s: Server, tools: Tool[]): string {
  const { active, discovered } = activity(s, tools);
  const c = s.config;
  const i = instructions(s);
  return [
    `Server: ${s.name}`,
    `State:  ${s.state}`,
    `Retries: ${s.retries}`,
    `Transport: ${c.transport}`,
    `Lifecycle: ${c.lifecycle}`,
    `Source: ${c.source}`,
    `Tools: ${active}/${discovered} active`,
    ...(i ? [`Instructions: ${i}`] : []),
    ...(s.error ? [`Last error: ${s.error}`] : []),
    "",
    "Recent output:",
    s.stderr.trim().split("\n").slice(-20).join("\n") || `(no stderr output from ${s.name})`,
  ].join("\n");
}

interface Catalog {
  resources: { uri: string; name: string; description?: string; mimeType?: string }[];
  templates: { uriTemplate: string; name: string; description?: string; mimeType?: string }[];
  resourcesUnsupported?: boolean;
  error?: string;
}

async function catalog(s: Server, timeout: number, signal?: AbortSignal): Promise<Catalog> {
  const client = connected(s);
  if (!client.getServerCapabilities()?.resources) return { resources: [], templates: [], resourcesUnsupported: true };
  const out: Catalog = { resources: [], templates: [] };
  try {
    let cursor: string | undefined;
    do {
      const page = await client.listResources({ cursor }, { timeout, signal });
      out.resources.push(...page.resources);
      cursor = page.nextCursor;
    } while (cursor);
    do {
      const page = await client.listResourceTemplates({ cursor }, { timeout, signal });
      out.templates.push(...page.resourceTemplates);
      cursor = page.nextCursor;
    } while (cursor);
  } catch (e) {
    if (signal?.aborted) throw e;
    out.error = message(e);
  }
  return out;
}

async function readResource(st: State, s: Server, uri: string, signal?: AbortSignal) {
  const client = connected(s);
  if (!client.getServerCapabilities()?.resources) throw new Error(`MCP server ${s.name} does not expose MCP resources`);
  const timeout = s.config.requestTimeoutMs ?? st.settings.requestTimeoutMs;
  const r = await client.readResource({ uri }, { timeout, signal });
  return combine(r.contents.map((c) => resourcePart(c as Block)));
}

const timeoutOf = (st: State, s: Server) => s.config.requestTimeoutMs ?? st.settings.requestTimeoutMs;
const names = (ctx: Ctx) => [...(stateIn(ctx).st?.servers.keys() ?? [])].map((value) => ({ value }));
const progress = (v: ToolView) => (v.result ? undefined : (v.details as McpProgress | undefined)?.mcpProgress);

/**
 * pi-mcp-extension as a hortus plugin replacing builtin:mcp: layered config (global, trusted project, `mcp_servers`),
 * eager/lazy servers with reconnects and health checks, `<prefix>_<server>_<tool>` tools activated as servers connect
 * (also mid-run) in a stable order, progress and cancellation, resources, and the `mcp_*` tools and `/mcp` commands.
 */
export default {
  tools: [
    tool({
      name: "mcp_status",
      description:
        "List configured MCP servers, lifecycle, connection state and tool counts. Use mcp_connect to connect one server.",
      inputSchema: z.object({}),
      execute: async (_, ctx) => {
        const st = stateOf(ctx);
        const rows = [...st.servers.values()].map((s) => ({
          name: s.name,
          lifecycle: s.config.lifecycle,
          state: s.state,
          tools: activity(s, ctx.tools),
          source: s.config.source,
          ...(instructions(s) && { instructions: instructions(s) }),
          ...(s.error && { error: s.error }),
        }));
        return JSON.stringify(rows);
      },
    }),
    tool({
      name: "mcp_connect",
      description: "Connect one named configured MCP server and activate its tools.",
      inputSchema: z.object({ name: z.string().describe("Exact configured MCP server name") }),
      execute: async ({ name }, ctx) => {
        const st = stateOf(ctx);
        const s = server(st, name);
        // `activate` adds its tools to this run too: declared from its next request on
        await start(st, s);
        const i = instructions(s);
        return `MCP server ${name} ready; ${s.tools.length} tools discovered and active.${i ? `\nInstructions: ${i}` : ""}`;
      },
    }),
    tool({
      name: "mcp_list_resources",
      description:
        "List MCP resources and URI templates exposed by connected servers. Use mcp_read_resource to read one by URI.",
      inputSchema: z.object({
        server: z.string().optional().describe("Exact configured MCP server name (default: all connected servers)"),
      }),
      execute: async ({ server: name }, ctx) => {
        const st = stateOf(ctx);
        const all = name ? [server(st, name)] : [...st.servers.values()];
        const ready = all.filter(isReady);
        const servers = await Promise.all(
          ready.map(async (s) => ({ server: s.name, ...(await catalog(s, timeoutOf(st, s), ctx.signal)) })),
        );
        if (name && !ready.length) connected(all[0] as Server);
        return JSON.stringify({ servers, stoppedServers: all.filter((s) => !isReady(s)).map((s) => s.name) });
      },
    }),
    tool({
      name: "mcp_read_resource",
      description:
        "Read one MCP resource by server and URI. Text resources return their text; image blobs return an image; other binary blobs return a size summary.",
      inputSchema: z.object({
        server: z.string().describe("Exact configured MCP server name"),
        uri: z.string().describe("Resource URI, or a URI template filled in by the caller"),
      }),
      execute: async ({ server: name, uri }, ctx) => {
        const st = stateOf(ctx);
        return readResource(st, server(st, name), uri, ctx.signal);
      },
    }),
  ],
  commands: [
    {
      name: "mcp",
      description: "Show MCP servers, or one server in detail",
      args: "[server]",
      complete: names,
      run: (arg, ctx) => {
        const st = stateOf(ctx);
        return arg?.trim() ? detail(server(st, arg.trim()), ctx.tools) : summary(st);
      },
    },
    {
      name: "mcp:start",
      description: "Connect an MCP server and activate its tools",
      args: "<server>",
      complete: names,
      run: async (arg, ctx) => {
        const st = stateOf(ctx);
        const s = server(st, arg?.trim() ?? "");
        await start(st, s);
        return `${NAME}: Started ${s.name} (${s.tools.length} tools)`;
      },
    },
    {
      name: "mcp:stop",
      description: "Stop an MCP server (or a pending connect) and deactivate its tools",
      args: "<server>",
      complete: names,
      run: async (arg, ctx) => {
        const st = stateOf(ctx);
        const s = server(st, arg?.trim() ?? "");
        await stop(st, s);
        return `${NAME}: Stopped ${s.name}`;
      },
    },
    {
      name: "mcp:resources",
      description: "List MCP resources: every server's counts, one server's catalog, or read one URI",
      args: "[server] [uri]",
      complete: names,
      run: async (arg, ctx) => {
        const st = stateOf(ctx);
        const [name, uri] = (arg ?? "").trim().split(/\s+(.*)/s);
        if (!name) {
          const ready = [...st.servers.values()].filter(isReady);
          if (!ready.length) return `${NAME}: No connected MCP servers. Use /mcp:start <name> to connect one.`;
          const rows = await Promise.all(
            ready.map(async (s) => {
              const c = await catalog(s, timeoutOf(st, s));
              return c.resourcesUnsupported
                ? `  ${s.name}: no resources`
                : `  ${s.name}: ${c.resources.length} resources, ${c.templates.length} templates${c.error ? ` (${c.error})` : ""}`;
            }),
          );
          return [`${NAME}: MCP resources`, ...rows].join("\n");
        }
        const s = server(st, name);
        if (uri) {
          const r = await readResource(st, s, uri.trim());
          if (typeof r === "string") return `${s.name} ${uri}:\n${r.slice(0, 2000)}${r.length > 2000 ? "\n…" : ""}`;
          return `${s.name} ${uri}: ${r.length} image(s)${r[0]?.text ? `\n${r[0].text}` : ""}`;
        }
        const c = await catalog(s, timeoutOf(st, s));
        if (c.resourcesUnsupported) return `${NAME}: ${s.name} does not expose MCP resources.`;
        const rows = [
          ...c.resources.map(
            (r) => `  ${r.uri}${r.mimeType ? ` (${r.mimeType})` : ""}${r.description ? ` — ${r.description}` : ""}`,
          ),
          ...c.templates.map((t) => `  ${t.uriTemplate} (template)${t.description ? ` — ${t.description}` : ""}`),
        ];
        const more = rows.length > 50 ? [`  … and ${rows.length - 50} more`] : [];
        return [
          `${s.name}: ${c.resources.length} resources, ${c.templates.length} templates`,
          ...rows.slice(0, 50),
          ...more,
        ]
          .concat(c.error ? [`Error: ${c.error}`] : [])
          .join("\n");
      },
    },
  ],
  on: {
    ready: (_, ctx) => {
      const st: State = {
        ctx,
        settings: DEFAULTS,
        servers: new Map(),
        runs: new Map(),
        queue: Promise.resolve(),
        closed: false,
      };
      stateIn(ctx).st = st;
      // in the background; the first run waits for it. The project's servers are asked about only if a person can
      // answer now (else at `interactive`)
      st.queue = reconcile(st, ctx).catch((e) => void ctx.notify(`${NAME}: ${message(e)}`, "error"));
    },
    // the TUI can show questions now (at `ready` it couldn't): ask about the project's servers
    interactive: async (_, ctx) => {
      const { st } = stateIn(ctx);
      if (!st || st.trusted !== undefined || !existsSync(projectPath())) return;
      st.queue = st.queue
        .then(() => reconcile(st, ctx))
        .catch((e) => void ctx.notify(`${NAME}: ${message(e)}`, "error"));
      await st.queue;
    },
    run_start: async (p, ctx) => {
      const { st } = stateIn(ctx);
      if (!st) return;
      await st.queue;
      const active = activeTools(st);
      for (const t of active.values()) if (!p.tools.some((x) => x.name === t.name)) p.tools.push(t);
      if (ctx.run) st.runs.set(ctx.run.id, { tools: p.tools, offered: new Set(active.keys()) });
    },
    // after every run_start handler: the run's final tools, the MCP ones removed from it (kept off), and those of
    // servers that connected meanwhile
    turn_start: (_, ctx) => {
      const run = ctx.run && stateIn(ctx).st?.runs.get(ctx.run.id);
      if (!run || run.blocked) return;
      const has = (name: string) => ctx.tools.some((t) => t.name === name);
      run.blocked = new Set([...run.offered].filter((n) => !has(n)));
      run.tools = ctx.tools;
      const st = stateIn(ctx).st as State;
      for (const t of activeTools(st).values()) if (!run.offered.has(t.name) && !has(t.name)) ctx.tools.push(t);
    },
    // declared in name order among the MCP slots, whatever order servers connected in
    request: (r, ctx) => {
      const { st } = stateIn(ctx);
      if (st && (r.source === "run" || r.source === "preview")) order(r.tools, (t) => ownsName(st, t.name));
    },
    run_end: (_, ctx) => {
      if (ctx.run) stateIn(ctx).st?.runs.delete(ctx.run.id);
    },
    close: async (_, ctx) => {
      const { st } = stateIn(ctx);
      if (!st) return;
      st.closed = true;
      await Promise.all([...st.servers.values()].map((s) => stop(st, s)));
      stateIn(ctx).st = undefined;
    },
  },
  cli: {
    // MCP tool names are only known once servers connect, so progress wraps the generic block (`tool:*`)
    entries: {
      "tool:*": {
        Render: ({ Default, ...v }) => {
          const p = progress(v);
          return p ? (
            <Box flexDirection="column">
              <Default {...v} />
              <Text dimColor>{p.slice(0, v.width)}</Text>
            </Box>
          ) : (
            <Default {...v} />
          );
        },
        text: (v, Default) => {
          const p = progress(v);
          return p ? `${Default(v)}\n${p.slice(0, v.width)}` : Default(v);
        },
      } satisfies ToolRenderer,
    },
  },
} satisfies CliPlugin;
