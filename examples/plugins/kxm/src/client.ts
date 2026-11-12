/** A KXM hub client (the HTTP + SSE half of `@kontextmind/kxm`'s `HubClient`), over the host's `fetch`. */
import { hostname } from "node:os";

export type DeliveryMode = "steer" | "followUp" | "nextTurn";
export type MessageStatus = "queued" | "delivered" | "replied" | "cancelled" | "expired" | "error";

export interface AgentRecord {
  id: string;
  name: string;
  purpose: string;
  project: string;
  model?: string;
  host?: string;
  online: boolean;
}

export interface WorkflowContext {
  runId: string;
  stageId: string;
  requirementKey: string;
  attempt: number;
}

export interface MessageRecord {
  id: string;
  project: string;
  from: string;
  fromName: string;
  to: string;
  toName: string;
  content: string;
  delivery: DeliveryMode;
  hops: number;
  maxHops: number;
  correlationId?: string;
  workflowRunId?: string;
  workflowContext?: WorkflowContext;
  expiresAt: string;
  status: MessageStatus;
  reply?: { content: string };
  error?: string;
}

export type HubEvent =
  | { type: "message" | "reply" | "cancelled" | "expired"; message: MessageRecord }
  | { type: "presence"; agent: AgentRecord };

export interface SendOptions {
  target: string;
  content: string;
  delivery?: DeliveryMode;
  hops?: number;
  maxHops?: number;
  correlationId?: string;
  idempotencyKey?: string;
  workflowContext?: WorkflowContext;
  ttlMs?: number;
  allowOffline?: boolean;
}

export interface HubOptions {
  serverUrl: string;
  authToken?: string;
  name: string;
  purpose: string;
  project: string;
  model?: string;
  fetch: typeof globalThis.fetch;
  /** an identity registered elsewhere (a worker's child acting for its supervisor): no registration of its own */
  identity?: { id: string; key: string };
}

export const MAX_CONTENT_CHARS = 32_000;

export class HubHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HubHttpError";
  }
}

const TERMINAL: MessageStatus[] = ["replied", "cancelled", "expired", "error"];
export const isTerminal = (m: MessageRecord) => TERMINAL.includes(m.status) || Date.parse(m.expiresAt) <= Date.now();
/** the hub says the message is already settled (or gone) */
export const isTerminalError = (e: unknown) =>
  e instanceof HubHttpError && (e.statusCode === 409 || (e.statusCode === 404 && e.code === "message_not_found"));

export class HubClient {
  agent?: AgentRecord;
  key?: string;
  private stopped = true;
  private events?: AbortController;
  private heartbeat?: NodeJS.Timeout;
  private loop?: Promise<void>;

  constructor(readonly options: HubOptions) {
    if (options.identity) {
      this.agent = {
        id: options.identity.id,
        name: options.name,
        purpose: options.purpose,
        project: options.project,
        online: true,
      };
      this.key = options.identity.key;
    }
  }

  /** registers, then streams this agent's events to `onEvent` (reconnecting) until `stop` */
  async start(onEvent: (event: HubEvent) => void | Promise<void>): Promise<AgentRecord> {
    this.stopped = false;
    const { agent, agentKey } = await this.request<{ agent: AgentRecord; agentKey: string }>(
      "/v1/agents/register",
      {
        method: "POST",
        body: JSON.stringify({
          name: this.options.name,
          purpose: this.options.purpose,
          project: this.options.project,
          model: this.options.model,
          host: hostname().slice(0, 64),
        }),
      },
      false,
    );
    this.agent = agent;
    this.key = agentKey;
    this.heartbeat = setInterval(
      () => void this.request(`/v1/agents/${agent.id}/heartbeat`, { method: "POST", body: "{}" }).catch(() => {}),
      10_000,
    );
    this.heartbeat.unref();
    this.loop = this.eventLoop(onEvent);
    return agent;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.events?.abort();
    clearInterval(this.heartbeat);
    await this.loop;
    if (this.agent) await this.request(`/v1/agents/${this.agent.id}`, { method: "DELETE" }).catch(() => {});
    this.agent = undefined;
  }

