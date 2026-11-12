import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  contextTokens,
  type Ctx,
  hortusDir,
  type Image,
  type Message,
  type Plugin,
  type SentRequest,
  type Tool,
  type ToolResult,
  type ToolWrap,
  version as hortusVersion,
} from "@hortus/core";
import { z } from "zod";

const VERSION: string = JSON.parse(readFileSync(new URL("../hortus.json", import.meta.url), "utf8")).version;
export const DEFAULT_PROJECT = "hortus-coding-agent";
const DEFAULT_API_URL = "https://api.smith.langchain.com";

const ReplicaSchema = z.preprocess(
  (v) => {
    if (v == null || typeof v !== "object" || Array.isArray(v)) return v;
    const r = v as Record<string, unknown>;
    return {
      api_url: r.api_url ?? r.apiUrl,
      api_key: r.api_key ?? r.apiKey,
      project: r.project ?? r.projectName,
      updates: r.updates,
    };
  },
  z.object({
    api_url: z.string().optional(),
    api_key: z.string().optional(),
    project: z.string().optional(),
    updates: z.record(z.string(), z.unknown()).optional(),
  }),
);
const ConfigSchema = z.object({
  enabled: z.boolean(),
  api_key: z.string().optional(),
  api_url: z.string().optional(),
  project: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  replicas: z.array(ReplicaSchema).optional(),
  /** an embedder's run to nest top-level runs under: its dotted order (LangSmith's `langsmith-trace` header value) */
  parent: z.string().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;
const PartialSchema = ConfigSchema.partial();

const bool = (v?: string) => {
  const s = v?.trim().toLowerCase();
  return s && ["1", "true", "yes", "on"].includes(s)
    ? true
    : s && ["0", "false", "no", "off"].includes(s)
      ? false
      : undefined;
};
const json = (v?: string) => {
  try {
    return v?.trim() ? JSON.parse(v) : undefined;
  } catch {
    return undefined;
  }
};
const defined = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const readJson = async (path: string) => {
  try {
    return defined(PartialSchema.parse(JSON.parse(await readFile(path, "utf8"))));
  } catch {
    return {};
  }
};

/**
 * Defaults, then a `langsmith` secrets.json entry (`apiKey`, `endpoint`), `~/.hortus/langsmith.json`,
 * `<cwd>/.hortus/langsmith.json`, then the environment (`TRACE_TO_LANGSMITH`, `LANGSMITH_HORTUS_*` falling back to
 * `LANGSMITH_*`), later winning: Pi's `~/.pi/langsmith.json` / `LANGSMITH_PI_*`, moved to hortus's places.
 */
export async function loadConfig(ctx: Ctx, cwd = ctx.cwd, env = process.env): Promise<Config> {
  const v = (s: string) => env[`LANGSMITH_HORTUS_${s}`] ?? env[`LANGSMITH_${s}`];
  const fromEnv = PartialSchema.parse({
    enabled: bool(env.TRACE_TO_LANGSMITH),
    api_key: v("API_KEY"),
    api_url: v("ENDPOINT"),
    project: v("PROJECT"),
    metadata: json(v("METADATA")),
    replicas: json(v("RUNS_ENDPOINTS")),
    parent: v("TRACE"),
  });
  const secret = (await ctx.secrets.find("langsmith"))[0]?.entry;
  return ConfigSchema.parse({
    enabled: false,
    project: DEFAULT_PROJECT,
    ...defined({ api_key: secret?.apiKey, api_url: secret?.endpoint }),
    ...(await readJson(join(hortusDir(), "langsmith.json"))),
    ...(await readJson(join(cwd, ".hortus", "langsmith.json"))),
    ...defined(fromEnv),
  });
}

// ── coding-agent-v1 metadata, stamped on the root and copied to its descendants ──────────────────────────────────────

const git = (cwd: string, args: string[]) => {
  try {
    return (
      execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim() || undefined
    );
  } catch {
    return undefined;
  }
};
export function parseRemote(remote: string) {
  let host: string | undefined;
  let path: string | undefined;
  const scp = remote.match(/^[^/@]+@([^:/]+):(.+)$/);
  if (scp) [, host, path] = scp;
  else {
    try {
      ({ host, pathname: path } = new URL(remote));
    } catch {
      return undefined;
    }
  }
  const name = path?.replace(/^\/+/, "").replace(/\.git$/, "");
  if (!host || !name) return undefined;
  const provider = ["github", "gitlab", "bitbucket"].find((p) => host.includes(p)) ?? "other";
  return { repository_url: `https://${host}/${name}`, repository_provider: provider, repository_name: name };
}
const gitInfo = new Map<string, Record<string, string | undefined>>();
function gitOf(cwd: string) {
  let info = gitInfo.get(cwd);
  if (!info) {
    const remote = git(cwd, ["config", "--get", "remote.origin.url"]);
    info = {
      ...(remote && (parseRemote(remote) ?? { repository_url: remote })),
      git_branch: git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
      git_commit_sha: git(cwd, ["rev-parse", "HEAD"]),
    };
    gitInfo.set(cwd, info);
  }
  return info;
}
const username = () => {
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined;
  }
};
const agentMetadata = (cwd: string, threadId: string | undefined, turnNumber: number) =>
  defined({
    ls_agent_purpose: "coding",
    ls_agent_type: "root",
    ls_integration: "hortus",
    ls_agent_runtime: "hortus",
    ls_trace_schema_version: "coding-agent-v1",
    thread_id: threadId,
    ls_integration_version: VERSION,
    ls_agent_runtime_version: hortusVersion,
    turn_number: turnNumber,
    ...gitOf(cwd),
    cwd,
    local_username: username(),
  });

// ── messages as LangSmith renders them (OpenAI chat shape, LangChain v1 image blocks) ───────────────────────────────

const content = (text: string, images?: Image[]) =>
  images?.length
    ? [{ type: "text", text }, ...images.map((i) => ({ type: "image", mime_type: i.mediaType, base64: i.data }))]
    : text;
const toolMessage = (r: ToolResult) => ({
  role: "tool",
  tool_call_id: r.id,
  content: content(r.output, r.images),
  ...(r.isError && { status: "error" }),
  ...(r.details !== undefined && { details: r.details }),
});
export const convertMessages = (messages: readonly Message[]): unknown[] =>
  messages.flatMap((m) =>
    m.role === "user"
      ? [{ role: "user", content: content(m.content, m.images) }]
      : m.role === "assistant"
        ? [
            {
              role: "assistant",
              content: m.text,
              ...(m.toolCalls.length && {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: JSON.stringify(c.input) },
                })),
              }),
            },
          ]
        : m.results.map(toolMessage),
  );
