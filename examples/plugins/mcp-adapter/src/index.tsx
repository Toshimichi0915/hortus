import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type CliPlugin, linesRenderer, type Span, type ToolRenderer, type ToolView } from "@hortus/cli";
import {
  type Command,
  type Ctx,
  expandEnv,
  hortusDir,
  type Image,
  type Message,
  mcpToolName,
  type PluginEntry,
  type SessionState,
  type Tool,
  type ToolCtx,
  stateOf as pluginState,
  type ToolResult,
  tool,
  tsType,
} from "@hortus/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type CreateMessageRequest,
  CreateMessageRequestSchema,
  type ElicitRequest,
  ElicitRequestSchema,
  ListRootsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Box, Text } from "ink";
import { z } from "zod";

/** the status key and the name in messages */
const NAME = "mcp-adapter";
const MAX_NAME = 64;
const DEFAULT_IDLE_MIN = 10;
const KEEPALIVE_DELAYS = [30_000, 60_000, 120_000, 300_000];

// ── Config ────────────────────────────────────────────────────────────────────

const Strings = z.array(z.string());
const Approve = z.union([z.boolean(), z.literal("destructive"), Strings]);
const Prefix = z.enum(["server", "short", "none", "mcp"]);
const Lifecycle = z.enum(["lazy", "eager", "keep-alive", "lazy-keep-alive"]);
const Entry = z.looseObject({
  command: z.string().optional(),
  args: Strings.optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  type: z.string().optional(),
  transport: z.string().optional(),
  lifecycle: Lifecycle.optional(),
  idleTimeout: z.number().min(0).optional(),
  requestTimeoutMs: z.number().optional(),
  directTools: z.union([z.boolean(), z.literal("search"), Strings]).optional(),
  includeTools: Strings.optional(),
  excludeTools: Strings.optional(),
  approveTools: Approve.optional(),
  exposeResources: z.boolean().optional(),
  description: z.string().optional(),
  searchKeywords: z.record(z.string(), Strings).optional(),
  toolPrefix: Prefix.optional(),
  appendStructuredContent: z.boolean().optional(),
  roots: z.boolean().optional(),
  disabled: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
type Entry = z.infer<typeof Entry>;
const Settings = z
  .looseObject({
    toolPrefix: Prefix,
    idleTimeout: z.number().min(0),
    requestTimeoutMs: z.number(),
    directTools: z.union([z.boolean(), z.literal("search")]),
    approveTools: Approve,
    exposeResources: z.boolean(),
    outputGuard: z.union([
      z.boolean(),
      z.object({ maxBytes: z.number().positive().optional(), maxLines: z.number().int().positive().optional() }),
    ]),
    sampling: z.boolean(),
    samplingAutoApprove: z.boolean(),
    elicitation: z.boolean(),
    projectServers: z.enum(["ask", "allow"]),
    allowInstall: z.boolean(),
    /** MCP tools as `mcp__<server>__<tool>` callable from codemode scripts (Pi's opt-in `+codemode`) */
    codemode: z.boolean(),
    disableProxyTool: z.boolean(),
    notifyOnStartupConnect: z.boolean(),
  })
  .partial();
type Settings = z.infer<typeof Settings>;
const ConfigFile = z.looseObject({
  settings: Settings.optional(),
  mcpServers: z.record(z.string(), Entry).default({}),
});

/** Lowest precedence first: shared user-global files, hortus's own, then the project's (trusted per server). */
const globalFiles = () => [
  join(homedir(), ".config", "mcp", "mcp.json"),
  join(homedir(), ".agents", "mcp.json"),
  join(hortusDir(), "mcp.json"),
  join(hortusDir(), "mcp-adapter.json"),
];
const projectFiles = (cwd: string) => [
  join(cwd, ".mcp.json"),
  join(cwd, ".hortus", "mcp.json"),
  join(cwd, ".hortus", "mcp-adapter.json"),
];
/** where `/mcp-adapter disable|enable` and URL installs write */
const projectOverrides = (cwd: string) => join(cwd, ".hortus", "mcp-adapter.json");
const globalAdapterFile = () => join(hortusDir(), "mcp-adapter.json");
const cachePath = () => join(hortusDir(), "mcp-cache.json");

/** fields that only switch a server, so a project file setting just them isn't asked about */
const SWITCHES = new Set(["disabled", "enabled"]);
const CREDENTIALS = ["headers", "auth", "oauth", "bearerToken", "bearerTokenEnv"];

// ponytail: plain JSON (Pi reads JSONC); strip comments if users ask
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^﻿/, ""));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

async function writeJson(path: string, value: unknown, mode?: number) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : {});
  await rename(tmp, path);
}

interface Source {
  entry: Entry;
  /** the file (or `mcp_servers`) that last defined or changed it */
  source: string;
  /** defined or changed by a project file: needs trust */
  project: boolean;
}

/** One entry over another: field by field, except that a changed `url` leaves the lower entry's credentials behind. */
function merge(lower: Entry | undefined, upper: Entry): Entry {
  if (!lower) return upper;
  const base: Record<string, unknown> = { ...lower };
  if (upper.url && lower.url && upper.url !== lower.url) for (const k of CREDENTIALS) delete base[k];
  if (upper.command) delete base.url;
  if (upper.url) delete base.command;
  return { ...base, ...upper } as Entry;
}

interface Loaded {
  settings: Settings;
  /** settings from user-global files only (project files can't set `projectServers`) */
  global: Settings;
  entries: Map<string, Source>;
  errors: string[];
}

async function loadConfig(cwd: string, fromPlugins: Record<string, unknown>): Promise<Loaded> {
  const errors: string[] = [];
  const entries = new Map<string, Source>();
  for (const [name, e] of Object.entries(fromPlugins)) {
    const p = Entry.safeParse(e);
    if (p.success) entries.set(name, { entry: p.data, source: "mcp_servers", project: false });
    else errors.push(`mcp_servers: ${name}: ${p.error.message}`);
  }
  const settings: Settings = {};
  let global: Settings = {};
  const apply = async (path: string, project: boolean) => {
    let file: z.infer<typeof ConfigFile> | undefined;
    try {
      const raw = await readJson(path);
      if (raw === undefined) return;
      file = ConfigFile.parse(raw);
    } catch (e) {
      errors.push(`${path}: ${message(e)}`);
      return;
    }
    const { projectServers: _, ...s } = file.settings ?? {};
    Object.assign(settings, project ? s : file.settings);
    for (const [name, e] of Object.entries(file.mcpServers)) {
      const prev = entries.get(name);
      const switchOnly = Object.keys(e).every((k) => SWITCHES.has(k));
      entries.set(name, {
        entry: merge(prev?.entry, e),
        source: switchOnly && prev ? prev.source : path,
        project: (prev?.project ?? false) || (project && !switchOnly),
      });
    }
  };
  for (const path of globalFiles()) await apply(path, false);
  global = { ...settings };
  for (const path of projectFiles(cwd)) await apply(path, true);
  return { settings, global, entries, errors };
}

/** `${VAR}` (core's `expandEnv`) plus `${VAR:-default}`, as Claude Code's `.mcp.json` has it */
const expand = (v: string) =>
  expandEnv(v.replace(/\$\{(\w+):-([^}]*)\}/g, (_, n: string, d: string) => process.env[n] || d));
const expandAll = (values: Record<string, string> = {}) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, expand(v)]));

const transportOf = (e: Entry) => (e.command ? "stdio" : (e.type ?? e.transport) === "sse" ? "sse" : "http");
const lifecycleOf = (e: Entry) => e.lifecycle ?? "lazy";
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** what makes a server the same server: its cache and trust are tied to it */
const identity = (e: Entry) =>
  hash([e.command, e.args, e.env, e.cwd, e.url, e.headers, e.type ?? e.transport, e.exposeResources]);

// ── Runtime state ─────────────────────────────────────────────────────────────

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}
interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}
interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}
/** what a server offers, live or from the cache */
interface Meta {
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
  instructions?: string;
}

interface Server {
  name: string;
  entry: Entry;
  source: string;
  project: boolean;
  hash: string;
  state: "stopped" | "connecting" | "ready" | "failed" | "disabled" | "blocked";
  /** a blocked project server was asked about (and refused) this session */
  refused?: boolean;
  client?: Client;
  connecting?: Promise<Client>;
  error?: string;
  stderr: string;
  meta?: Meta;
  inflight: number;
  lastUsed: number;
  /** the tool calls running on it: elicitation and sampling ask and complete through the latest one's ctx */
  callers: ToolCtx[];
  retries: number;
  retry?: NodeJS.Timeout;
}

