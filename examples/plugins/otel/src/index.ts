import { randomBytes } from "node:crypto";
import type { AssistantMessage, Ctx, Message, Plugin, Tool } from "@hortus/core";

declare module "@hortus/core" {
  interface Events {
    /** a traced run started (pi-otel's `pi-otel:trace-active`), e.g. for a status line linking to the trace */
    "otel:trace-active": { traceId: string };
  }
}

type Attr = string | number | boolean | string[];
type Attrs = Record<string, Attr>;
type Capture = "metadata_only" | "no_tool_content" | "full";

/** One span, as OTLP/JSON wants it once `end` is set. */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** OTLP SpanKind: 1 internal, 3 client */
  kind: number;
  /** epoch ms */
  start: number;
  end?: number;
  attributes: Attrs;
  events: { name: string; time: number; attributes: Attrs }[];
  status?: { code: 2; message: string };
}

export interface Config {
  /** base URL; spans go to `<endpoint>/v1/traces` */
  endpoint: string;
  headers: Record<string, string>;
  serviceName: string;
  resource: Record<string, string>;
  capture: Capture;
  /** `invoke_agent`/`chat`/`execute_tool` names (pi-otel's `spanNaming: "genai"`) instead of `hortus.*` */
  genai: boolean;
  /** `TRACEPARENT` into `bash` commands, so instrumented children nest under the tool span */
  propagateToShell: boolean;
}

const kv = (s = "") =>
  Object.fromEntries(
    s.split(",").flatMap((pair) => {
      const eq = pair.indexOf("=");
      const k = pair.slice(0, eq).trim();
      if (eq <= 0 || !k) return [];
      const v = pair.slice(eq + 1).trim();
      try {
        return [[k, decodeURIComponent(v)]];
      } catch {
        return [[k, v]];
      }
    }),
  );

/**
 * pi-otel's settings, from the environment only: the standard `OTEL_*` variables and `HORTUS_OTEL_*` for pi-otel's own
 * (`PI_OTEL_*`). Undefined = disabled.
 */
export function config(env = process.env): Config | undefined {
  const on = (v?: string) => v === "1" || v === "true";
  if (on(env.HORTUS_OTEL_DISABLED)) return undefined;
  const c = env.HORTUS_OTEL_CAPTURE_CONTENT;
  return {
    // ponytail: OTLP/JSON over HTTP only (pi-otel defaults to gRPC on 4317); add protobuf/gRPC with an exporter dep
    endpoint: (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318").replace(/\/+$/, ""),
    headers: kv(env.OTEL_EXPORTER_OTLP_HEADERS),
    serviceName: env.OTEL_SERVICE_NAME ?? "hortus",
    resource: kv(env.OTEL_RESOURCE_ATTRIBUTES),
    capture: c === "full" || c === "true" ? "full" : c === "no_tool_content" ? c : "metadata_only",
    genai: env.HORTUS_OTEL_SPAN_NAMING?.trim().toLowerCase() === "genai",
    propagateToShell: on(env.HORTUS_OTEL_PROPAGATE_TO_SHELL),
  };
}

const SYSTEM = "hortus";
const MAX_ATTR_BYTES = 60 * 1024;

/** A string attribute of at most ~60 KB (pi-otel's, after Claude Code). */
export function clampAttr(value: unknown): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    s = String(value);
  }
  if (Buffer.byteLength(s) <= MAX_ATTR_BYTES) return s;
  let end = MAX_ATTR_BYTES;
  while (Buffer.byteLength(s.slice(0, end)) > MAX_ATTR_BYTES - 32) end -= 64;
  return `${s.slice(0, end)}…[truncated]`;
}

/** Provider types whose name differs from semconv's `gen_ai.provider.name`. */
const PROVIDER_NAMES: Record<string, string> = { "openai-responses": "openai" };

interface RunState {
  cfg: Config;
  root: Span;
  turn?: Span;
  turns: number;
  tools: number;
  /** open spans by request id and tool call id */
  open: Map<string, Span>;
  /** `gen_ai.input.messages` of each open LLM span */
  inputs: Map<string, unknown[]>;
  all: Span[];
}

/** Traced runs by run id; nothing in it is shared between runs. */
const runs = new Map<string, RunState>();
/** How many runs are being traced (none once `close` flushed them). */
export const openRuns = () => runs.size;
const state = (ctx: Ctx) => (ctx.run ? runs.get(ctx.run.id) : undefined);

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const errorOf = (e: unknown) =>
  e instanceof Error ? { type: e.name, message: e.message } : { type: "Error", message: String(e) };

