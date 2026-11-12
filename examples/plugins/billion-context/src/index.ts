import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Ctx, hortusDir, type Plugin, type Session, stateOf, type Tool, tool } from "@hortus/core";
import { z } from "zod";
import { type DelegateConfig, delegateTools, fleet, runsOf } from "./delegate.ts";
import { type GuardConfig, type GuardState, onToolCall, onToolResult } from "./guard.ts";

/** `~/.hortus/<plugin>.json` (Pi: `~/.config/billion-context/billion-context.json`). */
export interface Config {
  /** the bili proxy (`http://127.0.0.1:<port>`); env `BILLION_CONTEXT_PROXY` wins. Not needed when a provider's
   *  endpoint already routes through it (`http://<proxy>/bili/https://api.anthropic.com`) */
  proxy?: string;
  guardrails?: GuardConfig;
  subagents?: false | DelegateConfig;
}

/** What the plugin tells the proxy it is, as Pi's sends `pi`. */
export const AGENT = "hortus";
/** The header the `request` handler stamps every call of a conversation with; the provider wrap routes those. */
const STAMP = "x-bili-plugin-conversation";

const MANIFEST_MS = 5000;
const STATUS_MS = 5000;
const TOOL_MS = 60_000;
const RETRY_MS = 10_000;

interface ManifestTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

/** Per agent, in `ctx.state`. */
interface State extends GuardState {
  config: Config;
  /** the proxy's tools, by proxy base (a failed load is dropped after RETRY_MS) */
  manifests: Map<string, Promise<Tool[] | undefined>>;
  /** compress's advertised maximum duration, by proxy base */
  maxToolMs: Map<string, number>;
  /** sessions whose requests carried the conversation header: the proxy owns their compaction */
  carried: Set<string>;
  /** sessions whose lineage was registered */
  registered: Set<string>;
  /** last runtime-info report by session */
  reported: Map<string, string>;
  /** session-name subscriptions by session id */
  names: Map<string, () => void>;
}

const st = (ctx: Ctx) =>
  stateOf(
    ctx,
    "bili",
    (): State => ({
      config: {},
      manifests: new Map(),
      maxToolMs: new Map(),
      carried: new Set(),
      registered: new Set(),
      reported: new Map(),
      names: new Map(),
      trackers: new Map(),
      warns: new Map(),
    }),
  );

const BILI_PATH = /^(https?:\/\/[^/]+)\/bili\/(?:responses\/)?https?:\/\//;

/**
 * The proxy for `endpoint` (the provider's): its origin when the endpoint already goes through it (`routed`), else
 * `BILLION_CONTEXT_PROXY`, else the config's. `BILLION_CONTEXT_PLUGIN=0` turns the plugin's proxy side off.
 */
function proxyFor(ctx: Ctx, endpoint?: string): { base: string; routed: boolean } | undefined {
  if (process.env.BILLION_CONTEXT_PLUGIN === "0") return;
  const m = endpoint?.match(BILI_PATH);
  if (m?.[1]) return { base: m[1], routed: true };
  const raw = process.env.BILLION_CONTEXT_PROXY?.trim() || st(ctx).config.proxy;
  if (!raw) return;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? { base: u.origin, routed: false } : undefined;
  } catch {
    return;
  }
}

/** The proxy a run on the ctx's session would use (commands and other places outside a run resolve the provider). */
async function proxyOf(ctx: Ctx) {
  const endpoint = ctx.run
    ? ctx.run.endpoint
    : await ctx.resolve().then(
        (r) => r.endpoint,
        () => undefined,
      );
  return proxyFor(ctx, endpoint);
}

async function call(ctx: Ctx, url: string, body?: unknown, ms = STATUS_MS, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(ms);
  const res = await ctx.fetch(url, {
    method: body === undefined ? "GET" : "POST",
    ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await res.text();
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text);
  } catch {}
  return { ok: res.ok, status: res.status, json };
}

const post = (ctx: Ctx, base: string, path: string, body: unknown) =>
  call(ctx, `${base}${path}`, body).catch(() => undefined);

async function status(ctx: Ctx, base: string, sid: string) {
  const r = await call(ctx, `${base}/__bili/plugin/status?conversationId=${encodeURIComponent(sid)}`);
  return r.ok && r.json ? r.json : undefined;
}