/** One MCP tool or resource as hortus sees it. */
interface Item {
  server: Server;
  /** the server's name for it (a resource's tool: `read_<resource>`) */
  name: string;
  tool?: McpTool;
  resource?: McpResource;
  /** `<prefix>_<tool>`: its name as a direct tool */
  direct: string;
  /** `mcp__<server>__<tool>`: its name for codemode scripts */
  deferred: string;
  mode: "direct" | "search" | "proxy";
  directTool?: Tool;
  deferredTool?: Tool;
}

interface State {
  /** this plugin's host ctx, from `ready` */
  ctx: Ctx;
  settings: Settings;
  global: Settings;
  servers: Map<string, Server>;
  items: Item[];
  byName: Map<string, Item>;
  /** the tools pushed into the agent's tools (host `ctx.tools`) */
  surface: Tool[];
  /** stable names: `<server>\0<kind>\0<tool>` → name */
  names: Map<string, string>;
  /** "Allow server for this session" grants: `<server>\0<hash>`, cleared with the session */
  serverGrants: Set<string>;
  ready: Promise<void>;
  cacheQueue: Promise<void>;
  idle?: NodeJS.Timeout;
  binDir?: string;
  closed: boolean;
}

/** Session data (`state.data[plugin]`), rebuilt from this plugin's entries on replay and branch. */
interface Data {
  /** "Allow for session" grants: hashes of server, tool definition and arguments */
  approvals: string[];
  /** search-mode direct tools activated by a search or a call */
  activated: string[];
}
const dataOf = (s: SessionState, plugin: string): Data =>
  (s.data[plugin] as Data | undefined) ?? { approvals: [], activated: [] };
const sessionData = (ctx: Ctx): Data =>
  ctx.session ? dataOf(ctx.session.getState(), ctx.plugin) : { approvals: [], activated: [] };

const stateIn = (ctx: Ctx) => pluginState(ctx, "box", (): { st?: State } => ({}));
function stateOf(ctx: Ctx): State {
  const { st } = stateIn(ctx);
  if (!st) throw new Error(`${NAME} hasn't started`);
  return st;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const enabled = (s: Server) => s.state !== "disabled" && s.state !== "blocked";
const timeoutOf = (st: State, s: Server) => {
  const t = s.entry.requestTimeoutMs ?? st.settings.requestTimeoutMs;
  return t && t > 0 ? t : undefined;
};
const idleMs = (st: State, s: Server) => {
  const lc = lifecycleOf(s.entry);
  if (lc === "keep-alive" || lc === "lazy-keep-alive") return 0;
  return (s.entry.idleTimeout ?? (lc === "eager" ? 0 : (st.settings.idleTimeout ?? DEFAULT_IDLE_MIN))) * 60_000;
};
const glob = (p: string) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
const matches = (patterns: string[], ...names: string[]) => patterns.some((p) => names.some((n) => glob(p).test(n)));

function status(st: State) {
  const all = [...st.servers.values()].filter(enabled);
  const ready = all.filter((s) => s.client).length;
  void st.ctx.status(NAME, all.length ? `MCP: ${ready}/${all.length} servers` : undefined);
}

// ── Metadata cache ────────────────────────────────────────────────────────────

interface CacheEntry extends Partial<Meta> {
  hash: string;
  savedAt: number;
  /** discovery failed for this config: not retried at startup until it changes or the server connects */
  failed?: boolean;
}
interface CacheFile {
  version: 1;
  servers: Record<string, CacheEntry>;
}

async function readCache(): Promise<CacheFile> {
  try {
    const c = (await readJson(cachePath())) as CacheFile | undefined;
    if (c?.version === 1 && c.servers) return c;
  } catch {
    // a corrupt cache is rebuilt
  }
  return { version: 1, servers: {} };
}

/** Saves `s`'s metadata (or its failure) in the cache file; writes are queued, so concurrent connects don't race. */
function saveCache(st: State, s: Server, failed = false) {
  st.cacheQueue = st.cacheQueue
    .then(async () => {
      const c = await readCache();
      c.servers[s.name] = { hash: s.hash, savedAt: Date.now(), ...(failed ? { failed } : s.meta) };
      await writeJson(cachePath(), c);
    })
    .catch((e) => void st.ctx.notify(`${NAME}: can't write ${cachePath()}: ${message(e)}`, "warn"));
  return st.cacheQueue;
}

// ── Tool surface ──────────────────────────────────────────────────────────────

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
function prefixOf(server: string, mode: z.infer<typeof Prefix>) {
  if (mode === "none") return "";
  if (mode === "short") return sanitize(server.replace(/-?mcp$/i, "")) || "mcp";
  if (mode === "mcp") return `mcp__${sanitize(server)}`;
  return sanitize(server);
}
const resourceToolName = (name: string) => {
  const r = name
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  return `read_${!r || /^\d/.test(r) ? `resource${r ? `_${r}` : ""}` : r}`;
};

/**
 * A provider-safe name for `key`, kept for the agent's life (a name never moves to another tool): over 64 characters, or
 * taken, it ends in an 8-character hash.
 */
function nameFor(st: State, key: string, wanted: string, taken: Set<string>) {
  const known = st.names.get(key);
  if (known) return known;
  let n = sanitize(wanted);
  if (n.length > MAX_NAME || taken.has(n)) n = `${n.slice(0, MAX_NAME - 9)}_${hash(key).slice(0, 8)}`;
  st.names.set(key, n);
  taken.add(n);
  return n;
}

function itemsOf(st: State, s: Server, taken: Set<string>): Item[] {
  const meta = s.meta;
  if (!meta) return [];
  const e = s.entry;
  const prefix = prefixOf(s.name, e.toolPrefix ?? st.settings.toolPrefix ?? "server");
  const join = (n: string) => (prefix ? `${prefix}_${n}` : n);
  const dt = e.directTools ?? st.settings.directTools ?? false;
  const list: { name: string; tool?: McpTool; resource?: McpResource }[] = [
    ...meta.tools.map((t) => ({ name: t.name, tool: t })),
    ...((e.exposeResources ?? st.settings.exposeResources) === false
      ? []
      : meta.resources.map((r) => ({ name: resourceToolName(r.name), resource: r }))),
  ];
  return list
    .filter(({ name }) => {
      const direct = join(name);
      if (e.includeTools && !matches(e.includeTools, name, direct)) return false;
      return !(e.excludeTools && matches(e.excludeTools, name, direct));
    })
    .map((x) => {
      const key = `${s.name}\0${x.resource ? "r" : "t"}\0${x.name}`;
      const direct = nameFor(st, `${key}\0direct`, join(x.name), taken);
      const deferred = nameFor(st, `${key}\0deferred`, mcpToolName(s.name, x.name), taken);
      const mode =
        dt === true || (Array.isArray(dt) && dt.includes(x.name)) ? "direct" : dt === "search" ? "search" : "proxy";
      return { server: s, ...x, direct, deferred, mode };
    });
}

const hintsOf = (t?: McpTool) =>
  [
    t?.annotations?.readOnlyHint && "read-only",
    t?.annotations?.destructiveHint && "destructive",
    t?.annotations?.idempotentHint && "idempotent",
    t?.annotations?.openWorldHint && "open-world",
  ].filter(Boolean) as string[];
const descriptionOf = (it: Item) =>
  it.resource
    ? `Read the MCP resource ${it.resource.uri}${it.resource.description ? `: ${it.resource.description}` : ""}`
    : (it.tool?.description ?? `MCP tool ${it.name}`);
const schemaOf = (it: Item): Record<string, unknown> =>
  it.tool?.inputSchema ?? { type: "object", properties: {}, additionalProperties: false };

/** `it` as a hortus tool: declared (`direct`) or for codemode scripts only, under the matching name. */
function toolOf(st: State, it: Item, exposure: "direct" | "codemode"): Tool {
  const key = exposure === "direct" ? "directTool" : "deferredTool";
  it[key] ??= {
    name: exposure === "direct" ? it.direct : it.deferred,
    description: descriptionOf(it),
    // declared as the server's schema, as is; the server validates the input
    inputSchema: z.looseObject({}),
    jsonSchema: schemaOf(it),
    exposure,
    plugin: st.ctx.plugin,
    meta: {
      mcp: { server: it.server.name, tool: it.name, ...(it.tool?.annotations && { annotations: it.tool.annotations }) },
    },
    execute: (input: Record<string, unknown>, ctx: ToolCtx) => callItem(st, it, input, ctx),
  } as Tool;
  return it[key];
}

/**
 * Rebuilds the items from every server's metadata, and swaps them in the agent's tools (host `ctx.tools`): direct-mode
 * tools declared, every tool as `mcp__<server>__<tool>` for codemode scripts when `settings.codemode` is on.
 */
function rebuild(st: State) {
  const others = new Set(st.ctx.tools.filter((t) => !st.surface.includes(t)).map((t) => t.name));
  const taken = new Set([...others, ...st.names.values()]);
  const old = new Map(st.items.map((it) => [`${it.server.name}\0${it.direct}`, it]));
  st.items = [...st.servers.values()]
    .filter(enabled)
    .flatMap((s) => itemsOf(st, s, taken))
    .map((it) => {
      // keep the Tool objects of an item whose definition didn't change, so runs holding them stay valid
      const prev = old.get(`${it.server.name}\0${it.direct}`);
      const same = (a: Item) => JSON.stringify([a.tool, a.resource, a.mode]);
      return prev && same(prev) === same(it) ? prev : it;
    });
  st.byName = new Map(st.items.flatMap((it) => [[it.direct, it] as const, [it.deferred, it] as const]));
  for (let i = st.ctx.tools.length - 1; i >= 0; i--)
    if (st.surface.includes(st.ctx.tools[i] as Tool)) st.ctx.tools.splice(i, 1);
  st.surface = st.items.flatMap((it) => [
    ...(it.mode === "direct" ? [toolOf(st, it, "direct")] : []),
    ...(st.settings.codemode ? [toolOf(st, it, "codemode")] : []),
  ]);
  st.ctx.tools.push(...st.surface);
}

/** Search-mode tools become declared for the rest of the session (an entry), from the run's next request on. */
async function activate(st: State, ctx: Ctx, items: Item[]): Promise<string[]> {
  const active = new Set(sessionData(ctx).activated);
  const added = items.filter((it) => it.mode === "search" && !active.has(it.direct));
  if (!added.length) return [];
  const names = added.map((it) => it.direct);
  await ctx.session?.appendEntry(`${ctx.plugin}:activate`, { names });
  if (ctx.run)
    for (const it of added) if (!ctx.tools.some((t) => t.name === it.direct)) ctx.tools.push(toolOf(st, it, "direct"));
  return names;
}

// ── Connections ───────────────────────────────────────────────────────────────

function transport(st: State, s: Server) {
  const e = s.entry;
  if (transportOf(e) === "stdio") {
    const t = new StdioClientTransport({
      command: e.command as string,
      args: e.args?.map(expand),
      env: e.env && { ...(process.env as Record<string, string>), ...expandAll(e.env) },
      cwd: e.cwd && resolve(st.ctx.cwd, expand(e.cwd).replace(/^~(?=$|\/)/, homedir())),
      // piped, not inherited, so a server's logs don't draw over the TUI
      stderr: "pipe",
    });
    t.stderr?.on("data", (d: Buffer) => {
      s.stderr = (s.stderr + d.toString()).slice(-4000);
    });
    return t;
  }
  const url = new URL(expand(e.url as string));
  const opts = { requestInit: { headers: expandAll(e.headers) } };
  return transportOf(e) === "sse" ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts);
}

