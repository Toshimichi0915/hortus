import { execSync } from "node:child_process";
import {
  type Ctx,
  EFFORTS,
  type Effort,
  expandSecret,
  type ModelInfo,
  type Plugin,
  type Provider,
  type Secret,
  type Usage,
} from "@hortus/core";

/** One `/model/info` row: a deployment behind a public route (`model_name`); several rows can share a route. */
interface Deployment {
  model_name?: string;
  litellm_params?: { model?: string };
  model_info?: {
    mode?: string | null;
    base_model?: string;
    litellm_provider?: string;
    supported_endpoints?: string[] | null;
    max_input_tokens?: number;
    max_output_tokens?: number;
    supports_vision?: boolean;
    supports_reasoning?: boolean;
    /** a complete list, read ahead of the per-level flags */
    reasoning_effort_levels?: string[];
    /** USD per token */
    input_cost_per_token?: number;
    output_cost_per_token?: number;
    cache_read_input_token_cost?: number;
    cache_creation_input_token_cost?: number;
    [flag: `supports_${string}_reasoning_effort`]: boolean | undefined;
  };
}

/** Which of hortus's providers speaks to the proxy for a route: Anthropic Messages, Responses or Chat Completions. */
type Protocol = "anthropic" | "responses" | "chat";

/** USD per token */
interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface Route {
  protocol: Protocol;
  info: ModelInfo;
  price?: Price;
}

// LiteLLM accepts the Messages schema only for Claude behind these adapters; a Claude-like alias alone isn't evidence
const CLAUDE_ADAPTERS = new Set([
  "anthropic",
  "bedrock",
  "bedrock_converse",
  "vertex_ai",
  "vertex_ai-anthropic_models",
]);
const CLAUDE = /(?:^|[./_-])(?:claude|opus|sonnet|haiku|fable)(?:$|[./_:-])/i;
const CHAT_MODES = new Set([undefined, null, "chat", "responses"]);

function protocol({ litellm_params: p, model_info: i }: Deployment): Protocol {
  if (CLAUDE_ADAPTERS.has(i?.litellm_provider ?? "") && [p?.model, i?.base_model].some((id) => id && CLAUDE.test(id)))
    return "anthropic";
  return i?.mode === "responses" || i?.supported_endpoints?.includes("/v1/responses") ? "responses" : "chat";
}

/** Pi's rule: low/medium/high unless denied, off/xhigh/max only when stated; nothing stated → every level offered. */
function efforts(i: NonNullable<Deployment["model_info"]>): Effort[] | undefined {
  if (i.supports_reasoning === false) return [];
  const levels = i.reasoning_effort_levels?.map((l) => (l === "none" ? "off" : l));
  const reported = (e: Effort) =>
    levels ? levels.includes(e) : i[`supports_${e === "off" ? "none" : e}_reasoning_effort`];
  if (i.supports_reasoning === undefined && EFFORTS.every((e) => reported(e) === undefined)) return undefined;
  return EFFORTS.filter((e) => reported(e) ?? ["low", "medium", "high"].includes(e));
}

function route(d: Deployment): Route {
  const i = d.model_info ?? {};
  const limit = (n?: number) => (n && n > 0 ? n : undefined);
  const { input_cost_per_token: input, output_cost_per_token: output } = i;
  return {
    protocol: protocol(d),
    info: {
      contextWindow: limit(i.max_input_tokens),
      maxOutput: limit(i.max_output_tokens),
      efforts: efforts(i),
      images: i.supports_vision,
    },
    price:
      input === undefined || output === undefined
        ? undefined
        : { input, output, cacheRead: i.cache_read_input_token_cost, cacheWrite: i.cache_creation_input_token_cost },
  };
}

/** `usage.input` includes the cache reads and writes, which have their own prices (the input price if unknown). */
export function cost(p: Price, u: Usage) {
  const write = u.cacheWrite ?? 0;
  return (
    (u.input - u.cacheRead - write) * p.input +
    u.output * p.output +
    u.cacheRead * (p.cacheRead ?? p.input) +
    write * (p.cacheWrite ?? p.input)
  );
}

/**
 * The proxy's routes: `/model/info` (admin metadata), else `/v1/models` (ids only), which keys without access to the
 * former can still read. ponytail: a route's first deployment speaks for it and wildcard routes are skipped; Pi reduces
 * every deployment conservatively, expands wildcards from `/v1/models` and falls back to `/health` on old proxies.
 */