/** Runs a proxy tool on the session's conversation (`POST /__bili/plugin/tool`). */
export async function forward(
  ctx: Ctx,
  base: string,
  name: string,
  args: unknown,
  callId?: string,
  signal?: AbortSignal,
): Promise<{ text: string; failed: boolean; details?: { outcome?: string; blocksCreated?: number } }> {
  const sid = ctx.session?.id;
  const advertised = st(ctx).maxToolMs.get(base);
  const ms = name === "compress" && advertised ? Math.max(TOOL_MS, advertised + 30_000) : TOOL_MS;
  const body = {
    conversationId: sid ?? "unknown",
    tool: name,
    args: args ?? {},
    ...(callId && { toolCallId: callId }),
    ...(sid && { nativeCaller: true }),
  };
  const { ok, status, json } = await call(ctx, `${base}/__bili/plugin/tool`, body, ms, signal);
  if (!ok || !json?.ok)
    throw new Error(`bili proxy tool ${name} failed (${status}): ${json?.error ?? "unknown error"}`);
  const outcome = typeof json.outcome === "string" ? json.outcome : undefined;
  const blocks = typeof json.blocksCreated === "number" ? json.blocksCreated : undefined;
  let text = typeof json.result === "string" ? json.result : "";
  if (outcome === "partial")
    text += `\n[acp-result: PARTIAL — ${blocks !== undefined ? `${blocks} block(s) created; ` : ""}some requested range(s) were NOT folded. Retry ONLY the failed range(s) listed above; do not re-fold the ranges that were applied.]`;
  const details = outcome !== undefined || blocks !== undefined ? { outcome, blocksCreated: blocks } : undefined;
  return { text, failed: outcome === "failure" || outcome === "refused", details };
}

/** A manifest tool as a hortus tool that the proxy runs (its schema declared as served). */
function proxyTool(plugin: string, base: string, t: ManifestTool): Tool {
  const def = tool({
    name: t.name,
    description: t.description ?? "",
    jsonSchema: t.input_schema ?? { type: "object", properties: {} },
    inputSchema: z.looseObject({}),
    execute: async (input, ctx) => {
      const out = await forward(ctx, base, t.name, input, ctx.callId, ctx.signal);
      if (out.details) ctx.update(out.details);
      if (out.failed) throw new Error(out.text);
      return out.text;
    },
  });
  // pushed tools get no `plugin` from core; this one's ctx.state is the plugin's
  return { ...def, plugin };
}

/** The proxy's tools (`GET /__bili/plugin/manifest`), once per proxy; a failure is retried after RETRY_MS. */
function manifest(ctx: Ctx, base: string): Promise<Tool[] | undefined> {
  const s = st(ctx);
  let p = s.manifests.get(base);
  if (!p) {
    p = (async () => {
      const { ok, status, json } = await call(ctx, `${base}/__bili/plugin/manifest`, undefined, MANIFEST_MS);
      const tools = (json?.tools as { anthropic?: ManifestTool[] } | undefined)?.anthropic?.filter(
        (t) => typeof t.name === "string",
      );
      if (!ok || !tools?.length) throw new Error(`manifest fetch failed: ${status}`);
      const max = (json?.capabilities as { externalSummary?: { maxToolDurationMs?: number } } | undefined)
        ?.externalSummary?.maxToolDurationMs;
      if (typeof max === "number" && max > 0) s.maxToolMs.set(base, max);
      return tools.map((t) => proxyTool(ctx.plugin, base, t));
    })().catch((e) => {
      void ctx.notify(`bili: ${e instanceof Error ? e.message : e} — retrying in ${RETRY_MS / 1000}s`, "warn");
      setTimeout(() => s.manifests.delete(base), RETRY_MS).unref();
      return undefined;
    });
    s.manifests.set(base, p);
  }
  return p;
}

/** The conversation this session derives from: a subrun's caller, or (`hortus --parent`) a delegate's parent. */
const parentOf = (ctx: Ctx) => ctx.run?.parent?.session;

/** Reports the session's name to the proxy now and on every change, until the session closes. */
function watchName(ctx: Ctx, session: Session) {
  const s = st(ctx);
  if (s.names.has(session.id)) return;
  const report = async (name: string) => {
    const proxy = await proxyOf(ctx);
    if (proxy) await post(ctx, proxy.base, "/__bili/plugin/session-name", { conversationId: session.id, name });
  };
  const initial = session.getState().name;
  if (initial) void report(initial);
  s.names.set(
    session.id,
    session.subscribe((now, prev) => {
      if (now.name !== prev.name) void report(now.name ?? "");
    }),
  );
}

const STATUS_NUM = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const tok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