async function discover(client: Client, timeout?: number): Promise<Meta> {
  const caps = client.getServerCapabilities() ?? {};
  const meta: Meta = { tools: [], resources: [], prompts: [], instructions: client.getInstructions() };
  let cursor: string | undefined;
  do {
    const page = await client.listTools({ cursor }, { timeout });
    meta.tools.push(...(page.tools as McpTool[]));
    cursor = page.nextCursor;
  } while (cursor);
  if (caps.resources)
    do {
      const page = await client.listResources({ cursor }, { timeout });
      meta.resources.push(...page.resources);
      cursor = page.nextCursor;
    } while (cursor);
  if (caps.prompts)
    do {
      const page = await client.listPrompts({ cursor }, { timeout });
      meta.prompts.push(...page.prompts);
      cursor = page.nextCursor;
    } while (cursor);
  return meta;
}

/** `s`'s client, connecting it (lazily, or again after an idle stop) first; joins a connect going on. */
function connect(st: State, s: Server): Promise<Client> {
  if (s.client) return Promise.resolve(s.client);
  if (s.state === "disabled") return Promise.reject(new Error(`MCP server ${s.name} is disabled`));
  if (s.state === "blocked")
    return Promise.reject(
      new Error(
        `MCP server ${s.name} comes from a project file that ${
          st.ctx.host.ui && !st.ctx.host.interactive ? "isn't trusted yet (you'll be asked)" : "wasn't trusted"
        }`,
      ),
    );
  s.connecting ??= open(st, s).finally(() => {
    s.connecting = undefined;
  });
  return s.connecting;
}

async function open(st: State, s: Server): Promise<Client> {
  clearTimeout(s.retry);
  s.state = "connecting";
  status(st);
  const e = s.entry;
  const timeout = timeoutOf(st, s);
  const client = new Client(
    { name: "hortus-mcp-adapter", version: "0.1.0" },
    {
      capabilities: {
        ...(e.roots !== false && { roots: { listChanged: false } }),
        ...(st.settings.elicitation !== false && { elicitation: { form: {} } }),
        ...(st.settings.sampling !== false && { sampling: {} }),
      },
      listChanged: {
        tools: {
          onChanged: (err, tools) => {
            if (err || !tools || s.client !== client || !s.meta) return;
            s.meta = { ...s.meta, tools: tools as McpTool[] };
            void saveCache(st, s);
            rebuild(st);
          },
        },
      },
    },
  );
  if (e.roots !== false)
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(st.ctx.cwd).href, name: st.ctx.cwd }],
    }));
  client.setRequestHandler(ElicitRequestSchema, (req, extra) => elicit(st, s, req.params, extra.signal));
  client.setRequestHandler(CreateMessageRequestSchema, (req, extra) => sample(st, s, req.params, extra.signal));
  try {
    await client.connect(transport(st, s), { timeout });
    const meta = await discover(client, timeout);
    if (st.closed) throw new Error("closed");
    s.client = client;
    s.meta = meta;
    s.state = "ready";
    s.error = undefined;
    s.retries = 0;
    s.lastUsed = Date.now();
    client.onclose = () => {
      if (s.client === client) dropped(st, s);
    };
    void saveCache(st, s);
    rebuild(st);
    status(st);
    return client;
  } catch (err) {
    await client.close().catch(() => {});
    if (st.closed) throw err;
    s.state = "failed";
    s.error = message(err);
    status(st);
    throw new Error(
      `${s.name}: ${s.error}${s.stderr.trim() ? `\n${s.stderr.trim().split("\n").slice(-5).join("\n")}` : ""}`,
    );
  }
}

/** The connection went away on its own: keep-alive servers reconnect with backoff, others start on their next call. */
function dropped(st: State, s: Server) {
  s.client = undefined;
  s.state = "stopped";
  status(st);
  const lc = lifecycleOf(s.entry);
  if (st.closed || (lc !== "keep-alive" && lc !== "lazy-keep-alive")) return;
  const delay = KEEPALIVE_DELAYS[Math.min(s.retries++, KEEPALIVE_DELAYS.length - 1)];
  s.retry = setTimeout(() => connect(st, s).catch(() => dropped(st, s)), delay).unref();
}

async function stop(st: State, s: Server) {
  clearTimeout(s.retry);
  const client = s.client;
  s.client = undefined;
  if (s.state === "ready" || s.state === "connecting") s.state = "stopped";
  status(st);
  await client?.close().catch(() => {});
}

/** Stops idle servers (none with a call running); runs every 30 s, or as often as the shortest timeout. */
function startIdleTimer(st: State) {
  clearInterval(st.idle);
  const timeouts = [...st.servers.values()].map((s) => idleMs(st, s)).filter((t) => t > 0);
  if (!timeouts.length) return;
  st.idle = setInterval(
    () => {
      for (const s of st.servers.values()) {
        const t = idleMs(st, s);
        if (s.client && t > 0 && !s.inflight && Date.now() - s.lastUsed >= t) void stop(st, s);
      }
    },
    Math.min(30_000, ...timeouts),
  ).unref();
}

