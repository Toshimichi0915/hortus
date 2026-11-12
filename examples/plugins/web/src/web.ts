import { createHash } from "node:crypto";
import type { Ctx } from "@hortus/core";
import {
  BACKENDS,
  type Backend,
  canFallBack,
  FILTERS,
  type Filter,
  type ImageResult,
  type Login,
  type ReadResult,
  type SearchOptions,
  type SearchResult,
} from "./backends.ts";

/**
 * What this plugin needs of its host: a tool's `ctx`, or the agent's (for commands). `secrets.get` passes an entry
 * through the `auth` of the provider owning its type, so a Codex login is refreshed by the plugin that logged in;
 * `signal` (a tool's: aborted with the run) cancels every request.
 */
export type Host = Pick<Ctx, "secrets" | "fetch"> & { signal?: AbortSignal };

/** The host's signal, and a timeout when one is asked for. */
function signal(host: Host, timeoutSeconds?: number): { signal?: AbortSignal } {
  const signals = [host.signal, timeoutSeconds ? AbortSignal.timeout(timeoutSeconds * 1000) : undefined].filter(
    (s) => s !== undefined,
  );
  return signals.length ? { signal: AbortSignal.any(signals) } : {};
}

/** The login of the first secrets.json entry whose `type` is `backend`, if there is one. */
async function login({ secrets }: Host, backend: string): Promise<Login | undefined> {
  const [found] = await secrets.find(backend);
  if (!found) return undefined;
  return { entry: await secrets.get(found.name), refresh: () => secrets.get(found.name, { refresh: true }) };
}

const configured = async (host: Host, b: Backend, op: "search" | "read" | "image") =>
  b.keyless === "all" || (b.keyless === "read" && op === "read") || (await host.secrets.find(b.name)).length > 0;

const capable = (b: Backend, op: "search" | "read" | "image") =>
  op === "search" ? !!b.search : op === "read" ? !!b.read : !!b.searchImage;

