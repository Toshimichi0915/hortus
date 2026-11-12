/**
 * `@kontextmind/kxm`'s Pi extension and worker, ported: this hortus registers with a KXM hub as a peer agent
 * (`KXM_PROJECT`, `KXM_AUTH_TOKEN`, `KXM_AGENT_NAME`, `KXM_SERVER_URL`), turns each inbound peer request into a turn
 * (`ctx.send`, whose `run_end` is the reply), offers the peer tools (`kxm_list`, `kxm_send`, `kxm_get`, `kxm_await`,
 * `kxm_cancel`, `kxm_reply`) and runs supervised workers (`/kxm worker <name>`) whose requests are answered by
 * `hortus -p --session` children.
 */
import type { AssistantMessage, Ctx, Plugin, RunEnd } from "@hortus/core";
import { tool } from "@hortus/core";
import { z } from "zod";
import { errorText, HubClient, Inbox, inboundPrompt, type MessageRecord, workflowRunId } from "./client.ts";
import { startWorker, type Worker, workerOptions } from "./worker.ts";

interface State {
  /** this agent's own hub identity (none in a worker's child, or when not configured) */
  client?: HubClient;
  inbox?: Inbox;
  /** a worker child's client: its supervisor's identity, passed in the environment */
  childClient?: HubClient;
  /** an inbound request whose turn failed: the next turn that settles on its session answers it */
  retained?: { id: string; session: Ctx["session"]; resolve: (reply: string | undefined) => void };
  workers: Map<string, Worker>;
}

const state = (ctx: Ctx) => {
  const s = ctx.state as Partial<State>;
  s.workers ??= new Map();
  return s as State;
};

/** The hub from the environment; none without `KXM_PROJECT` (kxm stays off). */
const hubConfig = (env = process.env) =>
  env.KXM_PROJECT
    ? {
        serverUrl: env.KXM_SERVER_URL || "http://127.0.0.1:7331",
        authToken: env.KXM_AUTH_TOKEN,
        project: env.KXM_PROJECT,
      }
    : undefined;

/** Why a turn produced no reply; undefined when it settled. */
function failure(end: RunEnd | undefined) {
  if (!end) return "no_run";
  if (end.aborted) return "cancelled";
  if (end.error !== undefined)
    return /\b(quota|rate limit|too many requests|resource exhausted|429)\b/i.test(errorText(end.error))
      ? "provider_quota"
      : "provider_error";
  return undefined;
}

const lastText = (end: RunEnd) =>
  end.messages
    .filter((m): m is AssistantMessage => m.role === "assistant")
    .at(-1)
    ?.text.trim() || "The peer agent completed without a textual response.";

const areaForTool = (name: string) =>
  name.startsWith("kxm_workflow_") ? "workflow" : name.startsWith("kxm_") ? "harness" : "implementation";

/** Journals a failure on the workflow run `m` belongs to (best effort: the run may be terminal, the hub away). */
async function journal(s: State, m: MessageRecord, tool: string, cls: string, callId?: string) {
  const runId = workflowRunId(m);
  if (!runId || !s.client) return;
  await s.client
    .recordWorkflowEntry(runId, {
      category: "error",
      area: tool === "provider" ? "harness" : areaForTool(tool),
      severity: "error",
      summary: `Tool ${tool} failed: ${cls}`,
      evidence: [`tool:${tool}`, ...(callId ? [`tool-call:${callId}`] : []), `class:${cls}`],
    })
    .catch(() => {});
}

/**
 * An inbound request as a turn on the current session: `steer` joins a running turn, the others start one after it.
 * Its `run_end` is the reply; a failed turn retains the request until a later turn on that session settles.
 */
async function answer(ctx: Ctx, m: MessageRecord): Promise<string | undefined> {
  const s = state(ctx);
  const end = await ctx.send(
    {
      content: inboundPrompt(m),
      // shown as Pi does (`display: true`), with the built-in plugin-message look
      meta: { plugin: ctx.plugin, type: "inbound", details: { messageId: m.id, from: m.fromName }, display: true },
    },
    { deliver: m.delivery === "steer" ? "steer" : "after" },
  );
  const failed = failure(end);
  if (!failed && end) return lastText(end);
  await journal(s, m, "provider", failed ?? "no_run");
  void ctx.notify(
    `kxm retained ${m.id} after ${failed}; switch the model or let the supervised worker recover it`,
    "error",
  );
  return new Promise((resolve) => {
    s.retained = { id: m.id, session: ctx.session, resolve };
  });
}