// ── Calls ─────────────────────────────────────────────────────────────────────

/** What a call returns to `ctx.runTool` callers (codemode scripts get it as is): MCP's `CallToolResult`. */
interface CallResult {
  content: Block[];
  structuredContent?: unknown;
  isError?: boolean;
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
const isCallResult = (v: unknown): v is CallResult => Array.isArray((v as CallResult | undefined)?.content);
const errorResult = (text: string): CallResult => ({ content: [{ type: "text", text }], isError: true });

/** Progress a running MCP call reports (`ctx.update`), drawn under its block in the TUI. */
export interface McpProgress {
  mcpProgress: string;
}

/** Runs `it` on its server: approval, lazy connect, progress, cancellation; failures come back as `isError` results. */
async function callItem(st: State, it: Item, args: Record<string, unknown>, ctx: ToolCtx): Promise<CallResult> {
  const s = it.server;
  const blocked = await approve(st, it, args, ctx);
  if (blocked) return blocked;
  s.inflight++;
  s.callers.push(ctx);
  try {
    const client = await connect(st, s);
    const timeout = timeoutOf(st, s);
    if (it.resource) {
      const r = await client.readResource({ uri: it.resource.uri }, { signal: ctx.signal, timeout });
      return { content: r.contents.map((c) => ({ type: "resource", resource: c as Block })) };
    }
    let last: string | undefined;
    return (await client.callTool({ name: it.name, arguments: args }, undefined, {
      signal: ctx.signal,
      timeout,
      // every progress notification restarts the timeout: a tool that keeps reporting isn't cut off
      resetTimeoutOnProgress: true,
      onprogress: (p) => {
        const text =
          p.message?.trim().slice(0, 200) || `Progress ${p.progress}${p.total === undefined ? "" : `/${p.total}`}`;
        if (text === last) return;
        last = text;
        ctx.update({ mcpProgress: text } satisfies McpProgress);
      },
    })) as CallResult;
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    return errorResult(message(e));
  } finally {
    s.inflight--;
    s.lastUsed = Date.now();
    s.callers.splice(s.callers.indexOf(ctx), 1);
  }
}

function needsApproval(st: State, it: Item) {
  const v = it.server.entry.approveTools ?? st.settings.approveTools;
  if (v === undefined || v === false) return false;
  if (v === true) return true;
  if (v === "destructive") {
    // resource reads are never gated by this value
    if (it.resource) return false;
    const a = it.tool?.annotations;
    return !(a?.readOnlyHint === true || a?.destructiveHint === false);
  }
  return matches(v, it.name, it.direct);
}

/** Asks before a gated call (`kind: "mcp-adapter:approval"`, so a broker plugin can answer); a block's result, or none. */
async function approve(st: State, it: Item, args: unknown, ctx: ToolCtx): Promise<CallResult | undefined> {
  if (!needsApproval(st, it)) return undefined;
  const s = it.server;
  const grant = `${s.name}\0${s.hash}`;
  if (st.serverGrants.has(grant)) return undefined;
  // never the raw arguments: only their hash, with the tool's definition, is saved
  const key = hash([s.name, it.name, it.tool ?? it.resource, args]);
  if (sessionData(ctx).approvals.includes(key)) return undefined;
  const a = it.tool?.annotations;
  const hint = a?.destructiveHint
    ? "\n\nThe server marks this tool as destructive: it may delete or overwrite data."
    : a?.readOnlyHint
      ? "\n\nThe server marks this tool as read-only."
      : "";
  const preview = JSON.stringify(args ?? {}, null, 2);
  const r = await ctx.ask(
    {
      kind: "mcp-adapter:approval",
      question: `MCP: ${s.name} wants to run ${it.name}${hint}\n\nArguments:\n${preview.length > 500 ? `${preview.slice(0, 500)}...` : preview}`,
      options: [
        { label: "Allow once" },
        { label: "Allow for session", description: "this tool with these arguments" },
        { label: "Allow server for this session", description: "every tool of this server, until the session changes" },
        { label: "Deny" },
      ],
      data: { server: s.name, tool: it.name, args },
    },
    { detailed: true },
  );
  if (r.answer === "Allow once") return undefined;
  if (r.answer === "Allow server for this session") {
    st.serverGrants.add(grant);
    return undefined;
  }
  if (r.answer === "Allow for session") {
    await ctx.session?.appendEntry(`${ctx.plugin}:approval`, { key });
    return undefined;
  }
  if (r.reason === "unanswered")
    return errorResult(
      `MCP tool "${it.name}" on server "${s.name}" is approval-gated and requires an interactive session.`,
    );
  const base = `MCP tool "${it.name}" on server "${s.name}" was blocked by the approval gate; it was not executed.`;
  return errorResult(r.answer === "Deny" ? `${base}\nReason: The user denied it in the approval dialog.` : base);
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_BLOB = 10 * 1024 * 1024;

/** A result as the model gets it: its text (structured content appended unless the server opts out) and images. */
async function forModel(st: State, s: Server | undefined, r: CallResult) {
  const texts: string[] = [];
  const images: Image[] = [];
  const blob = async (b: Block) => {
    if (b.text !== undefined) return void texts.push(b.text);
    const data = b.blob ?? b.data ?? "";
    if (IMAGE_TYPES.includes(b.mimeType ?? "")) {
      images.push({ type: "image", mediaType: b.mimeType as Image["mediaType"], data });
      return;
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > MAX_BLOB)
      return void texts.push(
        `[Binary resource: ${b.uri} (${b.mimeType ?? "unknown"}, ${bytes.length} bytes, too large)]`,
      );
    st.binDir ??= await mkdtemp(join(tmpdir(), "mcp-adapter-"));
    const path = join(st.binDir, `${randomUUID()}.bin`);
    await writeFile(path, bytes, { mode: 0o600 });
    texts.push(`[Binary resource: ${b.uri} (${b.mimeType ?? "unknown"}, ${bytes.length} bytes) saved to ${path}]`);
  };
  for (const c of r.content) {
    if (c.type === "text") texts.push(c.text ?? "");
    else if (c.type === "image") await blob({ ...c, uri: "image" });
    else if (c.type === "audio") texts.push(`[Audio: ${c.mimeType ?? "unknown"}, base64 encoded]`);
    else if (c.type === "resource") await blob(c.resource ?? {});
    else if (c.type === "resource_link")
      texts.push(
        `[Resource link: ${c.uri}${c.name ? ` "${c.title ?? c.name}"` : ""}${c.mimeType ? ` (${c.mimeType})` : ""}]`,
      );
    else texts.push(JSON.stringify(c));
  }
  if (r.structuredContent !== undefined && (s?.entry.appendStructuredContent !== false || !texts.length))
    texts.push(JSON.stringify(r.structuredContent, null, 2));
  return { output: texts.join("\n") || (r.isError ? "MCP tool failed" : "(no output)"), images };
}

/** Oversized text going to the model: a head preview, the whole text in a private temp file it can read. */
async function guard(st: State, result: ToolResult) {
  const g = st.settings.outputGuard;
  if (g === false || process.env.MCP_OUTPUT_GUARD === "0") return;
  const maxBytes = (typeof g === "object" && g.maxBytes) || 51_200;
  const maxLines = (typeof g === "object" && g.maxLines) || 2000;
  const text = result.output;
  const lines = text.split("\n");
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes && lines.length <= maxLines) return;
  const path = join(tmpdir(), `mcp-output-${randomUUID()}.txt`);
  // ponytail: spill files aren't cleaned up (as in Pi); a per-agent dir removed at close if they pile up
  await writeFile(path, text, { mode: 0o600 });
  const head = Buffer.from(lines.slice(0, maxLines).join("\n")).subarray(0, maxBytes).toString();
  result.output = `${head}\n\n[Output truncated: ${lines.length} lines, ${bytes} bytes. Full output saved to ${path}]`;
}

// ── Elicitation and sampling ──────────────────────────────────────────────────

/** the ctx a server's request acts through: its latest running call's (its run's dialogs and abort), else the host's */
const callerOf = (st: State, s: Server): Ctx => s.callers.at(-1) ?? st.ctx;

interface Field {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  enumNames?: string[];
  oneOf?: { const: string; title?: string }[];
  default?: unknown;
}

/**
 * A form elicitation through `ctx.ask`: one question per field, then a review (Submit / Decline); the server
 * cancelling the request (`signal`) withdraws the question on screen.
 */
async function elicit(st: State, s: Server, p: ElicitRequest["params"], signal: AbortSignal) {
  if (p.mode === "url" || !("requestedSchema" in p)) return { action: "decline" as const };
  const ctx = callerOf(st, s);
  const schema = p.requestedSchema as { properties: Record<string, Field>; required?: string[] };
  const content: Record<string, string | number | boolean> = {};
  for (const [key, f] of Object.entries(schema.properties)) {
    const required = schema.required?.includes(key);
    const question = `${s.name}: ${p.message}\n\n${f.title ?? key}${f.description ? ` — ${f.description}` : ""}${required ? "" : " (optional)"}`;
    const choices = f.type === "boolean" ? ["Yes", "No"] : (f.oneOf?.map((o) => o.const) ?? f.enum);
    for (;;) {
      const a = await ctx.ask(
        { question, ...(choices && { options: choices.map((label) => ({ label })) }), allowText: !choices },
        { signal },
      );
      if (a === undefined || Array.isArray(a)) return { action: "cancel" as const };
      if (a === "" && !required) break;
      if (f.type === "boolean") content[key] = a === "Yes";
      else if (f.type === "number" || f.type === "integer") {
        const n = Number(a);
        if (a === "" || Number.isNaN(n) || (f.type === "integer" && !Number.isInteger(n))) continue;
        content[key] = n;
      } else if (a === "" && required) continue;
      else content[key] = a;
      break;
    }
  }
  const review = await ctx.ask(
    {
      question: `${s.name}: ${p.message}${Object.keys(content).length ? `\n\n${JSON.stringify(content, null, 2)}` : ""}`,
      options: [{ label: "Submit" }, { label: "Decline" }],
    },
    { signal },
  );
  if (review === "Submit") return { action: "accept" as const, content };
  return { action: review === "Decline" ? ("decline" as const) : ("cancel" as const) };
}

/** `sampling/createMessage` through `ctx.complete`, after approval; text only, as in Pi. */
async function sample(st: State, s: Server, p: CreateMessageRequest["params"], signal: AbortSignal) {
  if (st.settings.sampling === false) throw new Error("MCP sampling is disabled");
  if (p.includeContext && p.includeContext !== "none")
    throw new Error("MCP sampling context inclusion is not supported");
  if (p.tools?.length) throw new Error("MCP sampling tool use is not supported");
  if (p.stopSequences?.length) throw new Error("MCP sampling stop sequences are not supported");
  const ctx = callerOf(st, s);
  const messages: Message[] = p.messages.map((m) => {
    const c = Array.isArray(m.content) ? m.content : [m.content];
    if (c.some((x) => x.type !== "text")) throw new Error("MCP sampling supports text content only");
    const text = c.map((x) => (x as { text: string }).text).join("\n");
    return m.role === "user" ? { role: "user", content: text } : { role: "assistant", text, toolCalls: [] };
  });
  // the first model whose id contains a hint, else the run's (or config's)
  const hints = p.modelPreferences?.hints?.flatMap((h) => (h.name ? [h.name] : [])) ?? [];
  const models = hints.length ? await ctx.listModels().catch(() => []) : [];
  const hinted = hints.map((h) => models.find((m) => m.id.includes(h))).find(Boolean);
  const target = hinted ? { provider: hinted.provider, model: hinted.id } : await ctx.resolve();
  if (!st.settings.samplingAutoApprove) {
    const preview = messages
      .map((m) => (m.role === "user" ? m.content : m.role === "assistant" ? m.text : ""))
      .join("\n");
    const a = await ctx.ask(
      {
        question: `MCP server "${s.name}" wants a completion from ${target.provider}/${target.model}${p.systemPrompt ? `\n\nSystem: ${p.systemPrompt.slice(0, 300)}` : ""}\n\n${preview.slice(0, 800)}`,
        options: [{ label: "Allow" }, { label: "Deny" }],
      },
      { signal },
    );
    if (a !== "Allow") throw new Error("MCP sampling request was declined");
  }
  const r = await ctx.complete({
    ...(p.systemPrompt && { system: p.systemPrompt }),
    messages,
    provider: target.provider,
    model: target.model,
    maxTokens: p.maxTokens,
    ...(p.temperature !== undefined && { temperature: p.temperature }),
    signal,
  });
  return {
    role: "assistant" as const,
    content: { type: "text" as const, text: r.text },
    model: target.model,
    stopReason: "endTurn",
  };
}

// ── Startup and trust ─────────────────────────────────────────────────────────

/**
 * Project servers run only once the project is trusted (`ctx.trust`, asked when a person can answer) or with
 * `settings.projectServers: "allow"` (user-global files only).
 */
async function trust(st: State, ctx: Ctx) {
  const pending = [...st.servers.values()].filter((s) => s.state === "blocked" && !s.refused);
  if (!pending.length) return [];
  if (st.global.projectServers !== "allow") {
    const list = pending
      .map((s) => `${s.name}: ${s.entry.command ? [s.entry.command, ...(s.entry.args ?? [])].join(" ") : s.entry.url}`)
      .join("; ");
    if (!(await ctx.trust(ctx.cwd, { reason: `(its MCP servers can run commands on this machine: ${list})` }))) {
      // refused by a person; else asked again at `interactive`
      if (ctx.host.interactive) for (const s of pending) s.refused = true;
      return [];
    }
  }
  for (const s of pending) s.state = s.entry.disabled === true || s.entry.enabled === false ? "disabled" : "stopped";
  return pending;
}

/** Connects eager and keep-alive servers, and reads the tools of lazy ones the cache doesn't know (then stops them). */
async function warm(st: State, servers: Server[], failed: Set<string>) {
  let connected = 0;
  await Promise.all(
    servers.filter(enabled).map(async (s) => {
      const lc = lifecycleOf(s.entry);
      const eager = lc === "eager" || lc === "keep-alive";
      if (!eager && (s.meta || failed.has(s.name))) return;
      try {
        await connect(st, s);
        if (eager) connected++;
        else if (lc === "lazy" && idleMs(st, s) > 0 && !s.inflight) await stop(st, s);
      } catch (e) {
        if (!eager) await saveCache(st, s, true);
        void st.ctx.notify(`${NAME}: Failed to start ${message(e)}`, "error");
        if (lc === "keep-alive") dropped(st, s);
      }
    }),
  );
  const tools = st.items.filter((it) => it.server.client).length;
  if (connected && st.settings.notifyOnStartupConnect !== false)
    void st.ctx.notify(`MCP: ${connected} server${connected > 1 ? "s" : ""} connected (${tools} tools)`);
}

async function start(st: State, ctx: Ctx) {
  const fromPlugins = { servers: {} };
  await ctx.emit("mcp_servers", fromPlugins);
  const cfg = await loadConfig(ctx.cwd, fromPlugins.servers);
  for (const e of cfg.errors) void ctx.notify(`${NAME}: Config error — ${e}`, "error");
  st.settings = cfg.settings;
  st.global = cfg.global;
  const cache = await readCache();
  const failed = new Set<string>();
  for (const [name, { entry, source, project }] of cfg.entries) {
    const h = identity(entry);
    const c = cache.servers[name];
    if (c?.hash === h && c.failed) failed.add(name);
    let state: Server["state"] = entry.disabled === true || entry.enabled === false ? "disabled" : "stopped";
    if (state === "stopped" && (entry.auth !== undefined || entry.oauth !== undefined)) {
      void ctx.notify(`${NAME}: ${name}: OAuth is not supported by this port; use static headers`, "error");
      state = "disabled";
    } else if (state === "stopped" && !entry.command && !entry.url) {
      void ctx.notify(`${NAME}: Config error — ${source}: ${name}: command or url is required`, "error");
      state = "disabled";
    }
    st.servers.set(name, {
      name,
      entry,
      source,
      project,
      hash: h,
      state: project && state === "stopped" ? "blocked" : state,
      stderr: "",
      ...(c?.hash === h && !c.failed && { meta: { tools: [], resources: [], prompts: [], ...c } }),
      inflight: 0,
      lastUsed: Date.now(),
      callers: [],
      retries: 0,
    });
  }
  await trust(st, ctx);
  rebuild(st);
  status(st);
  startIdleTimer(st);
  await warm(st, [...st.servers.values()], failed);
}

// ── Inspection ────────────────────────────────────────────────────────────────

function server(st: State, name: string): Server {
  const s = st.servers.get(name);
  if (!s) throw new Error(`No MCP server named "${name}". Use mcp({}) (or /mcp-adapter) to list configured servers.`);
  return s;
}

const norm = (n: string) => n.toLowerCase().replace(/-/g, "_");
/** `name` (direct, `mcp__` or the server's own name; hyphens and underscores alike) on `serverName`, else suggestions */
function find(st: State, name: string, serverName?: string): Item | string[] {
  const pool = st.items.filter((it) => !serverName || it.server.name === serverName);
  const n = norm(name);
  const hit = pool.find((it) =>
    [it.direct, it.deferred, it.name, `${it.server.name}_${it.name}`].some((x) => norm(x) === n),
  );
  if (hit) return hit;
  const words = n.split(/[_\s]+/).filter((w) => w.length > 2);
  return pool
    .map((it) => ({ it, score: words.filter((w) => norm(it.direct).includes(w)).length }))
    .filter((x) => x.score)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.it.direct);
}