function common(ctx: Ctx): Attrs {
  const attrs: Attrs = { "gen_ai.system": SYSTEM };
  if (ctx.run) attrs["hortus.cwd"] = ctx.run.cwd;
  const sid = ctx.session?.id;
  if (sid) Object.assign(attrs, { "hortus.session.id": sid, "session.id": sid, "gen_ai.conversation.id": sid });
  return attrs;
}

/** Opens a span under `parent` (none: a new trace); genai naming sets the operation and its kind. */
function open(
  st: Pick<RunState, "cfg" | "all">,
  parent: Span | undefined,
  names: [legacy: string, genai: string],
  attrs: Attrs,
  op?: { name: string; kind: number },
): Span {
  const genai = st.cfg.genai && op;
  if (genai) attrs["gen_ai.operation.name"] = op.name;
  const span: Span = {
    traceId: parent?.traceId ?? hex(16),
    spanId: hex(8),
    ...(parent && { parentSpanId: parent.spanId }),
    name: genai ? names[1] : names[0],
    kind: genai ? op.kind : 1,
    start: Date.now(),
    attributes: attrs,
    events: [],
  };
  st.all.push(span);
  return span;
}

function fail(span: Span, e: unknown) {
  const { type, message } = errorOf(e);
  span.attributes["error.type"] = type;
  span.status = { code: 2, message };
}

export const traceparent = (span: Span) => `00-${span.traceId}-${span.spanId}-01`;

/** The new input of a request (after the last assistant message) as span events and `gen_ai.input.messages`. */
function noteInput(st: RunState, span: Span, messages: Message[]) {
  const inputs: unknown[] = [];
  st.inputs.set(span.spanId, inputs);
  if (st.cfg.capture === "metadata_only") return;
  const last = messages.map((m) => m.role).lastIndexOf("assistant");
  const prev = messages[last] as AssistantMessage | undefined;
  for (const m of messages.slice(last + 1)) {
    if (m.role === "user") {
      const attributes = { "gen_ai.system": SYSTEM, role: "user", content: clampAttr(m.content) };
      span.events.push({ name: "gen_ai.user.message", time: Date.now(), attributes });
      inputs.push({ role: "user", parts: [{ type: "text", content: m.content }] });
    } else if (m.role === "tool" && st.cfg.capture === "full") {
      for (const r of m.results) {
        const name = prev?.toolCalls.find((c) => c.id === r.id)?.name;
        const attributes = {
          "gen_ai.system": SYSTEM,
          role: "tool",
          id: r.id,
          ...(name && { name }),
          content: clampAttr(r.output),
        };
        span.events.push({ name: "gen_ai.tool.message", time: Date.now(), attributes });
        inputs.push({
          role: "tool",
          parts: [{ type: "tool_call_response", id: r.id, ...(name && { name }), response: r.output }],
        });
      }
    }
  }
}

/** The reply as `gen_ai.assistant.message`/`gen_ai.choice` events and `gen_ai.{input,output}.messages`. */
function noteOutput(st: RunState, span: Span, a: AssistantMessage, finish: string) {
  if (st.cfg.capture === "metadata_only") return;
  const full = st.cfg.capture === "full";
  const calls = a.toolCalls.map((c) => ({
    id: c.id,
    type: "function",
    function: { name: c.name, ...(full && { arguments: JSON.stringify(c.input) }) },
  }));
  const message = { role: "assistant", ...(a.text && { content: a.text }), ...(calls.length && { tool_calls: calls }) };
  span.events.push({
    name: "gen_ai.assistant.message",
    time: Date.now(),
    attributes: {
      "gen_ai.system": SYSTEM,
      role: "assistant",
      ...(a.text && { content: clampAttr(a.text) }),
      ...(calls.length && { tool_calls: clampAttr(calls) }),
    },
  });
  span.events.push({
    name: "gen_ai.choice",
    time: Date.now(),
    attributes: { "gen_ai.system": SYSTEM, index: 0, finish_reason: finish, message: clampAttr(message) },
  });
  const parts: unknown[] = a.text ? [{ type: "text", content: a.text }] : [];
  if (full) for (const c of calls) parts.push({ type: "tool_call", id: c.id, ...c.function });
  const inputs = st.inputs.get(span.spanId);
  if (inputs?.length) span.attributes["gen_ai.input.messages"] = clampAttr(inputs);
  span.attributes["gen_ai.output.messages"] = clampAttr([{ role: "assistant", parts, finish_reason: finish }]);
}

const value = (v: Attr) =>
  Array.isArray(v)
    ? { arrayValue: { values: v.map((s) => ({ stringValue: s })) } }
    : typeof v === "string"
      ? { stringValue: v }
      : typeof v === "boolean"
        ? { boolValue: v }
        : Number.isInteger(v)
          ? { intValue: String(v) }
          : { doubleValue: v };