async function discover(root: string, fetch: typeof globalThis.fetch): Promise<Map<string, Route>> {
  const res = await fetch(`${root}/model/info`);
  const rows = res.ok ? (((await res.json()) as { data?: Deployment[] }).data ?? []) : [];
  const routes = new Map<string, Route>();
  for (const d of rows)
    if (d.model_name && !d.model_name.includes("*") && !routes.has(d.model_name) && CHAT_MODES.has(d.model_info?.mode))
      routes.set(d.model_name, route(d));
  if (routes.size) return routes;
  const list = await fetch(`${root}/v1/models`);
  if (!list.ok) throw new Error(`LiteLLM ${root}/v1/models: ${list.status} ${await list.text()}`);
  for (const { id } of ((await list.json()) as { data?: { id?: string }[] }).data ?? [])
    if (id) routes.set(id, { protocol: "chat", info: {} });
  return routes;
}

/** The proxy root (no `/v1`); HTTPS unless loopback or `allowInsecureHttp`, so a key never crosses the network in clear. */
function proxyRoot({ endpoint, allowInsecureHttp }: Secret): string {
  if (!endpoint) throw new Error("A litellm secrets entry needs the proxy URL as `endpoint`");
  const { protocol, hostname } = new URL(endpoint);
  const loopback = hostname === "localhost" || hostname === "[::1]" || /^127\./.test(hostname);
  if (protocol !== "https:" && !(protocol === "http:" && (loopback || allowInsecureHttp === true)))
    throw new Error("The LiteLLM endpoint must use HTTPS except on loopback hosts (or set allowInsecureHttp)");
  return endpoint.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/**
 * Refreshes an SSO login (`refreshToken`, `tokenEndpoint`, `clientId?`, `expires` in epoch ms next to `endpoint`) once
 * `expires` passes, keeping the access token as `apiKey`. hortus runs this under the secrets.json lock and saves it, so
 * a rotated refresh token survives parallel processes.
 */
async function login(entry: Secret, refresh: boolean, fetch: typeof globalThis.fetch): Promise<Secret> {
  const { refreshToken, tokenEndpoint, clientId, expires } = entry;
  if (typeof refreshToken !== "string" || (!refresh && typeof expires === "number" && expires > Date.now()))
    return entry;
  // a token endpoint elsewhere would receive the refresh token (`auth` gets the entry as stored, so expand it here)
  const root = new URL(proxyRoot(expandSecret(entry)));
  if (typeof tokenEndpoint !== "string" || new URL(tokenEndpoint).origin !== root.origin)
    throw new Error("LiteLLM tokenEndpoint must be on the proxy's origin");
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  if (typeof clientId === "string") body.set("client_id", clientId);
  const res = await fetch(tokenEndpoint, { method: "POST", body });
  if (!res.ok) throw new Error(`LiteLLM token refresh failed (${res.status}); log in again`);
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    ...entry,
    apiKey: t.access_token,
    refreshToken: t.refresh_token ?? refreshToken,
    expires: Date.now() + (t.expires_in ?? 86_400) * 1000,
  };
}

/**
 * `/litellm:login [name]`, Pi's `/login litellm` with an API key: asks for the proxy URL (offering the ones already
 * known) and the key (masked), checks them against `/v1/models`, then saves them as the secrets.json entry `name`
 * (default "litellm"), keeping its other fields. Needs someone to answer (`ctx.ask`).
 */