/** top-level parameter names, required first; none when the schema can add parameters a list would miss */
function params(schema: Record<string, unknown>) {
  if (["$ref", "allOf", "anyOf", "oneOf", "not", "if", "dependentRequired"].some((k) => k in schema)) return "";
  const props = Object.keys((schema.properties as object | undefined) ?? {});
  const req = new Set((schema.required as string[] | undefined) ?? []);
  return `(${[...props.filter((p) => req.has(p)), ...props.filter((p) => !req.has(p)).map((p) => `${p}?`)].join(", ")})`;
}

const firstLine = (s = "") => s.split("\n")[0]?.slice(0, 160) ?? "";
const stateIcon = (s: Server) =>
  s.client ? "✓" : s.state === "connecting" ? "⟳" : s.state === "disabled" ? "○" : s.state === "blocked" ? "⊘" : "·";

function statusText(st: State) {
  const all = [...st.servers.values()];
  if (!all.length) return "No MCP servers configured (add one to ~/.hortus/mcp.json or the project's .mcp.json).";
  const lines = all.map((s) => {
    const n = st.items.filter((it) => it.server === s).length;
    const detail = s.client ? "connected" : s.state === "stopped" ? (s.meta ? "not running" : "not started") : s.state;
    return `${stateIcon(s)} ${s.name} (${detail}, ${n} tools, ${lifecycleOf(s.entry)})${s.error ? ` — ${s.error}` : ""}`;
  });
  return [
    `MCP: ${all.filter((s) => s.client).length}/${all.filter(enabled).length} servers connected`,
    ...lines,
    "",
    'Use mcp({ search: "..." }) to find tools, mcp({ server: "name" }) to list one server\'s.',
  ].join("\n");
}