const attributes = (a: Attrs) => Object.entries(a).map(([key, v]) => ({ key, value: value(v) }));
const nanos = (ms: number) => `${BigInt(ms) * 1_000_000n}`;

/** The OTLP/JSON `ExportTraceServiceRequest` for `spans`. */
export function otlp(cfg: Config, spans: Span[]) {
  return {
    resourceSpans: [
      {
        resource: { attributes: attributes({ ...cfg.resource, "service.name": cfg.serviceName }) },
        scopeSpans: [
          {
            scope: { name: "hortus-otel", version: "0.1.0" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId && { parentSpanId: s.parentSpanId }),
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: nanos(s.start),
              endTimeUnixNano: nanos(s.end ?? s.start),
              attributes: attributes(s.attributes),
              events: s.events.map((e) => ({
                name: e.name,
                timeUnixNano: nanos(e.time),
                attributes: attributes(e.attributes),
              })),
              ...(s.status && { status: s.status }),
            })),
          },
        ],
      },
    ],
  };
}

// ponytail: warned once per process, not per collector; key it by endpoint if one process exports to several
let warned = false;

/**
 * Ends what is still open in `st` (an abort mid-call, or exit) and sends its spans to the collector; the first failure
 * is reported (`ctx.notify`), later ones dropped.
 */