const convertTools = (tools: readonly Tool[]) =>
  tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.inputSchema) },
  }));

const llmInputs = (req: SentRequest) => ({
  messages: [{ role: "system", content: req.system }, ...convertMessages(req.messages)],
  tools: convertTools(req.tools),
  model: req.model,
  ...(req.effort && { effort: req.effort }),
});

/** LangSmith `usage_metadata`; hortus's `input` already includes the cache reads and writes. */
export const usageMetadata = (a: AssistantMessage) => {
  const u = a.usage;
  if (!u) return undefined;
  return defined({
    input_tokens: u.input,
    output_tokens: u.output,
    total_tokens: u.input + u.output,
    input_token_details: defined({ cache_read: u.cacheRead, cache_creation: u.cacheWrite }),
    // no cost (or 0 with tokens) = unknown: left out so LangSmith prices it
    total_cost: u.cost || undefined,
  });
};

// ── run trees and the batched REST client (LangSmith SDK's RunTree + Client autobatching) ───────────────────────────

/** A run as `POST /runs/batch` takes it. */
export interface LsRun {
  id: string;
  trace_id: string;
  dotted_order: string;
  parent_run_id?: string;
  name: string;
  run_type: "chain" | "llm" | "tool";
  start_time: string;
  end_time?: string;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  extra: { metadata: Record<string, unknown> };
  tags?: string[];
  events: { name: string; time: string; kwargs?: Record<string, unknown> }[];
}