function serverText(st: State, s: Server) {
  const items = st.items.filter((it) => it.server === s);
  const i = s.meta?.instructions?.replace(/\s+/g, " ").trim();
  return [
    `${s.name} (${s.client ? "connected" : s.state}, ${items.length} tools)`,
    ...(s.entry.description ? [s.entry.description] : []),
    ...(i ? [`Instructions: ${i.length > 300 ? `${i.slice(0, 300)}… (mcp({ instructions: "${s.name}" }))` : i}`] : []),
    ...(s.meta ? [] : [`No tool list yet: mcp({ connect: "${s.name}" }) reads it.`]),
    ...items.map((it) => `- ${it.direct}${params(schemaOf(it))} - ${firstLine(descriptionOf(it))}`),
  ].join("\n");
}

function describeText(it: Item) {
  const hints = hintsOf(it.tool);
  return [
    it.direct,
    `Server: ${it.server.name}  Original name: ${it.name}  Codemode: tools.${it.deferred}`,
    "",
    descriptionOf(it),
    ...(hints.length ? ["", `Hints: ${hints.join(", ")}`] : []),
    "",
    "Input schema:",
    JSON.stringify(schemaOf(it), null, 2),
  ].join("\n");
}

/** words weighted across name, server, description, the server's description and its `searchKeywords` */
function score(it: Item, words: string[], phrase: string) {
  const e = it.server.entry;
  const keywords = Object.entries(e.searchKeywords ?? {})
    .filter(([k]) => matches([k], it.name, it.direct))
    .flatMap(([, v]) => v.map((x) => x.toLowerCase()));
  const fields: [string, number][] = [
    [`${it.direct} ${it.name}`.toLowerCase(), 3],
    [it.server.name.toLowerCase(), 1],
    [descriptionOf(it).toLowerCase(), 1],
    [(e.description ?? "").toLowerCase(), 1],
    [keywords.join(" "), 1],
  ];
  let total = keywords.includes(phrase) ? 2 : 0;
  for (const w of words) for (const [f, weight] of fields) if (f.includes(w)) total += weight;
  return total;
}

// ── The `mcp` proxy ───────────────────────────────────────────────────────────

const ProxyInput = z.object({
  tool: z.string().optional().describe("Tool to call (as listed by search/server)"),
  args: z
    .union([z.record(z.string(), z.unknown()), z.string()])
    .optional()
    .describe("The tool's arguments: an object, or a JSON string"),
  server: z.string().optional().describe("List this server's tools; or narrow tool/describe/search to it"),
  search: z.string().optional().describe("Find tools by words (ranked), or a regex with regex: true"),
  regex: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().min(0).optional(),
  includeSchemas: z.boolean().optional().describe("Show each search result's parameters"),
  describe: z.string().optional().describe("Show one tool's full description and input schema"),
  instructions: z.string().optional().describe("A server's full instructions"),
  connect: z.string().optional().describe("Connect (or refresh) a server"),
  action: z.enum(["install"]).optional().describe("install: add the MCP server at `url` (saved globally)"),
  url: z.string().optional(),
});
type ProxyInput = z.infer<typeof ProxyInput>;

function proxyDescription(st: State) {
  const servers = [...st.servers.values()].filter(enabled);
  const list = servers.map((s) => {
    const n = st.items.filter((it) => it.server === s).length;
    return `${s.name} (${n} tools)${s.entry.description ? ` — ${s.entry.description}` : ""}`;
  });
  return [
    "MCP gateway: find and call the tools of MCP servers (they start on first use).",
    ...(list.length ? [`Servers: ${list.join("; ")}`] : ["No servers configured yet."]),
    'mcp({}) status · mcp({ server }) list · mcp({ search: "words" }) · mcp({ describe: "tool" }) · mcp({ tool: "name", args: {...} }) · mcp({ connect: "server" }) · mcp({ instructions: "server" }) · mcp({ action: "install", url })',
  ].join("\n");
}

async function install(st: State, url: string, name?: string) {
  if (st.settings.allowInstall === false) throw new Error("URL install is turned off (settings.allowInstall: false)");
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http(s) MCP endpoints can be installed");
  const existing = [...st.servers.values()].find((s) => s.entry.url === url);
  if (existing) {
    await connect(st, existing);
    return `${existing.name} is already configured with ${url}.\n\n${serverText(st, existing)}`;
  }
  const n =
    name ?? (u.hostname.replace(/^(www|mcp|api)\./, "").split(".")[0] || "server").replace(/[^A-Za-z0-9_-]/g, "-");
  if (st.servers.has(n)) throw new Error(`A server named "${n}" already exists; pass server to choose another name`);
  const path = globalAdapterFile();
  const entry: Entry = { url };
  const s: Server = {
    name: n,
    entry,
    source: path,
    project: false,
    hash: identity(entry),
    state: "stopped",
    stderr: "",
    inflight: 0,
    lastUsed: Date.now(),
    callers: [],
    retries: 0,
  };
  st.servers.set(n, s);
  try {
    await connect(st, s);
  } catch (e) {
    st.servers.delete(n);
    rebuild(st);
    status(st);
    throw e;
  }
  const file = ((await readJson(path)) as { mcpServers?: Record<string, unknown> } | undefined) ?? {};
  await writeJson(path, { ...file, mcpServers: { ...file.mcpServers, [n]: entry } });
  startIdleTimer(st);
  return `Installed ${n} (${url}) in ${path}.\n\n${serverText(st, s)}`;
}