/** Pi's fallback rendering of `/__bili/plugin/status` when the proxy sends no `panel`. */
export function renderStatus(s: Record<string, unknown>): string {
  const [ctxTok, limit, input, output, cached, requests] = [
    s.contextTokens,
    s.contextLimit,
    s.inputTokens,
    s.outputTokens,
    s.cachedTokens,
    s.requests,
  ].map(STATUS_NUM);
  const blocks = Array.isArray(s.blocks) ? (s.blocks as { active?: boolean }[]) : [];
  const lines = ["ACP status"];
  if (ctxTok !== undefined)
    lines.push(`  context: ${tok(ctxTok)}${limit ? ` / ${tok(limit)} (${((ctxTok / limit) * 100).toFixed(1)}%)` : ""}`);
  if (input !== undefined || output !== undefined || cached !== undefined)
    lines.push(`  in/out/cached: ${tok(input ?? 0)} / ${tok(output ?? 0)} / ${tok(cached ?? 0)}`);
  if (requests !== undefined) lines.push(`  requests: ${requests}`);
  if (blocks.length) lines.push(`  blocks: ${blocks.length} (${blocks.filter((b) => b.active).length} active)`);
  return lines.join("\n");
}

const NO_PROXY =
  "bili: no proxy detected — set `proxy` in ~/.hortus/billion-context.json (or BILLION_CONTEXT_PROXY), or a /bili/ endpoint";

/** A command running a proxy tool on the current conversation. */
async function proxyCommand(ctx: Ctx, name: string, args: Record<string, unknown>) {
  const proxy = await proxyOf(ctx);
  if (!proxy) throw new Error(NO_PROXY);
  const out = await forward(ctx, proxy.base, name, args);
  if (out.failed) throw new Error(`bili: ${name} failed: ${out.text}`);
  return out.text;
}

const delegateConfig = (ctx: Ctx): DelegateConfig => st(ctx).config.subagents || {};
const DELEGATE_TOOLS = new Set(["acp_delegate", "acp_delegate_wait", "acp_delegate_cancel"]);

/**
 * billion-context's client side (Pi's `pi-native` extension): routes every provider's traffic through a bili proxy,
 * which compresses the conversation and serves `compress`/`decompress`/`search_context`/`acp_status`; stamps each
 * request with the conversation (the session), its window and model; registers a child conversation's lineage; stands
 * builtin:compaction down for sessions the proxy compresses; adds Pi's tool guardrails; and runs delegates (Pi's
 * built-in subagents) as headless `hortus -p --json` processes whose results come back as steered messages.
 */