let seq = 0;
/** `YYYYMMDDTHHMMSSffffffZ<id>`; the microseconds take a counter, so siblings started in one ms keep their order. */
const orderStamp = (iso: string, id: string) =>
  `${iso.replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, (_, ms) => `${ms}${String(seq++ % 1000).padStart(3, "0")}`)}Z${id}`;

/** The run a dotted order names (`<stamp>Z<id>.…`), to nest under: its id, trace and order. */
export function parentRun(dotted: string): LsRun | undefined {
  const ids = dotted.split(".").map((s) => s.match(/Z([0-9a-f-]{36})$/)?.[1]);
  const [trace, id] = [ids[0], ids.at(-1)];
  if (!trace || !id || ids.includes(undefined)) return undefined;
  return {
    id,
    trace_id: trace,
    dotted_order: dotted,
    name: "",
    run_type: "chain",
    start_time: "",
    inputs: {},
    extra: { metadata: {} },
    events: [],
  };
}

function newRun(
  parent: LsRun | undefined,
  fields: Pick<LsRun, "name" | "run_type" | "inputs"> & Partial<LsRun>,
): LsRun {
  const id = randomUUID();
  const start_time = new Date().toISOString();
  const stamp = orderStamp(start_time, id);
  const run: LsRun = {
    id,
    trace_id: parent?.trace_id ?? id,
    dotted_order: parent ? `${parent.dotted_order}.${stamp}` : stamp,
    ...(parent && { parent_run_id: parent.id }),
    start_time,
    events: [],
    ...fields,
    extra: { metadata: { ...parent?.extra.metadata, ...fields.extra?.metadata } },
  };
  enqueue(run, true);
  return run;
}

interface End {
  outputs?: Record<string, unknown>;
  error?: string;
  metadata?: Record<string, unknown>;
}
function endRun(run: LsRun | undefined, { outputs, error, metadata }: End) {
  if (!run || run.end_time) return;
  run.end_time = new Date().toISOString();
  if (outputs) run.outputs = outputs;
  if (error !== undefined) run.error = error;
  if (metadata) Object.assign(run.extra.metadata, defined(metadata));
  enqueue(run, false);
}

let cfg: Config | undefined;
let fetchFn: typeof globalThis.fetch = (...args) => globalThis.fetch(...args);
/** the host ctx from `init`, to report the first failed batch */
let host: Ctx | undefined;
let warned = false;
const fail = (url: string, why: string) => {
  if (warned) return;
  warned = true;
  void host?.notify(`langsmith: sending runs to ${url} failed (${why}); later failures are dropped`, "warn");
};
/** runs waiting for the next batch: `post` until the batch that creates them is sent, else a patch */
const queue = new Map<string, { run: LsRun; post: boolean }>();
const inflight = new Set<Promise<void>>();
let timer: NodeJS.Timeout | undefined;
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 250;

function enqueue(run: LsRun, post: boolean) {
  // a patch of a run whose post is still queued is merged into it, as the SDK's batch does
  if (!queue.get(run.id)?.post) queue.set(run.id, { run, post });
  if (queue.size >= BATCH_SIZE) flush();
  else timer ??= setTimeout(flush, BATCH_DELAY_MS).unref();
}