async function proxy(input: ProxyInput, ctx: ToolCtx): Promise<string | CallResult> {
  const st = stateOf(ctx);
  await st.ready;
  if (input.action === "install") {
    if (!input.url) throw new Error("install needs url");
    return install(st, input.url, input.server);
  }
  if (input.tool) {
    const hit = find(st, input.tool, input.server);
    if (Array.isArray(hit))
      return errorResult(
        `Tool "${input.tool}" not found.${hit.length ? ` Did you mean: ${hit.join(", ")}?` : ' Use mcp({ search: "..." }) to find tools.'}`,
      );
    let args: Record<string, unknown> = {};
    try {
      args = typeof input.args === "string" ? JSON.parse(input.args || "{}") : (input.args ?? {});
    } catch (e) {
      return errorResult(`args is not valid JSON: ${message(e)}`);
    }
    // under its own name when it is one of the run's tools, so tool_call / tool_result handlers (guards) see it
    const own = ctx.tools.find((t) => t.name === hit.deferred || (t.name === hit.direct && hit.mode !== "proxy"));
    let r: CallResult;
    if (own) {
      const res = await ctx.runTool({ id: randomUUID(), name: own.name, input: args });
      r = isCallResult(res.value) ? res.value : { content: [{ type: "text", text: res.output }], isError: res.isError };
    } else r = await callItem(st, hit, args, ctx);
    if (!r.isError) await activate(st, ctx, [hit]);
    return r;
  }
  if (input.connect) {
    const s = server(st, input.connect);
    const before = new Set(st.items.map((it) => it.direct));
    if (s.client) {
      s.meta = await discover(s.client, timeoutOf(st, s));
      void saveCache(st, s);
      rebuild(st);
    } else await connect(st, s);
    const added = st.items.filter((it) => it.server === s && !before.has(it.direct));
    for (const it of added)
      if (it.mode === "direct" && !ctx.tools.some((t) => t.name === it.direct))
        ctx.tools.push(toolOf(st, it, "direct"));
    ctx.update({ addedToolNames: added.map((it) => it.direct) });
    return `Connected ${s.name}.${added.length ? ` New tools: ${added.map((it) => it.direct).join(", ")}` : ""}\n\n${serverText(st, s)}`;
  }
  if (input.describe) {
    const hit = find(st, input.describe, input.server);
    if (Array.isArray(hit))
      return `Tool "${input.describe}" not found.${hit.length ? ` Did you mean: ${hit.join(", ")}?` : ""}`;
    return describeText(hit);
  }
  if (input.instructions) {
    const s = server(st, input.instructions);
    return s.meta?.instructions ?? `${s.name} has no instructions${s.meta ? "" : " cached yet"}.`;
  }
  if (input.search !== undefined) {
    const pool = st.items.filter((it) => !input.server || it.server.name === input.server);
    let hits: Item[];
    if (input.regex) {
      const re = new RegExp(input.search, "i");
      hits = pool.filter((it) => re.test(it.direct) || re.test(descriptionOf(it)));
    } else {
      const phrase = input.search.toLowerCase().trim();
      const words = phrase.split(/\s+/).filter(Boolean);
      hits = pool
        .map((it) => ({ it, score: score(it, words, phrase) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || (a.it.direct < b.it.direct ? -1 : 1))
        .map((x) => x.it);
    }
    const offset = input.offset ?? 0;
    const page = hits.slice(offset, offset + (input.limit ?? 12));
    const nextOffset = offset + page.length < hits.length ? offset + page.length : undefined;
    const addedToolNames = await activate(st, ctx, page);
    ctx.update({ nextOffset, addedToolNames });
    if (!page.length) return `No MCP tools match "${input.search}".`;
    const shape = (it: Item) => {
      try {
        return `\n  Parameters: ${tsType(schemaOf(it) as Parameters<typeof tsType>[0], "  ")}`;
      } catch {
        return `\n  Parameters: mcp({ describe: "${it.direct}" })`;
      }
    };
    return [
      `${hits.length} tools match "${input.search}"${hits.length > page.length ? ` (showing ${offset + 1}–${offset + page.length})` : ""}:`,
      ...page.map((it) => `${it.direct}\n  ${firstLine(descriptionOf(it))}${input.includeSchemas ? shape(it) : ""}`),
      ...(nextOffset !== undefined
        ? [`More: mcp({ search: ${JSON.stringify(input.search)}, offset: ${nextOffset} })`]
        : []),
      ...(addedToolNames.length ? [`Now available directly: ${addedToolNames.join(", ")}`] : []),
    ].join("\n");
  }
  if (input.server) return serverText(st, server(st, input.server));
  return statusText(st);
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const tokens = (s: string) =>
  [...s.matchAll(/(\w+=)?("[^"]*"|'[^']*'|\S+)/g)].map((m) => ({
    key: m[1]?.slice(0, -1),
    value: (m[2] ?? "").replace(/^(["'])(.*)\1$/s, "$2"),
  }));

/** Pi's `/mcp__<server>__<prompt>` command name. */
const promptCommandName = (st: State, s: Server, p: McpPrompt) => {
  const name = p.name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "") || "prompt";
  const server = prefixOf(s.name, s.entry.toolPrefix ?? st.settings.toolPrefix ?? "server") || sanitize(s.name);
  return `mcp__${server || "server"}__${/^[0-9]/.test(name) ? `_${name}` : name}`;
};
const promptUsage = (p: McpPrompt) =>
  (p.arguments ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");

/** A command per prompt of every server known (live or cached), as Pi registers them; the first of a name wins. */
function promptCommands(ctx: Ctx): Command[] {
  const { st } = stateIn(ctx);
  const out = new Map<string, Command>();
  for (const s of st?.servers.values() ?? [])
    for (const p of s.meta?.prompts ?? []) {
      const name = st && promptCommandName(st, s, p);
      if (!st || !name || out.has(name)) continue;
      out.set(name, {
        name,
        description: p.description ?? `MCP prompt ${p.name} (${s.name})`,
        ...(p.arguments?.length && { args: promptUsage(p) }),
        run: async (arg, ctx) => {
          await st.ready;
          return runPrompt(st, ctx, s, p, arg, name);
        },
      });
    }
  return [...out.values()];
}

async function runPrompt(st: State, ctx: Ctx, s: Server, p: McpPrompt, arg: string, command: string) {
  const name = p.name;
  const args: Record<string, string> = {};
  const positional = (p.arguments ?? []).map((a) => a.name);
  for (const t of tokens(arg)) {
    const key = t.key ?? positional.find((n) => !(n in args));
    if (key) args[key] = t.value;
  }
  const missing = (p.arguments ?? []).filter((a) => a.required && !(a.name in args)).map((a) => a.name);
  if (missing.length)
    throw new Error(
      `Missing required argument${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.\nUsage: /${command} ${promptUsage(p)}`,
    );
  const client = await connect(st, s);
  s.lastUsed = Date.now();
  const r = await client.getPrompt({ name, arguments: args }, { timeout: timeoutOf(st, s) });
  const parts = r.messages.map((m) => {
    const c = m.content as Block;
    const text = c.type === "text" ? (c.text ?? "") : c.type === "resource" ? (c.resource?.text ?? "") : `[${c.type}]`;
    return r.messages.length > 1 ? `[${m.role}] ${text}` : text;
  });
  // a turn when idle; during one, at its next boundary
  ctx.send(parts.join("\n\n"), { deliver: "steer" }).catch((e) => void ctx.notify(`${NAME}: ${message(e)}`, "error"));
  return `Sent MCP prompt ${s.name}/${name}`;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function setDisabled(st: State, ctx: Ctx, name: string, disabled: boolean) {
  const s = server(st, name);
  const path = projectOverrides(ctx.cwd);
  const file = ((await readJson(path)) as { mcpServers?: Record<string, Record<string, unknown>> } | undefined) ?? {};
  await writeJson(path, {
    ...file,
    mcpServers: { ...file.mcpServers, [name]: { ...file.mcpServers?.[name], disabled } },
  });
  s.entry = { ...s.entry, disabled };
  if (disabled) {
    await stop(st, s);
    s.state = "disabled";
  } else if (s.state === "disabled") s.state = s.project && !s.refused ? "stopped" : s.refused ? "blocked" : "stopped";
  rebuild(st);
  status(st);
  return `${NAME}: ${disabled ? "Disabled" : "Enabled"} ${name} (${path})`;
}

async function adapterCommand(arg: string, ctx: Ctx) {
  const st = stateOf(ctx);
  await st.ready;
  const [sub = "", rest = ""] = arg.trim().split(/\s+(.*)/s);
  const name = rest.trim();
  switch (sub) {
    case "":
    case "status":
      return statusText(st);
    case "tools":
      return (
        [...st.servers.values()]
          .map((s) => {
            const items = st.items.filter((it) => it.server === s);
            return `${s.name}:\n${items.map((it) => `  ${it.direct} [${it.mode}]`).join("\n") || "  (no tools known)"}`;
          })
          .join("\n") || "No MCP servers configured."
      );
    case "prompts": {
      const rows = [...st.servers.values()].flatMap((s) =>
        (s.meta?.prompts ?? []).map(
          (p) =>
            `/${promptCommandName(st, s, p)}${promptUsage(p) && ` ${promptUsage(p)}`}${p.description ? ` — ${p.description}` : ""}`,
        ),
      );
      return rows.join("\n") || "No MCP prompts.";
    }
    case "reconnect": {
      const targets = name ? [server(st, name)] : [...st.servers.values()].filter((s) => enabled(s) && s.client);
      const errors: string[] = [];
      for (const s of targets) {
        await stop(st, s);
        await connect(st, s).catch((e) => errors.push(message(e)));
      }
      return [`${NAME}: Reconnected ${targets.map((s) => s.name).join(", ") || "nothing"}`, ...errors].join("\n");
    }
    case "disable":
    case "enable":
      return setDisabled(st, ctx, name, sub === "disable");
    default:
      throw new Error(
        `Unknown subcommand "${sub}". Try: status, tools, prompts, reconnect [server], enable|disable <server>`,
      );
  }
}

// ── TUI ───────────────────────────────────────────────────────────────────────

const progress = (v: ToolView) => (v.result ? undefined : (v.details as McpProgress | undefined)?.mcpProgress);

/** What an `mcp` call does, in one line. */
function proxyTitle(input: ProxyInput) {
  const q = (s: string) => JSON.stringify(s);
  if (input.action === "install") return `install ${input.url ?? ""}`;
  if (input.tool) {
    const args = typeof input.args === "string" ? input.args : JSON.stringify(input.args ?? {});
    return `${input.tool} ${args === "{}" ? "" : args.length > 80 ? `${args.slice(0, 80)}…` : args}`.trim();
  }
  if (input.connect) return `connect ${input.connect}`;
  if (input.describe) return `describe ${input.describe}`;
  if (input.instructions) return `instructions ${input.instructions}`;
  if (input.search !== undefined) return `search ${q(input.search)}`;
  if (input.server) return `server ${input.server}`;
  return "status";
}

/** compact rows: the call, then its first result line (every line when expanded) */
const proxyBlock = linesRenderer((v) => {
  const title: Span[] = [{ text: "mcp ", bold: true }, { text: proxyTitle((v.call.input ?? {}) as ProxyInput) }];
  const p = progress(v);
  if (!v.result) return [title, ...(p ? [[{ text: p, dimColor: true }]] : [])];
  const lines = v.result.output.split("\n");
  const shown = v.expanded ? lines : lines.slice(0, 1);
  const style = v.result.isError ? { color: "red" } : { dimColor: true };
  return [
    title,
    ...shown.map((text) => [{ text, ...style }]),
    ...(!v.expanded && lines.length > 1
      ? [[{ text: `… ${lines.length - 1} more lines (Ctrl+O)`, dimColor: true }]]
      : []),
  ];
});

// ── The plugin ────────────────────────────────────────────────────────────────

/**
 * pi-mcp-adapter as a hortus plugin replacing builtin:mcp: one `mcp` proxy tool (status, search, describe, call,
 * connect, install) over layered configs (shared, hortus, trusted project files, `mcp_servers`), lazy servers with a
 * metadata cache and idle shutdown, direct and search-activated tools, codemode tools, approval gates kept in the
 * session, an output guard, elicitation and sampling through `ask`/`complete`, and MCP prompts sent as messages.
 */
export default {
  tools: [
    tool({
      name: "mcp",
      description: "MCP gateway: find and call the tools of MCP servers. mcp({}) shows the servers.",
      inputSchema: ProxyInput,
      execute: proxy,
    }),
  ],
  // `/mcp-adapter`, then a command per MCP prompt (servers come and go: listed anew each time)
  commands: (ctx) => [
    {
      name: "mcp-adapter",
      aliases: ["mcp"],
      description: "MCP servers: status, tools, prompts, reconnect [server], enable|disable <server>",
      args: "[status|tools|prompts|reconnect|enable|disable] [server]",
      complete: (ctx) => {
        const names = [...(stateIn(ctx).st?.servers.keys() ?? [])];
        return [
          ...["status", "tools", "prompts", "reconnect"].map((value) => ({ value })),
          ...["reconnect", "enable", "disable"].flatMap((sub) => names.map((n) => ({ value: `${sub} ${n}` }))),
        ];
      },
      run: adapterCommand,
    },
    ...promptCommands(ctx),
  ],
  entries: {
    approval: (e: PluginEntry<{ key: string }>, state, plugin) => {
      const d = dataOf(state, plugin);
      state.data[plugin] = { ...d, approvals: [...d.approvals, e.data.key] };
    },
    activate: (e: PluginEntry<{ names: string[] }>, state, plugin) => {
      const d = dataOf(state, plugin);
      state.data[plugin] = { ...d, activated: [...new Set([...d.activated, ...e.data.names])] };
    },
  },
  on: {
    ready: (_, ctx) => {
      const st: State = {
        ctx,
        settings: {},
        global: {},
        servers: new Map(),
        items: [],
        byName: new Map(),
        surface: [],
        names: new Map(),
        serverGrants: new Set(),
        ready: Promise.resolve(),
        cacheQueue: Promise.resolve(),
        closed: false,
      };
      stateIn(ctx).st = st;
      // in the background; the first run waits for it
      st.ready = start(st, ctx).catch((e) => void ctx.notify(`${NAME}: ${message(e)}`, "error"));
    },
    // a person can answer now: ask about the project's servers held back at startup
    interactive: async (_, ctx) => {
      const { st } = stateIn(ctx);
      if (!st) return;
      await st.ready;
      const admitted = await trust(st, ctx);
      if (!admitted.length) return;
      rebuild(st);
      status(st);
      startIdleTimer(st);
      st.ready = warm(st, admitted, new Set());
      await st.ready;
    },
    session_open: (_, ctx) => {
      // "Allow server for this session" lasts until the session changes
      stateIn(ctx).st?.serverGrants.clear();
    },
    run_start: async (p, ctx) => {
      const { st } = stateIn(ctx);
      if (!st) return;
      await st.ready;
      const activated = new Set(sessionData(ctx).activated);
      const want = [
        ...st.surface,
        ...st.items
          .filter((it) => it.mode === "search" && activated.has(it.direct))
          .map((it) => toolOf(st, it, "direct")),
      ];
      for (const t of want) if (!p.tools.some((x) => x.name === t.name)) p.tools.push(t);
    },
    request: (r, ctx) => {
      const { st } = stateIn(ctx);
      if (!st || (r.source !== "run" && r.source !== "preview")) return;
      const i = r.tools.findIndex((t) => t.name === "mcp" && t.plugin === ctx.plugin);
      const self = r.tools[i];
      if (!self) return;
      const searchMode = st.items.some((it) => it.mode === "search");
      if (st.settings.disableProxyTool && !searchMode) r.tools.splice(i, 1);
      else r.tools[i] = { ...self, description: proxyDescription(st) };
    },
    // a model's call: the MCP result as text and images, guarded; a ctx.runTool caller (codemode) gets it whole
    tool_result: async ({ call, result }, ctx) => {
      const { st } = stateIn(ctx);
      if (!st || call.parentId) return;
      const it = st.byName.get(call.name);
      if (!it && call.name !== "mcp") return;
      if (isCallResult(result.value)) {
        const m = await forModel(st, it?.server, result.value);
        result.output = m.output;
        if (m.images.length) result.images = m.images;
        if (result.value.isError) result.isError = true;
        if (it) result.details = { server: it.server.name, tool: it.name };
      }
      await guard(st, result);
    },
    close: async (_, ctx) => {
      const { st } = stateIn(ctx);
      if (!st) return;
      st.closed = true;
      clearInterval(st.idle);
      await Promise.all([...st.servers.values()].map((s) => stop(st, s)));
      await st.cacheQueue;
      if (st.binDir) await rm(st.binDir, { recursive: true, force: true });
      stateIn(ctx).st = undefined;
    },
  },
  cli: {
    tools: { mcp: proxyBlock },
    // MCP tool names are only known once servers are read, so progress wraps the generic block (`tool:*`)
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