async function connect(ctx: Ctx, hub: NonNullable<ReturnType<typeof hubConfig>>) {
  const s = state(ctx);
  const model = await ctx.resolve().catch(() => undefined);
  const client = new HubClient({
    ...hub,
    name: process.env.KXM_AGENT_NAME || `hortus-${process.pid}`,
    purpose: process.env.KXM_AGENT_PURPOSE || "General-purpose coding agent",
    ...(model && { model: `${model.provider}/${model.model}` }),
    fetch: ctx.fetch,
  });
  const inbox = new Inbox(
    client,
    (m) => answer(ctx, m),
    (text, level) => void ctx.notify(text, level),
    (id) => {
      if (s.retained?.id !== id) return;
      s.retained.resolve(undefined);
      s.retained = undefined;
    },
  );
  try {
    const agent = await client.start(inbox.receive);
    s.client = client;
    s.inbox = inbox;
    await ctx.notify(`Connected to the KXM hub as ${agent.name}`);
  } catch (e) {
    await ctx.notify(`kxm connection failed: ${errorText(e)}`, "error");
  }
  await refresh(ctx);
}

function statusText(ctx: Ctx) {
  const s = state(ctx);
  const me = s.client?.agent ? `${s.client.agent.name}@${s.client.agent.project}` : "offline";
  return `kxm ${me}${s.workers.size ? ` · ${s.workers.size} worker${s.workers.size > 1 ? "s" : ""}` : ""}`;
}

const refresh = (ctx: Ctx) => ctx.status("kxm", statusText(ctx));

/** The client tools act through: this agent's, else (in a worker's child) its supervisor's identity. */
function client(ctx: Ctx): HubClient {
  const s = state(ctx);
  if (s.client?.agent) return s.client;
  const hub = hubConfig();
  const { KXM_AGENT_ID: id, KXM_AGENT_KEY: key, KXM_AGENT_NAME: name = "" } = process.env;
  if (hub && id && key) {
    s.childClient ??= new HubClient({ ...hub, name, purpose: "", fetch: ctx.fetch, identity: { id, key } });
    return s.childClient;
  }
  throw new Error("kxm hub is not connected; check KXM_SERVER_URL and /kxm hub");
}

/** A request sent while handling an inbound one continues its hop chain. */
function hops(ctx: Ctx) {
  const a = state(ctx).inbox?.active;
  if (a) return { hops: a.hops + 1, maxHops: a.maxHops };
  const { KXM_HOPS, KXM_MAX_HOPS } = process.env;
  return KXM_HOPS && KXM_MAX_HOPS ? { hops: Number(KXM_HOPS), maxHops: Number(KXM_MAX_HOPS) } : {};
}

const workflowContext = z
  .object({
    runId: z.string().describe("Active durable workflow run ID"),
    stageId: z.string().describe("Active workflow stage ID"),
    requirementKey: z.string().describe("Required evidence identity this peer reply may satisfy"),
    attempt: z.number().int().min(1).max(20).describe("Current one-based stage attempt"),
  })
  .describe("Requested provenance scope; the hub authorizes and persists the canonical binding");
const messageId = z.object({ messageId: z.string().min(1).describe("Message ID of the request") });

const tools = [
  tool({
    name: "kxm_list",
    description:
      "List peer agents in this project's hub pool with their names, purposes, host label, and hub-clocked presence (online, stale, offline). Registered offline peers are listed only when includeOffline is set.",
    inputSchema: z.object({
      includeOffline: z.boolean().optional().describe("Also list registered peers whose hub lease has expired"),
    }),
    execute: async ({ includeOffline }, ctx) => ({ agents: await client(ctx).listAgents(includeOffline) }),
  }),
  tool({
    name: "kxm_send",
    description:
      "Send a focused request to a peer agent. Returns a message ID for kxm_get or kxm_await. For durable peer evidence, workflowContext is the hub-authorized provenance scope; correlation and idempotency are transport concerns and do not establish evidence provenance.",
    inputSchema: z.object({
      target: z.string().min(1).describe("Peer name or agent ID"),
      content: z.string().min(1).describe("Focused request with the expected response or artifact"),
      delivery: z
        .enum(["steer", "followUp", "nextTurn"])
        .optional()
        .describe("followUp is the safe default; use steer only for active blockers"),
      correlationId: z.string().optional().describe("Optional task grouping"),
      idempotencyKey: z.string().optional().describe("Retry/deduplication key only"),
      workflowContext: workflowContext.optional(),
      ttlMs: z.number().min(1000).max(604_800_000).optional().describe("Message TTL in milliseconds"),
      allowOffline: z
        .boolean()
        .optional()
        .describe("Queue the request if the target is a registered offline agent in this project"),
    }),
    execute: async (input, ctx) => {
      const m = await client(ctx).send({ ...hops(ctx), ...input });
      return { messageId: m.id, status: m.status, target: m.toName };
    },
  }),
  tool({
    name: "kxm_get",
    description: "Check the status and optional reply for a previously sent request.",
    inputSchema: messageId,
    execute: async (input, ctx) => client(ctx).getMessage(input.messageId),
  }),
  tool({
    name: "kxm_await",
    description:
      "Wait until a sent request receives a reply or reaches a terminal error. Capped at 60 seconds (60000ms); longer waits are workflow wait steps.",
    inputSchema: messageId.extend({
      timeoutMs: z.number().min(100).max(60_000).optional().describe("Timeout in milliseconds (capped at 60 seconds)"),
    }),
    execute: async (input, ctx) => client(ctx).awaitResponse(input.messageId, input.timeoutMs ?? 60_000, ctx.signal),
  }),
  tool({
    name: "kxm_cancel",
    description: "Cancel a queued or delivered request sent by this agent.",
    inputSchema: messageId,
    execute: async (input, ctx) => client(ctx).cancel(input.messageId),
  }),
  tool({
    name: "kxm_reply",
    description: "Reply to an inbound peer request using its message ID.",
    inputSchema: messageId.extend({
      content: z.string().min(1).describe("Final response with evidence and remaining risks"),
    }),
    execute: async (input, ctx) => {
      const m = await client(ctx).reply(input.messageId, input.content);
      return { messageId: input.messageId, status: m.status, recipient: m.fromName };
    },
  }),
];