function exportRun(st: RunState, ctx: Ctx) {
  st.root.attributes["hortus.turn_count"] = st.turns;
  st.root.attributes["hortus.tool_count"] = st.tools;
  const now = Date.now();
  for (const s of st.all) s.end ??= now;
  const fail = async (why: string) => {
    if (warned) return;
    warned = true;
    await ctx.notify(
      `otel: exporting traces to ${st.cfg.endpoint} failed (${why}); later failures are dropped`,
      "warn",
    );
  };
  return ctx
    .fetch(`${st.cfg.endpoint}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...st.cfg.headers },
      body: JSON.stringify(otlp(st.cfg, st.all)),
    })
    .then(
      (res) => (res.ok ? undefined : fail(`HTTP ${res.status}`)),
      (e) => fail(e instanceof Error ? e.message : String(e)),
    )
    .catch(() => {});
}

/**
 * pi-otel: an OpenTelemetry span tree per run, sent as OTLP/JSON to `<endpoint>/v1/traces` when the run ends.
 * `hortus.interaction` (`invoke_agent hortus`) ├ `hortus.turn` ├ `hortus.llm_request` (`chat <model>`) and
 * `hortus.tool.<name>` (`execute_tool <name>`); a tool's own `ctx.complete`/`ctx.runTool` nest under its span. Runs
 * still open at exit (a tool ignoring the abort) are exported in `close`, their open spans ended then.
 */
export default {
  tools: [
    {
      name: "bash",
      // nothing to propagate into when builtin:bash is disabled
      optional: true,
      wrap: (Default): Tool => ({
        ...Default,
        execute: (input, ctx) => {
          const st = state(ctx);
          const span = st?.cfg.propagateToShell && st.open.get(ctx.callId);
          return Default.execute(input, span ? { ...ctx, env: { ...ctx.env, TRACEPARENT: traceparent(span) } } : ctx);
        },
      }),
    },
  ],
  on: {
    run_start: async ({ source, messages }, ctx) => {
      const cfg = config();
      if (source !== "run" || !ctx.run || !cfg) return;
      const prompt = [...messages].reverse().find((m) => m.role === "user")?.content;
      const attrs = common(ctx);
      if (prompt !== undefined) {
        attrs["hortus.user_prompt_length"] = prompt.length;
        if (cfg.capture === "full") attrs["hortus.user_prompt"] = clampAttr(prompt);
      }
      if (cfg.genai) attrs["gen_ai.agent.name"] = SYSTEM;
      const base = { cfg, turns: 0, tools: 0, open: new Map<string, Span>(), inputs: new Map(), all: [] };
      // a subrun's trace goes on under the tool call (else the turn, the run) that started it
      const { runId, toolCallId } = ctx.run.parent ?? {};
      const up = runId ? runs.get(runId) : undefined;
      const parent = up && ((toolCallId && up.open.get(toolCallId)) || up.turn || up.root);
      const root = open(base, parent, ["hortus.interaction", `invoke_agent ${SYSTEM}`], attrs, {
        name: "invoke_agent",
        kind: 1,
      });
      const st: RunState = { ...base, root };
      runs.set(ctx.run.id, st);
      await ctx.emit("otel:trace-active", { traceId: st.root.traceId });
    },
    turn_start: ({ index }, ctx) => {
      const st = state(ctx);
      if (!st) return;
      st.turns = index + 1;
      st.turn = open(st, st.root, ["hortus.turn", "hortus.turn"], { ...common(ctx), "hortus.turn_index": index });
    },
    request: ({ id, model, messages, type }, ctx) => {
      const st = state(ctx);
      if (!st) return;
      // a tool's `ctx.complete` nests under that tool
      const parent = (ctx.callId && st.open.get(ctx.callId)) || st.turn || st.root;
      const attrs: Attrs = { ...common(ctx), "gen_ai.operation.name": "chat", "gen_ai.request.model": model };
      if (st.cfg.genai) attrs["gen_ai.provider.name"] = PROVIDER_NAMES[type] ?? type;
      const span = open(st, parent, ["hortus.llm_request", `chat ${model}`], attrs, { name: "chat", kind: 3 });
      st.open.set(id, span);
      noteInput(st, span, messages);
    },
    response: ({ id, request, assistant, error, meta }, ctx) => {
      const st = state(ctx);
      const span = st?.open.get(id);
      if (!st || !span) return;
      const a = span.attributes;
      if (meta?.status !== undefined) a["http.response.status_code"] = meta.status;
      const h = meta?.headers ?? {};
      const rid = meta?.responseId ?? h["x-request-id"] ?? h["request-id"] ?? h["anthropic-request-id"];
      if (rid) a["gen_ai.response.id"] = rid;
      a["gen_ai.response.model"] = meta?.model ?? request.model;
      if (meta?.stopReason) a["gen_ai.response.finish_reasons"] = [meta.stopReason];
      const u = assistant?.usage;
      if (u) {
        a["gen_ai.usage.input_tokens"] = u.input;
        a["gen_ai.usage.output_tokens"] = u.output;
        a["gen_ai.usage.cache_read_input_tokens"] = u.cacheRead;
        if (u.cacheWrite !== undefined) a["gen_ai.usage.cache_write_input_tokens"] = u.cacheWrite;
        if (u.cost !== undefined) a["hortus.cost.usd"] = u.cost;
      }
      if (assistant) noteOutput(st, span, assistant, meta?.stopReason ?? "stop");
      if (error !== undefined) fail(span, error);
      span.end = Date.now();
      st.open.delete(id);
      st.inputs.delete(span.spanId);
    },
    tool_call: ({ call }, ctx) => {
      const st = state(ctx);
      if (!st) return;
      // a tool's `ctx.runTool` nests under that tool; the model's calls are siblings of the request, in its turn
      const parent = (call.parentId && st.open.get(call.parentId)) || st.turn || st.root;
      const attrs: Attrs = {
        ...common(ctx),
        "hortus.tool.name": call.name,
        "hortus.tool.call_id": call.id,
        "gen_ai.tool.name": call.name,
        "gen_ai.tool.call.id": call.id,
      };
      if (st.cfg.capture === "full" && call.input !== undefined) {
        attrs["hortus.tool.input"] = attrs["gen_ai.tool.call.arguments"] = clampAttr(call.input);
      }
      const names: [string, string] = [`hortus.tool.${call.name}`, `execute_tool ${call.name}`];
      st.open.set(call.id, open(st, parent, names, attrs, { name: "execute_tool", kind: 1 }));
      st.tools++;
    },
    tool_result: ({ call, result }, ctx) => {
      const st = state(ctx);
      const span = st?.open.get(call.id);
      if (!st || !span) return;
      span.attributes["hortus.tool.is_error"] = !!result.isError;
      if (result.isError) span.status = { code: 2, message: result.output };
      if (st.cfg.capture === "full") {
        span.attributes["hortus.tool.output"] = span.attributes["gen_ai.tool.call.result"] = clampAttr(result.output);
      }
      span.end = Date.now();
      st.open.delete(call.id);
    },
    turn_end: (_, ctx) => {
      const st = state(ctx);
      if (!st?.turn) return;
      st.turn.end = Date.now();
      st.turn = undefined;
    },
    run_end: ({ error }, ctx) => {
      const st = state(ctx);
      if (!st || !ctx.run) return;
      runs.delete(ctx.run.id);
      if (error !== undefined) fail(st.root, error);
      // not awaited: a slow or absent collector never holds up the run
      void exportRun(st, ctx);
    },
    // runs exit cut off before their run_end; awaited, so they're sent before the process ends
    close: async (_, ctx) => {
      const open = [...runs.values()];
      runs.clear();
      for (const st of open) st.root.attributes["hortus.exit"] = true;
      await Promise.all(open.map((st) => exportRun(st, ctx)));
    },
  },
} satisfies Plugin;