  listAgents(includeOffline = false) {
    return this.request<{ agents: AgentRecord[] }>(`/v1/agents${includeOffline ? "?includeOffline=true" : ""}`).then(
      (r) => r.agents,
    );
  }
  send(options: SendOptions) {
    return this.message("/v1/messages", { method: "POST", body: JSON.stringify(options) });
  }
  getMessage(id: string) {
    return this.message(`/v1/messages/${encodeURIComponent(id)}`);
  }
  acknowledge(id: string) {
    return this.message(`/v1/messages/${encodeURIComponent(id)}/ack`, { method: "POST", body: "{}" });
  }
  reply(id: string, content: string) {
    return this.message(`/v1/messages/${encodeURIComponent(id)}/reply`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }
  cancel(id: string) {
    return this.message(`/v1/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  recordWorkflowEntry(runId: string, entry: Record<string, unknown>) {
    return this.request(`/v1/workflows/${encodeURIComponent(runId)}/journal`, {
      method: "POST",
      body: JSON.stringify(entry),
    });
  }

  /** polls `id` until it is terminal; throws when `timeoutMs` passes or `signal` aborts */
  async awaitResponse(id: string, timeoutMs: number, signal?: AbortSignal): Promise<MessageRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const m = await this.getMessage(id);
      if (TERMINAL.includes(m.status)) return m;
      await new Promise((r) => setTimeout(r, Math.min(500, Math.max(1, deadline - Date.now()))));
    }
    throw new Error(`timed out waiting for ${id}`);
  }

  private async message(path: string, init?: RequestInit) {
    return (await this.request<{ message: MessageRecord }>(path, init)).message;
  }

  private headers(identity = true): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.options.authToken && { authorization: `Bearer ${this.options.authToken}` }),
      ...(identity && this.agent && this.key && { "x-kxm-agent-id": this.agent.id, "x-kxm-agent-key": this.key }),
    };
  }

  private async request<T>(path: string, init: RequestInit = {}, identity = true): Promise<T> {
    const res = await this.options.fetch(`${this.options.serverUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(15_000),
      headers: this.headers(identity),
    });
    const text = await res.text();
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (!res.ok)
      throw new HubHttpError(
        res.status,
        String(body.error ?? `HTTP ${res.status}`),
        typeof body.code === "string" ? body.code : undefined,
      );
    return body as T;
  }

  private async eventLoop(onEvent: (event: HubEvent) => void | Promise<void>) {
    while (!this.stopped && this.agent) {
      this.events = new AbortController();
      try {
        const res = await this.options.fetch(
          `${this.options.serverUrl.replace(/\/$/, "")}/v1/events?agentId=${encodeURIComponent(this.agent.id)}`,
          { headers: this.headers(), signal: this.events.signal },
        );
        if (!res.ok || !res.body) throw new Error(`event stream failed with HTTP ${res.status}`);
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
          for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
            const data = buffer
              .slice(0, i)
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            buffer = buffer.slice(i + 2);
            const parsed = data ? JSON.parse(data) : undefined;
            if (parsed && "type" in parsed) await onEvent(parsed);
          }
        }
      } catch {
        if (this.stopped) return;
      }
      if (!this.stopped) await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

const WORKFLOW_RUN_ID = /^run_[a-f0-9]{32}$/;

/** The hub-authorized workflow run a message belongs to (never a caller's bare correlation id). */
export function workflowRunId(m: Pick<MessageRecord, "workflowRunId" | "workflowContext" | "correlationId" | "from">) {
  if (m.workflowRunId !== undefined) {
    if (!WORKFLOW_RUN_ID.test(m.workflowRunId)) return undefined;
    if (m.workflowContext?.runId && m.workflowContext.runId !== m.workflowRunId) return undefined;
    return m.workflowRunId;
  }
  if (m.workflowContext?.runId && WORKFLOW_RUN_ID.test(m.workflowContext.runId)) return m.workflowContext.runId;
  if (m.correlationId && WORKFLOW_RUN_ID.test(m.correlationId) && m.from === `workflow:${m.correlationId}`)
    return m.correlationId;
  return undefined;
}

/** A reply cut to the hub's message limit, saying so. */
export function boundedReply(reply: string): string {
  if (reply.length <= MAX_CONTENT_CHARS) return reply;
  const suffix = `\n\n[kxm: response truncated from ${reply.length} characters to fit the message limit; the full output may remain in the replying agent's local session or worker log]`;
  return reply.slice(0, MAX_CONTENT_CHARS - suffix.length) + suffix;
}

/** What an inbound request becomes as a turn's prompt. */
export const inboundPrompt = (m: MessageRecord) =>
  [
    `Peer request from ${m.fromName} (message ${m.id}):`,
    "",
    m.content,
    "",
    "Respond directly to the peer request. Your settled final response will be returned automatically.",
  ].join("\n");

const priority = (d: DeliveryMode) => (d === "steer" ? 0 : d === "followUp" ? 1 : 2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

/**
 * An agent's activation queue: the hub stays the durable queue; inbound requests wait here in delivery order (steer,
 * followUp, nextTurn), and one at a time is acknowledged, handed to `handle` and, when that returns a reply, replied
 * to (retrying until the hub takes it, unless the request was settled meanwhile). `handle` returning undefined
 * retains it: acknowledged, unreplied.
 */
export class Inbox {
  pending: MessageRecord[] = [];
  active?: MessageRecord;
  private stopped = false;
  private retryMs = 250;

  constructor(
    private client: HubClient,
    private handle: (m: MessageRecord) => Promise<string | undefined>,
    private notify: (text: string, level: "warn" | "error") => void,
    /** the active request was settled elsewhere (cancelled, expired, replied) */
    private onSettled?: (id: string) => void,
  ) {}

  receive = (event: HubEvent) => {
    if (event.type === "presence" || this.stopped) return;
    const m = event.message;
    if (event.type === "message") {
      if (this.active?.id === m.id || this.pending.some((p) => p.id === m.id) || isTerminal(m)) return;
      const i = this.pending.findIndex((p) => priority(p.delivery) > priority(m.delivery));
      this.pending.splice(i < 0 ? this.pending.length : i, 0, m);
      void this.pump();
      return;
    }
    this.pending = this.pending.filter((p) => p.id !== m.id);
    if (this.active?.id === m.id) this.onSettled?.(m.id);
  };

  stop() {
    this.stopped = true;
  }

  private async pump(): Promise<void> {
    if (this.active || this.stopped) return;
    let m = this.pending.shift();
    while (m && isTerminal(m)) m = this.pending.shift();
    if (!m) return;
    this.active = m;
    try {
      let acked: MessageRecord;
      try {
        acked = await this.client.acknowledge(m.id);
        this.retryMs = 250;
      } catch (e) {
        if (isTerminalError(e)) return;
        this.pending.unshift(m);
        this.notify(
          `kxm could not activate the next hub message; it remains durable and activation will retry in ${this.retryMs}ms: ${errorText(e)}`,
          "error",
        );
        await sleep(this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 30_000);
        return;
      }
      const reply = await this.handle(acked);
      if (reply !== undefined) await this.settle(m.id, boundedReply(reply));
    } catch (e) {
      this.notify(`kxm failed handling ${m.id}: ${errorText(e)}`, "error");
    } finally {
      this.active = undefined;
      void this.pump();
    }
  }

  private async settle(id: string, reply: string) {
    for (let delay = 250; !this.stopped; delay = Math.min(delay * 2, 30_000)) {
      try {
        if (!TERMINAL.includes((await this.client.getMessage(id)).status)) await this.client.reply(id, reply);
        return;
      } catch (e) {
        if (isTerminalError(e)) return;
        this.notify(
          `kxm could not return reply for ${id}; settlement will retry in ${delay}ms: ${errorText(e)}`,
          "error",
        );
        await sleep(delay);
      }
    }
  }
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