export default {
  providers: {
    // a call the `request` handler stamped goes through the proxy (unless the endpoint already does): the wrap gets
    // this plugin's ctx, so it reads the same config
    "*": {
      wrap: (Default, pctx) => ({
        ...Default,
        create: (entry, opts) => {
          const base = opts.fetch ?? globalThis.fetch;
          return Default.create(entry, {
            ...opts,
            fetch: (url, init) => {
              const proxy = proxyFor(pctx, entry.endpoint);
              if (!proxy || proxy.routed || url instanceof Request || !new Headers(init?.headers).has(STAMP))
                return base(url, init);
              return base(`${proxy.base}/bili/${url}`, init);
            },
          });
        },
      }),
    },
  },
  tools: delegateTools(delegateConfig),
  commands: [
    {
      name: "acp",
      description: "Show ACP context-compression status for this session",
      run: async (_, ctx) => {
        const proxy = await proxyOf(ctx);
        if (!proxy) throw new Error(NO_PROXY);
        const s = ctx.session && (await status(ctx, proxy.base, ctx.session.id));
        if (s) return typeof s.panel === "string" ? s.panel : renderStatus(s);
        const m = await call(ctx, `${proxy.base}/__bili/plugin/manifest`).catch(() => undefined);
        const version = m?.ok && typeof m.json?.version === "string" ? m.json.version : undefined;
        if (!version) throw new Error("bili: no ACP session yet (send a model request first, then run /acp)");
        return `billion-context@${version} — proxy connected via ${proxy.base}, compression armed. No model request yet; send one, then run /acp again.`;
      },
    },
    {
      name: "acp-cache",
      description: "Prompt-cache reconciliation for this session (same report as the acp_cache tool)",
      args: "[full]",
      run: (arg, ctx) => proxyCommand(ctx, "acp_cache", /(^|\s)(--)?full(\s|$)/.test(arg) ? { detail: "full" } : {}),
    },
    {
      name: "acp-rule",
      description: "Persistent rules for this session (same ops as the acp_rule tool)",
      args: "[text to record] | remove <id> | clear",
      run: (arg, ctx) => {
        const raw = arg.trim();
        if (raw === "remove" || raw.startsWith("remove ")) {
          const id = raw.slice("remove".length).trim();
          if (!id) throw new Error("Usage: /acp-rule remove <rule-id> — bare /acp-rule lists the recorded ids");
          return proxyCommand(ctx, "acp_rule", { delete: id });
        }
        return proxyCommand(ctx, "acp_rule", raw === "" ? {} : raw === "clear" ? { clear: true } : { rule: raw });
      },
    },
    {
      name: "acp-fleet",
      description: "List acp_delegate runs (live and finished)",
      run: (_, ctx) => fleet(ctx),
    },
  ],
  on: {
    init: async (_, ctx) => {
      const path = join(hortusDir(), `${ctx.plugin}.json`);
      st(ctx).config = await readFile(path, "utf8").then(
        (t) => JSON.parse(t) as Config,
        (e) => {
          if (e?.code !== "ENOENT") void ctx.notify(`bili: ${path}: ${e}`, "error");
          return {};
        },
      );
    },
    // the proxy's tools join every run; a child conversation tells the proxy whose it is (decompress falls back to it)
    run_start: async (p, ctx) => {
      const cfg = delegateConfig(ctx);
      if (st(ctx).config.subagents === false || (ctx.run?.depth ?? 0) >= (cfg.maxDepth ?? 2))
        p.tools = p.tools.filter((t) => !DELEGATE_TOOLS.has(t.name));
      const proxy = proxyFor(ctx, ctx.run?.endpoint);
      if (!proxy || !ctx.session) return;
      const tools = await manifest(ctx, proxy.base);
      if (!tools) return;
      for (const t of tools) if (!p.tools.some((x) => x.name === t.name)) p.tools.push(t);
      const sid = ctx.session.id;
      const parent = parentOf(ctx);
      const s = st(ctx);
      if (parent && !s.registered.has(sid)) {
        const body = { conversationId: sid, agent: AGENT, identity: true, parentConversationId: parent };
        const r = await post(ctx, proxy.base, "/__bili/plugin/register", body);
        if (r?.ok) s.registered.add(sid);
      }
    },
    // stamp every call of a session once the proxy's tools are in: the proxy keys its state on the conversation
    request: async (req, ctx) => {
      if (req.source === "preview" || !ctx.session) return;
      const proxy = proxyFor(ctx, ctx.run?.endpoint);
      if (!proxy || !(await manifest(ctx, proxy.base))) return;
      const sid = ctx.session.id;
      const info = ctx.run?.info ?? {};
      const ascii = /^[\x21-\x7e]{1,256}$/.test(req.model);
      req.headers = {
        ...req.headers,
        "x-bili-plugin": AGENT,
        [STAMP]: sid,
        ...(info.contextWindow && { "x-bili-plugin-context-window": String(info.contextWindow) }),
        ...(ascii && { "x-bili-plugin-model": req.model }),
        ...(req.maxTokens && { "x-bili-plugin-max-output": String(req.maxTokens) }),
      };
      const s = st(ctx);
      s.carried.add(sid);
      const report = {
        agent: AGENT,
        conversationId: sid,
        model: req.model,
        contextWindow: info.contextWindow,
        maxOutput: req.maxTokens,
        baseURL: ctx.run?.endpoint,
        source: "client-config",
      };
      const key = JSON.stringify(report);
      if (s.reported.get(sid) !== key) {
        s.reported.set(sid, key);
        void post(ctx, proxy.base, "/__bili/plugin/runtime-info", report).then((r) => {
          if (!r?.ok) s.reported.delete(sid);
        });
      }
    },
    // the proxy folds the context itself: builtin:compaction's automatic ones stand down (a manual /compact still runs)
    compact: async (p, ctx) => {
      if (p.reason === "manual" || !ctx.session) return;
      const proxy = await proxyOf(ctx);
      if (!proxy) return;
      const sid = ctx.session.id;
      if (st(ctx).carried.has(sid)) p.cancel = true;
      else
        try {
          if (await status(ctx, proxy.base, sid)) p.cancel = true;
        } catch (e) {
          void ctx.notify(`bili: compaction ownership probe failed (${e}) — leaving compaction enabled`, "warn");
        }
    },
    compacted: async (_, ctx) => {
      const proxy = await proxyOf(ctx);
      if (proxy && ctx.session)
        await post(ctx, proxy.base, "/__bili/plugin/compact", { conversationId: ctx.session.id });
    },
    session_open: ({ session }, ctx) => watchName(ctx, session),
    session_closed: ({ session }, ctx) => {
      const s = st(ctx);
      s.names.get(session.id)?.();
      s.names.delete(session.id);
      s.trackers.delete(session.id);
    },
    tool_call: (p, ctx) => onToolCall(p, ctx, st(ctx), st(ctx).config.guardrails ?? {}),
    tool_result: (p, ctx) => onToolResult(p, ctx.session?.id ?? "", st(ctx), st(ctx).config.guardrails ?? {}),
    // a person's prompt restarts the repetition count (Pi: any input not from an extension)
    input: (p, ctx) => {
      if (p.source === "user")
        st(ctx)
          .trackers.get(ctx.session?.id ?? "")
          ?.reset();
    },
    close: (_, ctx) => {
      for (const r of runsOf(ctx).values()) if (r.status === "running") r.child.kill();
    },
  },
} satisfies Plugin;