const HELP =
  "kxm: /kxm [status] | /kxm hub | /kxm worker <name> [purpose] | /kxm workers | /kxm stop <name> | /kxm help";

async function kxmCommand(arg: string, ctx: Ctx): Promise<string> {
  const s = state(ctx);
  const [sub = "status", name, ...rest] = arg.trim().split(/\s+/).filter(Boolean);
  if (sub === "status") return statusText(ctx);
  if (sub === "help") return HELP;
  if (sub === "hub") {
    const url = hubConfig()?.serverUrl ?? "http://127.0.0.1:7331";
    const health = await ctx.fetch(`${url}/health`).then(
      (r) => (r.ok ? "ok" : `http_${r.status}`),
      () => "unreachable",
    );
    if (!s.client?.agent) return `kxm hub view: health=${health}; no agent connected`;
    return `kxm hub view: health=${health}; ${s.client.agent.name}; ${(await s.client.listAgents()).length} online agent(s)`;
  }
  if (sub === "workers")
    return (
      [...s.workers.values()]
        .map(
          (w) =>
            `${w.options.name}: ${w.inbox.active ? `answering ${w.inbox.active.id}` : "idle"}, ${w.inbox.pending.length} queued`,
        )
        .join("\n") || "kxm: no workers"
    );
  if (!name) throw new Error(`Usage: /kxm ${sub} <name>`);
  if (sub === "worker") {
    const hub = hubConfig();
    if (!hub?.authToken) throw new Error("kxm worker needs KXM_PROJECT and KXM_AUTH_TOKEN (the project token)");
    if (s.workers.has(name)) throw new Error(`kxm worker ${name} is already running`);
    const w = await startWorker(ctx, hub, workerOptions(name, rest.join(" ")));
    s.workers.set(name, w);
    await refresh(ctx);
    return `kxm worker ${name} connected as ${w.client.agent?.id}`;
  }
  if (sub === "stop") {
    const w = s.workers.get(name);
    if (!w) throw new Error(`kxm worker ${name} is not running`);
    s.workers.delete(name);
    await w.stop();
    await refresh(ctx);
    return `kxm worker ${name} stopped`;
  }
  throw new Error(`Unknown /kxm subcommand: ${sub}. ${HELP}`);
}

export default {
  tools,
  on: {
    init: (_, ctx) => {
      const hub = hubConfig();
      // a worker's child acts through its supervisor's identity: the supervisor owns its inbox
      if (!hub || process.env.KXM_WORKER_CHILD) return;
      if (!hub.authToken)
        return void ctx.notify("kxm: KXM_PROJECT is set but KXM_AUTH_TOKEN (the project token) is not", "error");
      void connect(ctx, hub);
    },
    run_end: (end, ctx) => {
      const s = state(ctx);
      const r = s.retained;
      if (!r || end.source !== "run" || ctx.run?.depth || ctx.session !== r.session || failure(end)) return;
      s.retained = undefined;
      r.resolve(lastText(end));
    },
    tool_result: async ({ call, result }, ctx) => {
      const s = state(ctx);
      if (result.isError && s.inbox?.active) await journal(s, s.inbox.active, call.name, "tool_error", call.id);
    },
    close: async (_, ctx) => {
      const s = state(ctx);
      s.inbox?.stop();
      s.retained?.resolve(undefined);
      await Promise.all([s.client?.stop(), ...[...s.workers.values()].map((w) => w.stop())]);
      s.workers.clear();
    },
  },
  commands: [
    {
      name: "kxm",
      args: "[status | hub | worker <name> [purpose] | workers | stop <name> | help]",
      description: "KXM hub peer status, and supervised workers",
      complete: (ctx) => [
        { value: "status", description: "This agent's hub connection" },
        { value: "hub", description: "Hub health and online peers" },
        { value: "worker ", label: "worker", description: "Start a supervised worker agent" },
        { value: "workers", description: "List running workers" },
        ...[...state(ctx).workers.keys()].map((n) => ({ value: `stop ${n}`, description: `Stop worker ${n}` })),
        { value: "help", description: "Show usage" },
      ],
      run: kxmCommand,
    },
  ],
} satisfies Plugin;