async function loginCommand(arg: string, ctx: Ctx) {
  const name = arg.trim() || "litellm";
  const known = new Set((await ctx.secrets.find("litellm")).flatMap(({ entry }) => entry.endpoint ?? []));
  if (process.env.LITELLM_BASE_URL) known.add(process.env.LITELLM_BASE_URL);
  const endpoint = await ctx.ask({
    question: "LiteLLM proxy URL",
    options: [...known].map((label) => ({ label })),
    allowText: true,
  });
  if (typeof endpoint !== "string") throw new Error("Login cancelled");
  const root = proxyRoot({ type: "litellm", endpoint });
  const apiKey = await ctx.ask({ question: `API key for ${root}`, secret: true });
  if (typeof apiKey !== "string") throw new Error("Login cancelled");
  const res = await ctx.fetch(`${root}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`The proxy rejected the key (HTTP ${res.status}); nothing saved`);
  await ctx.secrets.update(name, (e) => ({ ...e, type: "litellm", endpoint: root, apiKey }));
  return `Logged in to ${root} as secrets.json entry "${name}"; pick a model with /model ${name}/<model>`;
}

/**
 * A LiteLLM proxy as one provider type: its routes become models, each sent through hortus's Anthropic, Responses or
 * Chat Completions provider as registered (so other plugins' wraps apply) pointed at the proxy, with the limits, efforts,
 * images and prices `/model/info` reports (hortus sends `info`'s `maxOutput` as the request's `maxTokens`). Each call
 * carries the run's session id (`x-litellm-session-id`), and a reply's cost is what the proxy says it charged
 * (`x-litellm-response-cost`, read in `response`), else its listed price. secrets.json: `{ type: "litellm", endpoint, apiKey? | apiKeyHelper? (a command printing a key) | SSO fields (see
 * `login`), headers? ({ name: value }), allowInsecureHttp? }`.
 */
export default {
  commands: [
    {
      name: "litellm:login",
      args: "[name]",
      description: "Log in to a LiteLLM proxy with an API key",
      run: loginCommand,
    },
  ],
  on: {
    // what the proxy says it charged (in a header of the response, whichever provider protocol carried it)
    response: ({ assistant, meta }) => {
      const charged = Number.parseFloat(meta?.headers?.["x-litellm-response-cost"] ?? "");
      if (assistant?.usage && !Number.isNaN(charged)) assistant.usage.cost = charged;
    },
  },
  providers: {
    litellm: {
      auth: (entry, { refresh, fetch }) => login(entry, refresh, fetch),
      create(entry, opts) {
        const root = proxyRoot(entry);
        // ponytail: a helper runs once per provider instance (one per run); re-run it in `fetch` if its keys outlive less
        const key =
          typeof entry.apiKeyHelper === "string"
            ? execSync(entry.apiKeyHelper, { encoding: "utf8" }).trim()
            : (entry.apiKey ?? "");
        const headers = {
          ...opts.headers,
          ...(entry.headers as Record<string, string> | undefined),
          ...(key && { authorization: `Bearer ${key}` }),
        };
        const base = opts.fetch ?? globalThis.fetch;
        let discovered: Promise<Map<string, Route>> | undefined;
        const routes = () => {
          discovered ??= discover(root, (url) => base(url, { headers }));
          return discovered;
        };
        // an unknown id (or a proxy whose listing failed) still goes through Chat Completions, like Pi
        const routeOf = async (model: string): Promise<Route> =>
          (await routes().catch(() => undefined))?.get(model) ?? { protocol: "chat", info: {} };
        // Messages lives at the root, the OpenAI APIs under /v1; a keyless proxy gets no key, so no authorization
        const delegate = (type: string, endpoint: string) =>
          opts.providers?.[type]?.create({ type, endpoint, apiKey: key }, { name: opts.name, headers, fetch: base });
        const via: Record<Protocol, Provider | undefined> = {
          anthropic: delegate("anthropic", root),
          responses: delegate("openai-responses", `${root}/v1`),
          chat: delegate("openai", `${root}/v1`),
        };
        return {
          listModels: async () => [...(await routes()).keys()],
          info: async (model) => (await routeOf(model)).info,
          async complete(req, callbacks, ctx) {
            const { protocol, price } = await routeOf(req.model);
            const provider = via[protocol];
            if (!provider)
              throw new Error(`LiteLLM routes ${req.model} through hortus's ${protocol} provider, not loaded`);
            // groups the session's requests in LiteLLM's logs and spend tracking; per call, so concurrent runs don't mix
            const session = ctx?.session && { "x-litellm-session-id": ctx.session.id };
            const reply = await provider.complete(
              session ? { ...req, headers: { ...req.headers, ...session } } : req,
              callbacks,
              ctx,
            );
            // the price it lists; what it says it charged replaces it in `response` (below)
            const listed = price && reply.usage && cost(price, reply.usage);
            return listed === undefined || !reply.usage ? reply : { ...reply, usage: { ...reply.usage, cost: listed } };
          },
        };
      },
    },
  },
} satisfies Plugin;