/** Backends that can do `op`; `name` picks one (an unknown or incapable one throws). */
function backends(op: "search" | "read" | "image", name?: string) {
  const all = BACKENDS.filter((b) => capable(b, op));
  if (name === undefined) return all;
  const b = all.find((b) => b.name === name);
  if (!b) throw new Error(`Unknown ${op} provider "${name}". Available: ${all.map((b) => b.name).join(", ")}`);
  return [b];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Failure {
  provider: string;
  error: string;
}

/** Tries `names` in order, moving on only after a failure `canFallBack` allows. */
async function withFallback<T>(
  op: "search" | "read",
  names: Backend[],
  fn: (b: Backend) => Promise<T>,
): Promise<{ value: T; provider: string; attempts: string[]; failures: Failure[] }> {
  const failures: Failure[] = [];
  for (const b of names) {
    try {
      return { value: await fn(b), provider: b.name, attempts: [...failures.map((f) => f.provider), b.name], failures };
    } catch (e) {
      failures.push({ provider: b.name, error: message(e) });
      if (!canFallBack(e, b.name, op)) {
        if (failures.length === 1) throw e;
        break;
      }
    }
  }
  if (!failures.length) throw new Error(`No ${op} provider configured. Add one to ~/.hortus/secrets.json`);
  const details = failures.map((f) => `${f.provider}: ${f.error}`).join("; ");
  throw new Error(`Automatic ${op} failed after ${failures.length} provider attempt(s): ${details}`);
}

export interface SearchRequest extends Omit<SearchOptions, "signal" | "fetch"> {
  query: string;
  /** a backend, "all", or "auto" (the default) */
  provider?: string;
  timeoutSeconds?: number;
}
export interface Hit extends SearchResult {
  /** with provider=all: every backend that returned it */
  providers?: string[];
}
export interface SearchDetails {
  query: string;
  provider: string;
  results: Hit[];
  /** filters a backend didn't apply */
  ignored: { provider: string; filters: Filter[] }[];
  failures: Failure[];
  metadata?: Record<string, unknown>;
}

function ignoredFilters(b: Backend, o: SearchOptions): Filter[] {
  return FILTERS.filter((f) => {
    const v = o[f];
    if (!(Array.isArray(v) ? v.length : v)) return false;
    return !b.filters.includes(f) || (f === "category" && !!b.categories && !b.categories.includes(o.category ?? ""));
  });
}

async function searchWith(host: Host, b: Backend, query: string, o: SearchOptions) {
  const l = (await login(host, b.name)) ?? { refresh: async () => undefined };
  // biome-ignore lint/style/noNonNullAssertion: `backends("search")` only lists backends with `search`
  const r = await b.search!(l, query, o);
  const ignored = ignoredFilters(b, o);
  return { ...r, ignored: ignored.length ? [{ provider: b.name, filters: ignored }] : [] };
}

/** URL without its fragment, trailing slash and utm_ parameters, and with sorted parameters: the key for deduplication. */
function canonical(url: string) {
  try {
    const u = new URL(url);
    const params = [...u.searchParams]
      .filter(([k]) => !k.toLowerCase().startsWith("utm_"))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const q = params.length ? `?${new URLSearchParams(params)}` : "";
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "") || "/"}${q}`;
  } catch {
    return url;
  }
}

export async function search(host: Host, req: SearchRequest): Promise<SearchDetails> {
  const { query: raw, provider = "auto", timeoutSeconds, ...opts } = req;
  const query = raw.trim();
  if (!query) throw new Error("Search query cannot be empty");
  const o: SearchOptions = {
    maxResults: 10,
    ...opts,
    fetch: host.fetch,
    ...signal(host, timeoutSeconds),
  };
  if (provider === "all") {
    const names: Backend[] = [];
    for (const b of backends("search")) if (await configured(host, b, "search")) names.push(b);
    if (!names.length) throw new Error("No search provider configured. Add one to ~/.hortus/secrets.json");
    const settled = await Promise.allSettled(names.map((b) => searchWith(host, b, query, o)));
    const seen = new Map<string, Hit & { providers: string[] }>();
    const details: SearchDetails = { query, provider, results: [], ignored: [], failures: [] };
    for (const [i, s] of settled.entries()) {
      // biome-ignore lint/style/noNonNullAssertion: one outcome per name
      const name = names[i]!.name;
      if (s.status === "rejected") {
        details.failures.push({ provider: name, error: message(s.reason) });
        continue;
      }
      details.ignored.push(...s.value.ignored);
      for (const r of s.value.results) {
        const hit = seen.get(canonical(r.url));
        if (!hit) seen.set(canonical(r.url), { ...r, providers: [name] });
        else if (!hit.providers.includes(name)) hit.providers.push(name);
      }
    }
    if (details.failures.length === names.length)
      throw new Error(`Every provider failed: ${details.failures.map((f) => `${f.provider}: ${f.error}`).join("; ")}`);
    return { ...details, results: [...seen.values()].slice(0, o.maxResults) };
  }
  const explicit = provider !== "auto";
  const names: Backend[] = [];
  for (const b of backends("search", explicit ? provider : undefined))
    if (explicit || (await configured(host, b, "search"))) names.push(b);
  const r = await withFallback("search", names, (b) => searchWith(host, b, query, o));
  return {
    query,
    provider: r.provider,
    results: r.value.results,
    ignored: r.value.ignored,
    failures: r.failures,
    ...(r.value.metadata ? { metadata: r.value.metadata } : {}),
  };
}

export interface ReadRequest {
  url: string;
  /** a backend or "auto" (the default: Jina, which needs no key, then the configured ones) */
  provider?: string;
  format?: "markdown" | "text" | "html";
  /** most characters (code points) of content returned; the rest is behind `continuation` */
  maxChars?: number;
  continuation?: string;
  timeoutSeconds?: number;
}
export interface ReadDetails {
  provider: string;
  failures: Failure[];
  result: ReadResult & { truncated: boolean; continuation?: string };
}

interface Continuation {
  provider: string;
  url: string;
  offset: number;
  /** sha256 of the whole content, so a page that changed meanwhile isn't spliced */
  hash: string;
}
const sha = (s: string) => createHash("sha256").update(s).digest("base64url");

export async function read(host: Host, req: ReadRequest): Promise<ReadDetails> {
  const url = req.url.trim();
  if (!url) throw new Error("Read URL cannot be empty");
  const maxChars = req.maxChars ?? 20_000;
  const o = {
    format: req.format,
    fetch: host.fetch,
    ...signal(host, req.timeoutSeconds),
  };
  let from: Continuation | undefined;
  if (req.continuation) {
    try {
      from = JSON.parse(Buffer.from(req.continuation, "base64url").toString("utf8"));
    } catch {}
    if (typeof from?.offset !== "number" || from.url !== url) throw new Error("Invalid read continuation token");
  }
  const names: Backend[] = [];
  const provider = from?.provider ?? (req.provider === "auto" ? undefined : req.provider);
  for (const b of backends("read", provider)) if (provider || (await configured(host, b, "read"))) names.push(b);
  const r = await withFallback("read", names, async (b) =>
    // biome-ignore lint/style/noNonNullAssertion: `backends("read")` only lists backends with `read`
    b.read!((await login(host, b.name)) ?? { refresh: async () => undefined }, url, o),
  );
  const chars = [...r.value.content];
  if (from && from.hash !== sha(r.value.content))
    throw new Error("Read content changed since the continuation token was issued");
  const offset = from?.offset ?? 0;
  const end = Math.min(offset + maxChars, chars.length);
  const truncated = end < chars.length;
  const next: Continuation = { provider: r.provider, url, offset: end, hash: sha(r.value.content) };
  return {
    provider: r.provider,
    failures: r.failures,
    result: {
      ...r.value,
      content: chars.slice(offset, end).join(""),
      truncated,
      ...(truncated ? { continuation: Buffer.from(JSON.stringify(next)).toString("base64url") } : {}),
    },
  };
}

export async function searchImage(
  host: Host,
  req: { url: string; provider?: string; maxResults?: number },
): Promise<{ provider: string; results: ImageResult[] }> {
  const url = req.url.trim();
  if (!/^https?:\/\//.test(url)) throw new Error("Image URL must be an absolute HTTP or HTTPS URL");
  // biome-ignore lint/style/noNonNullAssertion: there is an image backend
  const b = backends("image", req.provider)[0]!;
  const l = (await login(host, b.name)) ?? { refresh: async () => undefined };
  const o = { maxResults: req.maxResults ?? 10, fetch: host.fetch, ...signal(host) };
  // biome-ignore lint/style/noNonNullAssertion: `backends("image")` only lists backends with `searchImage`
  return { provider: b.name, results: await b.searchImage!(l, url, o) };
}

export interface ProviderStatus {
  name: string;
  configured: boolean;
  operations: string[];
  filters: Filter[];
}

export async function providers(host: Host): Promise<ProviderStatus[]> {
  return Promise.all(
    BACKENDS.map(async (b) => {
      const operations = (["search", "read", "image"] as const).filter((op) => capable(b, op));
      return {
        name: b.name,
        configured: (await Promise.all(operations.map((op) => configured(host, b, op)))).some(Boolean),
        operations,
        filters: b.filters,
      };
    }),
  );
}

// formatting for the model: results numbered, every field capped, so a page of results stays a few thousand characters

const cap = (s: string, n: number) => {
  const c = [...s.replace(/\s+/g, " ").trim()];
  return c.length <= n ? c.join("") : `${c.slice(0, n - 1).join("")}…`;
};
const field = (label: string, v: unknown, n = 300) =>
  v === undefined || v === "" ? [] : [`   ${label}: ${cap(String(v), n)}`];

export function formatSearch(d: SearchDetails): string {
  const ignored = d.ignored.map((i) => ` [${i.provider} ignored=${i.filters.join(",")}]`).join("");
  const lines = [`[provider=${d.provider}] ${d.results.length} result(s) for "${d.query}"${ignored}`, ""];
  if (!d.results.length) lines.push("No results.");
  d.results.forEach((r, i) => {
    lines.push(
      `${i + 1}. ${cap(r.title || "(no title)", 160)}`,
      `   ${cap(r.url, 300)}`,
      ...field("Snippet", r.snippet),
      ...field("Providers", r.providers?.join(", ")),
      ...field("Published", r.publishedDate, 100),
      ...field("Score", r.score, 40),
      ...field("Summary", r.summary),
      ...field("Text", r.text, 900),
    );
  });
  if (d.metadata) lines.push("", `Provider metadata: ${cap(JSON.stringify(d.metadata), 500)}`);
  if (d.failures.length) lines.push("", "Provider errors:", ...d.failures.map((f) => `  ${f.provider}: ${f.error}`));
  return lines.join("\n");
}

export function formatRead(url: string, d: ReadDetails): string {
  const r = d.result;
  return [
    `[provider=${d.provider}] read ${cap(url, 200)}`,
    "",
    r.title || "(no title)",
    `   ${r.url}`,
    ...(r.description ? [`   ${cap(r.description, 160)}`] : []),
    ...(r.content ? ["", r.content] : []),
    ...(r.truncated ? ["", `[truncated; continuation=${r.continuation}]`] : []),
  ].join("\n");
}

export const formatImages = (url: string, d: { provider: string; results: ImageResult[] }) =>
  [
    `[provider=${d.provider}] ${d.results.length} image match(es) for ${cap(url, 200)}`,
    "",
    ...d.results.map((r, i) => `${i + 1}. ${cap(r.title || "(no title)", 200)}\n   ${r.pageUrl}\n   ${r.imageUrl}`),
  ].join("\n");

export const formatProviders = (list: ProviderStatus[]) =>
  list
    .map(
      (s) =>
        `${s.configured ? "✓" : "·"} ${s.name} ${s.operations.join(", ")}${s.filters.length ? `; filters: ${s.filters.join(", ")}` : ""}`,
    )
    .join("\n");

/** Runs `fn` on each item, every one getting its own result or error. */
export const batch = <T>(items: string[], fn: (item: string) => Promise<T>) =>
  Promise.all(
    items.map((item) =>
      fn(item).then(
        (value) => ({ item, value }),
        (e) => ({ item, error: message(e) }),
      ),
    ),
  );