/** uuid v5 of `name` (the SDK remaps ids this way for a replica in another project, so they don't collide) */
const uuid5 = (name: string) => {
  const b = createHash("sha1").update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex")).update(name).digest();
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** Where runs go: the configured project, or (as the SDK's RunTree does) only the replicas when there are any. */
const destinations = (c: Config) =>
  (c.replicas?.length ? c.replicas : [{}]).map((r) => ({
    url: (r.api_url ?? c.api_url ?? DEFAULT_API_URL).replace(/\/+$/, ""),
    key: r.api_key ?? c.api_key,
    project: r.project ?? c.project,
    updates: r.updates,
  }));

function forDestination(run: LsRun, d: ReturnType<typeof destinations>[number], c: Config, post: boolean) {
  const remap = d.project === c.project ? (id: string) => id : (id: string) => uuid5(`${id}:${d.project}`);
  const { metadata, ...updates } = d.updates ?? {};
  const out = {
    // a patch carries `inputs` too: an LLM run's become what was sent, known only at its response
    ...(post ? run : { inputs: run.inputs, end_time: run.end_time, outputs: run.outputs, error: run.error }),
    ...(!post && { events: run.events, extra: run.extra, tags: run.tags }),
    id: remap(run.id),
    trace_id: remap(run.trace_id),
    dotted_order: run.dotted_order.replace(/Z([0-9a-f-]{36})/g, (_, id) => `Z${remap(id)}`),
    ...(run.parent_run_id && { parent_run_id: remap(run.parent_run_id) }),
    session_name: d.project,
    ...updates,
  };
  if (metadata) out.extra = { ...run.extra, metadata: { ...run.extra.metadata, ...(metadata as object) } };
  return out;
}

/** Sends the queued runs as one `POST /runs/batch` per destination; a failed batch is dropped. */
function flush() {
  clearTimeout(timer);
  timer = undefined;
  const c = cfg;
  if (!queue.size || !c) return;
  const ops = [...queue.values()];
  queue.clear();
  for (const d of destinations(c)) {
    const body = {
      post: ops.filter((o) => o.post).map((o) => forDestination(o.run, d, c, true)),
      patch: ops.filter((o) => !o.post).map((o) => forDestination(o.run, d, c, false)),
    };
    // ponytail: no retry (the SDK retries); the first failure is reported, later ones dropped
    const p = fetchFn(`${d.url}/runs/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(d.key && { "x-api-key": d.key }) },
      body: JSON.stringify(body),
    }).then(
      (res) => {
        if (!res.ok) fail(d.url, `HTTP ${res.status}`);
      },
      (e) => fail(d.url, e instanceof Error ? e.message : String(e)),
    );
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  }
}

/** Sends what is queued and waits for every batch in flight (the SDK's `awaitPendingTraceBatches`). */
export async function awaitPendingBatches() {
  flush();
  await Promise.all(inflight);
}

// ── one traced run ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Trace {
  session?: string;
  root: LsRun;
  /** the entries of the messages before the run, so the root's outputs are only what it added (a compaction mid-run
   * changes the history's length, not its entry ids) */
  before: Set<string | undefined>;
  turn?: LsRun;
  /** open LLM runs by request id, tool runs by call id */
  open: Map<string, LsRun>;
  /** every turn (closed `incomplete` if the run ends inside one) */
  allTurns: LsRun[];
}
const traces = new Map<string, Trace>();
/** How many runs are being traced (none once `close` flushed them). */
export const openRuns = () => traces.size;
const traceOf = (ctx: Ctx) => (ctx.run ? traces.get(ctx.run.id) : undefined);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** `ls_provider` as LangSmith prices it */
const lsProvider = (type: string) => (type === "openai-responses" ? "openai" : type);

/** Ends what is still open in `t`, then its root. */
function finish(t: Trace, root: End, reason: string) {
  for (const run of t.open.values())
    endRun(run, { error: `${reason} before ${run.run_type === "tool" ? "the tool result" : "the response"}` });
  for (const turn of t.allTurns) endRun(turn, { outputs: { incomplete: true } });
  endRun(t.root, root);
}

/**
 * @langchain/langsmith-pi-extension: traces each run to LangSmith as a run tree, threaded by session (`thread_id`):
 * `hortus agent run` (chain) ├ `turn N` (chain) ├ one `llm` run per provider request and one `tool` run per tool call; a
 * tool's own `ctx.complete`/`ctx.runTool` nest under its run. Runs are batched to `POST <api_url>/runs/batch` (a post and
 * a later patch of one run merged), sent every 250 ms or 100 runs, and in `close`, which also ends runs cut off by exit.
 * `/langsmith-tracing` reports the status.
 */
export default {
  // hortus processes these tools start (`hortus -p` from bash, `subagent --background`) nest under the tool's run
  tools: ["bash", "subagent"].map(
    (name): ToolWrap => ({
      name,
      optional: true,
      wrap: (Default) => ({
        ...Default,
        execute: (input, ctx) => {
          const run = cfg?.enabled && traceOf(ctx)?.open.get(ctx.callId);
          return Default.execute(
            input,
            run ? { ...ctx, env: { ...ctx.env, LANGSMITH_HORTUS_TRACE: run.dotted_order } } : ctx,
          );
        },
      }),
    }),
  ),
  on: {
    init: async (_, ctx) => {
      cfg = await loadConfig(ctx);
      fetchFn = ctx.fetch;
      host = ctx;
    },
    run_start: ({ source, messages, model, provider }, ctx) => {
      if (!cfg?.enabled || source !== "run" || !ctx.run) return;
      const last = messages.at(-1);
      const turnNumber = messages.filter((m) => m.role === "user" && !m.meta).length;
      // a subrun's tree nests under the tool call (else the turn, the run) that started it
      const { runId, toolCallId } = ctx.run.parent ?? {};
      const up = runId ? traces.get(runId) : undefined;
      // a top-level run nests under its embedder's (`parent`, e.g. a parent hortus's tool run passed to a child process)
      const embedder = !ctx.run.parent && cfg.parent ? parentRun(cfg.parent) : undefined;
      const root = newRun((up && ((toolCallId && up.open.get(toolCallId)) || up.turn || up.root)) || embedder, {
        name: "hortus agent run",
        run_type: "chain",
        inputs: {
          prompt: last?.role === "user" ? last.content : undefined,
          imageCount: last?.role === "user" ? (last.images?.length ?? 0) : 0,
        },
        extra: {
          metadata: {
            ...agentMetadata(ctx.run.cwd, ctx.session?.id, turnNumber),
            ls_provider: lsProvider(ctx.run.type),
            ls_model_name: model,
            hortus_provider: provider,
            ...cfg.metadata,
          },
        },
        tags: ["hortus", "coding-agent"],
      });
      traces.set(ctx.run.id, {
        session: ctx.session?.id,
        root,
        before: new Set(messages.map((m) => m.entryId)),
        open: new Map(),
        allTurns: [],
      });
    },
    turn_start: ({ index }, ctx) => {
      const t = traceOf(ctx);
      if (!t || !ctx.run) return;
      t.turn = newRun(t.root, {
        name: `turn ${index}`,
        run_type: "chain",
        inputs: { turnIndex: index },
        extra: { metadata: { ls_provider: lsProvider(ctx.run.type), ls_model_name: ctx.run.model, loop_index: index } },
      });
      t.allTurns.push(t.turn);
    },
    request: (req, ctx) => {
      const t = traceOf(ctx);
      if (!t) return;
      // a tool's `ctx.complete` nests under that tool
      const parent = (ctx.callId && t.open.get(ctx.callId)) || t.turn || t.root;
      const llm = newRun(parent, {
        name: lsProvider(req.type),
        run_type: "llm",
        inputs: llmInputs(req),
        extra: { metadata: { ls_provider: lsProvider(req.type), ls_model_name: req.model, source: req.source } },
      });
      t.open.set(req.id, llm);
    },
    response: ({ id, request, assistant, error, meta }, ctx) => {
      const t = traceOf(ctx);
      const llm = t?.open.get(id);
      if (!t || !llm) return;
      t.open.delete(id);
      // what was sent: every `request` handler's edits, and the tool prompts core appended after them
      llm.inputs = llmInputs(request);
      endRun(llm, {
        outputs: assistant ? { messages: convertMessages([assistant]) } : {},
        ...(error !== undefined && { error: errorText(error) }),
        metadata: {
          stop_reason: meta?.stopReason,
          usage_metadata: assistant && usageMetadata(assistant),
          ...(meta?.model && { ls_model_name: meta.model }),
        },
      });
    },
    tool_call: ({ call }, ctx) => {
      const t = traceOf(ctx);
      if (!t) return;
      const parent = (call.parentId && t.open.get(call.parentId)) || t.turn || t.root;
      const run = newRun(parent, {
        name: call.name,
        run_type: "tool",
        inputs: { toolCallId: call.id, args: call.input },
        extra: { metadata: { toolName: call.name, toolCallId: call.id } },
      });
      t.open.set(call.id, run);
    },
    tool_update: ({ call, details }, ctx) => {
      traceOf(ctx)
        ?.open.get(call.id)
        ?.events.push({ name: "tool_update", time: new Date().toISOString(), kwargs: { partialResult: details } });
    },
    tool_result: ({ call, result }, ctx) => {
      const t = traceOf(ctx);
      const run = t?.open.get(call.id);
      if (!t || !run) return;
      t.open.delete(call.id);
      endRun(run, {
        outputs: { output: toolMessage(result) },
        ...(result.isError && { error: "Tool execution failed" }),
      });
    },
    turn_end: ({ assistant, results }, ctx) => {
      const t = traceOf(ctx);
      if (!t?.turn) return;
      endRun(t.turn, {
        outputs: { messages: convertMessages([assistant]), toolResults: results?.map(toolMessage) },
      });
      t.turn = undefined;
    },
    // Pi's `session_compact` run: a compaction during a traced run, under its turn
    compacted: ({ entry, reason }, ctx) => {
      const t = traceOf(ctx);
      if (!t) return;
      const { summary, tokensBefore } = entry.data;
      endRun(
        newRun(t.turn ?? t.root, {
          name: `Context Compaction (${reason})`,
          run_type: "chain",
          inputs: { reason },
          extra: { metadata: { ls_agent_type: "compaction" } },
        }),
        { outputs: { summary, tokensBefore } },
      );
    },
    run_end: ({ source, messages, error, aborted }, ctx) => {
      const t = traceOf(ctx);
      if (source !== "run" || !t || !ctx.run) return;
      traces.delete(ctx.run.id);
      const tokens = messages.some((m) => m.role === "assistant" && m.usage) ? contextTokens(messages) : undefined;
      const window = ctx.run.info.contextWindow;
      finish(
        t,
        {
          outputs: {
            messages: convertMessages(messages.filter((m) => !t.before.has(m.entryId))),
            ...(tokens !== undefined && {
              context_usage: {
                tokens,
                ...(window && { contextWindow: window, percent: Math.round((tokens / window) * 1000) / 10 }),
              },
            }),
          },
          ...(error !== undefined
            ? { error: errorText(error) }
            : aborted && { error: `Aborted by ${aborted.by}${aborted.reason ? `: ${aborted.reason}` : ""}` }),
        },
        "Run ended",
      );
    },
    // runs cut off by exit, then every batch still queued or in flight
    close: async () => {
      for (const t of traces.values())
        finish(t, { outputs: { shutdown: true }, error: "hortus shut down before run completed" }, "hortus shut down");
      traces.clear();
      await awaitPendingBatches();
    },
  },
  commands: [
    {
      name: "langsmith-tracing",
      description: "Show LangSmith tracing status",
      run: (_, ctx) => {
        if (!cfg?.enabled)
          return "LangSmith tracing is disabled. Set TRACE_TO_LANGSMITH=true and an API key (LANGSMITH_HORTUS_API_KEY, or a `langsmith` secrets.json entry) to enable it.";
        const active = [...traces.values()].find((t) => t.session === ctx.session?.id);
        return `LangSmith tracing is enabled (project ${cfg.project})${active ? ` (active trace ${active.root.id})` : ""}.`;
      },
    },
  ],
} satisfies Plugin;
