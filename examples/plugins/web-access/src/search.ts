import type { Ctx } from "@hortus/core";
import type { Extracted, SearchResult } from "./store.ts";
import { type Config, errorText, http, isAbort } from "./web.ts";

export type Recency = "day" | "week" | "month" | "year";

export interface SearchOptions {
  numResults?: number;
  recencyFilter?: Recency;
  /** a leading "-" excludes the domain */
  domainFilter?: string[];
  category?: string;
  includeContent?: boolean;
  /** OpenAI search model */
  model?: string;
  signal: AbortSignal;
}

export interface SearchResponse {
  answer: string;
  results: SearchResult[];
  /** full page text some providers return with the hits (Exa, Tavily) */
  inline?: Extracted[];
}

export interface Attributed extends SearchResponse {
  provider: string;
  providers?: string[];
}

/** Pi's `ALL_SEARCH_PROVIDERS` order, for "all" and lists. */
const ALL = ["searxng", "openai", "exa", "brave", "tavily", "perplexity"] as const;
type Name = (typeof ALL)[number];
const backend = (name: string) => ((ALL as readonly string[]).includes(name) ? BACKENDS[name as Name] : undefined);

/** A credential: its secrets.json entry's fields. */
type Key = Record<string, unknown> & { apiKey?: string; endpoint?: string };

interface Backend {
  label: string;
  /** the credential to use, `{}` for a keyless one, undefined when not configured */
  key(ctx: Ctx): Promise<Key | undefined>;
  search(ctx: Ctx, key: Key, query: string, o: SearchOptions, config: Config): Promise<SearchResponse>;
}

/** The first secrets.json entry of `type` (`{ "brave": { "type": "brave", "apiKey": "${BRAVE_API_KEY}" } }`). */
const secret = (type: string) => async (ctx: Ctx) => (await ctx.secrets.find(type))[0]?.entry as Key | undefined;

const split = (domains: string[] | undefined) => ({
  include: (domains ?? []).filter((d) => d.trim() && !d.trim().startsWith("-")).map((d) => d.trim()),
  exclude: (domains ?? [])
    .filter((d) => d.trim().startsWith("-"))
    .map((d) => d.trim().slice(1))
    .filter(Boolean),
});

const siteQuery = (query: string, domains?: string[]) => {
  const { include, exclude } = split(domains);
  return [query, ...include.map((d) => `site:${d}`), ...exclude.map((d) => `-site:${d}`)].join(" ");
};

/** Items that have a URL (provider payloads leave fields out). */
const linked = <T extends { url?: string }>(items: T[] | undefined) =>
  (items ?? []).filter((r): r is T & { url: string } => !!r.url);

const host = (url: string, i: number) => URL.parse(url)?.hostname || `Source ${i + 1}`;
const answerOf = (results: SearchResult[]) =>
  results.map((r) => `${r.snippet ? `${r.snippet}\n` : ""}Source: ${r.title} (${r.url})`).join("\n\n");
const stripHtml = (s: string) =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
const DAYS: Record<Recency, number> = { day: 1, week: 7, month: 30, year: 365 };
const json = { "Content-Type": "application/json", Accept: "application/json" };

const exaMcpQuery = (query: string, o: SearchOptions) => {
  const parts = [siteQuery(query, o.domainFilter)];
  const now = new Date();
  if (o.recencyFilter === "day") parts.push("past 24 hours");
  if (o.recencyFilter === "week") parts.push("past week");
  if (o.recencyFilter === "month") parts.push(`${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()}`);
  if (o.recencyFilter === "year") parts.push(String(now.getFullYear()));
  if (o.category) parts.push(o.category);
  return parts.join(" ");
};

/** Exa's keyless MCP endpoint answers SSE (or JSON) carrying a text block of `Title:`/`URL:`/`Text:` records. */
function parseExaMcp(body: string, includeContent?: boolean): SearchResponse {
  const rpc = [
    ...body
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim()),
    body.trim(),
  ]
    .map((p) => {
      try {
        return JSON.parse(p) as {
          result?: { content?: { text?: string }[]; isError?: boolean };
          error?: { message?: string };
        };
      } catch {
        return undefined;
      }
    })
    .find((r) => r?.result || r?.error);
  if (!rpc) throw new Error("Exa MCP returned an empty response");
  if (rpc.error) throw new Error(`Exa MCP error: ${rpc.error.message ?? "unknown"}`);
  const text = rpc.result?.content?.find((c) => c.text?.trim())?.text ?? "";
  if (rpc.result?.isError) throw new Error(text || "Exa MCP returned an error");
  const records = text
    .split(/(?=^Title: )/m)
    .map((b) => ({
      title: b.match(/^Title: (.+)/m)?.[1]?.trim() ?? "",
      url: b.match(/^URL: (.+)/m)?.[1]?.trim() ?? "",
      content: (b.match(/\n(?:Text|Highlights):\s*([\s\S]*)/)?.[1] ?? "").replace(/(^|\n)---\s*$/, "").trim(),
    }))
    .filter((r) => r.url);
  if (!records.length) throw new Error(`Exa MCP returned no parseable results: ${text.trim().slice(0, 200)}`);
  const results = records.map((r, i) => ({ title: r.title || host(r.url, i), url: r.url, snippet: "" }));
  return {
    answer: records
      .filter((r) => r.content)
      .map((r, i) => `${r.content.replace(/\s+/g, " ").slice(0, 500)}\nSource: ${r.title || host(r.url, i)} (${r.url})`)
      .join("\n\n"),
    results,
    ...(includeContent && {
      inline: records
        .filter((r) => r.content)
        .map((r, i) => ({ url: r.url, title: r.title || host(r.url, i), content: r.content, error: null })),
    }),
  };
}

/** The Pi providers ported: those needing no browser cookies, CLI logins or vendor SDKs (Exa keyless via its MCP endpoint). */
export const BACKENDS: Record<Name, Backend> = {
  searxng: {
    label: "SearXNG",
    key: secret("searxng"),
    async search(ctx, key, query, o) {
      if (!key.endpoint) throw new Error("SearXNG needs an endpoint in its secrets.json entry");
      const url = new URL(`${key.endpoint.replace(/\/$/, "")}/search`);
      url.searchParams.set("q", siteQuery(query, o.domainFilter));
      url.searchParams.set("format", "json");
      if (o.recencyFilter) url.searchParams.set("time_range", o.recencyFilter);
      const res = await http(ctx, { type: "api", target: query }, "SearXNG", String(url), {
        headers: { Accept: "application/json" },
        signal: o.signal,
      });
      const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
      const results = linked(data.results)
        .slice(0, o.numResults ?? 5)
        .map((r) => ({ title: r.title || r.url, url: r.url, snippet: r.content ?? "" }));
      return { answer: answerOf(results), results };
    },
  },
  openai: {
    label: "OpenAI",
    // the run's own login when its provider is OpenAI (Pi reuses the active model's auth), else any openai entry
    async key(ctx) {
      const run = ctx.run;
      if (run && (run.type === "openai" || run.type === "openai-responses")) {
        const entry = await ctx.secrets.get(run.provider);
        if (entry?.apiKey) return { ...entry, model: run.model } as Key;
      }
      const found = (await ctx.secrets.find("openai")).find((e) => e.entry.apiKey);
      return found && ((await ctx.secrets.get(found.name)) as Key | undefined);
    },
    async search(ctx, key, query, o, config) {
      const { include, exclude } = split(o.domainFilter);
      const base = (key.endpoint ?? "https://api.openai.com/v1").replace(/\/$/, "");
      const instructions = [
        "Search the web and answer with a concise, cited summary.",
        o.recencyFilter && `Prefer sources from the past ${o.recencyFilter}.`,
        o.numResults && `Prefer around ${Math.min(o.numResults, 20)} distinct sources.`,
      ]
        .filter(Boolean)
        .join(" ");
      const res = await http(ctx, { type: "api", target: query }, "OpenAI", `${base}/responses`, {
        method: "POST",
        headers: { ...json, Authorization: `Bearer ${key.apiKey}` },
        body: JSON.stringify({
          model: o.model ?? config.openaiSearchModel ?? (key.model as string | undefined) ?? "gpt-6-luna",
          instructions,
          input: query,
          tools: [
            {
              type: "web_search",
              ...((include.length || exclude.length) && {
                filters: {
                  ...(include.length && { allowed_domains: include }),
                  ...(exclude.length && { blocked_domains: exclude }),
                },
              }),
            },
          ],
          include: ["web_search_call.action.sources"],
          tool_choice: "required",
          store: false,
        }),
        signal: o.signal,
      });
      type Part = { type?: string; text?: string; annotations?: { type?: string; url?: string; title?: string }[] };
      const data = (await res.json()) as { output?: { type?: string; content?: Part[] }[] };
      if (!data.output?.some((i) => i.type === "web_search_call"))
        throw new Error("OpenAI web_search returned no web_search_call");
      const parts = (data.output ?? []).flatMap((i) => (i.type === "message" ? (i.content ?? []) : []));
      const seen = new Set<string>();
      const results = parts
        .flatMap((p) => p.annotations ?? [])
        .filter(
          (a): a is typeof a & { url: string } =>
            a.type === "url_citation" && !!a.url && !seen.has(a.url) && !!seen.add(a.url),
        )
        .map((a, i) => ({ title: a.title || host(a.url, i), url: a.url, snippet: "" }));
      const answer = parts
        .map((p) => p.text ?? "")
        .join("\n")
        .trim();
      if (!answer && !results.length) throw new Error("OpenAI web_search returned no answer or sources");
      return { answer, results: results.slice(0, o.numResults ?? 20) };
    },
  },
  exa: {
    label: "Exa",
    // keyless through Exa's public MCP endpoint (Pi's zero-config search)
    key: async (ctx) => (await secret("exa")(ctx)) ?? {},
    async search(ctx, key, query, o) {
      const n = o.numResults ?? 5;
      if (!key.apiKey) {
        const res = await http(
          ctx,
          { type: "api", target: query },
          "Exa MCP",
          "https://mcp.exa.ai/mcp?tools=web_search_exa",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "web_search_exa", arguments: { query: exaMcpQuery(query, o), numResults: n } },
            }),
            signal: o.signal,
          },
        );
        return parseExaMcp(await res.text(), o.includeContent);
      }
      const { include, exclude } = split(o.domainFilter);
      const res = await http(
        ctx,
        { type: "api", target: query },
        "Exa API",
        `${key.endpoint ?? "https://api.exa.ai"}/search`,
        {
          method: "POST",
          headers: { ...json, "x-api-key": key.apiKey },
          body: JSON.stringify({
            query,
            type: "auto",
            numResults: n,
            ...(include.length && { includeDomains: include }),
            ...(exclude.length && { excludeDomains: exclude }),
            ...(o.category && { category: o.category }),
            ...(o.recencyFilter && {
              startPublishedDate: new Date(Date.now() - DAYS[o.recencyFilter] * 86_400_000).toISOString(),
            }),
            contents: o.includeContent ? { text: true, highlights: true } : { highlights: true },
          }),
          signal: o.signal,
        },
      );
      const data = (await res.json()) as {
        results?: { url?: string; title?: string; text?: string; highlights?: string[] }[];
      };
      const items = linked(data.results);
      const results = items.map((r, i) => ({ title: r.title || host(r.url, i), url: r.url, snippet: "" }));
      return {
        answer: items
          .map((r, i) => {
            const text = r.highlights?.length ? r.highlights.join(" ") : (r.text ?? "").trim().slice(0, 1000);
            return text && `${text}\nSource: ${r.title || host(r.url, i)} (${r.url})`;
          })
          .filter(Boolean)
          .join("\n\n"),
        results,
        ...(o.includeContent && {
          inline: items
            .filter((r): r is typeof r & { text: string } => !!r.text)
            .map((r, i) => ({ url: r.url, title: r.title || host(r.url, i), content: r.text, error: null })),
        }),
      };
    },
  },
  brave: {
    label: "Brave",
    key: secret("brave"),
    async search(ctx, key, query, o) {
      const n = o.numResults ?? 5;
      const params = new URLSearchParams({ q: siteQuery(query, o.domainFilter), count: String(n) });
      if (o.recencyFilter) params.set("freshness", `p${o.recencyFilter[0]}`);
      const res = await http(
        ctx,
        { type: "api", target: query },
        "Brave Search API",
        `https://api.search.brave.com/res/v1/web/search?${params}`,
        {
          headers: { Accept: "application/json", "X-Subscription-Token": key.apiKey ?? "" },
          signal: o.signal,
        },
      );
      const data = (await res.json()) as {
        web?: { results?: { title?: string; url?: string; description?: string }[] };
      };
      const results = linked(data.web?.results)
        .slice(0, n)
        .map((r) => ({
          title: stripHtml(r.title ?? "") || r.url,
          url: r.url,
          snippet: stripHtml(r.description ?? ""),
        }));
      return { answer: answerOf(results), results };
    },
  },
  tavily: {
    label: "Tavily",
    key: secret("tavily"),
    async search(ctx, key, query, o) {
      const { include, exclude } = split(o.domainFilter);
      const res = await http(ctx, { type: "api", target: query }, "Tavily", "https://api.tavily.com/search", {
        method: "POST",
        headers: { ...json, Authorization: `Bearer ${key.apiKey}` },
        body: JSON.stringify({
          query,
          search_depth: "basic",
          max_results: o.numResults ?? 5,
          include_answer: "basic",
          ...(o.recencyFilter && { time_range: o.recencyFilter }),
          ...(include.length && { include_domains: include }),
          ...(exclude.length && { exclude_domains: exclude }),
          ...(o.includeContent && { include_raw_content: "markdown" }),
        }),
        signal: o.signal,
      });
      const data = (await res.json()) as {
        answer?: string;
        results?: { title?: string; url?: string; content?: string; raw_content?: string }[];
      };
      const items = linked(data.results);
      const results = items.map((r) => ({ title: r.title || r.url, url: r.url, snippet: r.content ?? "" }));
      return {
        answer: data.answer || answerOf(results),
        results,
        ...(o.includeContent && {
          inline: items
            .filter((r): r is typeof r & { raw_content: string } => !!r.raw_content)
            .map((r) => ({ url: r.url, title: r.title || r.url, content: r.raw_content, error: null })),
        }),
      };
    },
  },
  perplexity: {
    label: "Perplexity",
    key: secret("perplexity"),
    async search(ctx, key, query, o) {
      const res = await http(
        ctx,
        { type: "api", target: query },
        "Perplexity",
        "https://api.perplexity.ai/chat/completions",
        {
          method: "POST",
          headers: { ...json, Authorization: `Bearer ${key.apiKey}` },
          body: JSON.stringify({
            model: "sonar",
            messages: [{ role: "user", content: query }],
            ...(o.recencyFilter && { search_recency_filter: o.recencyFilter }),
            ...(o.domainFilter?.length && { search_domain_filter: o.domainFilter.slice(0, 20) }),
          }),
          signal: o.signal,
        },
      );
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        search_results?: { title?: string; url?: string; snippet?: string }[];
        citations?: string[];
      };
      const results = (data.search_results ?? data.citations?.map((url) => ({ url })) ?? [])
        .filter((r): r is { url: string; title?: string; snippet?: string } => !!r.url)
        .slice(0, o.numResults ?? 5)
        .map((r, i) => ({ title: r.title || host(r.url, i), url: r.url, snippet: r.snippet ?? "" }));
      return { answer: data.choices?.[0]?.message?.content ?? "", results };
    },
  },
};

async function one(ctx: Ctx, name: string, query: string, o: SearchOptions, config: Config): Promise<Attributed> {
  const b = backend(name);
  if (!b) throw new Error(`Unknown search provider "${name}". Known: auto, all, ${ALL.join(", ")}`);
  const key = await b.key(ctx);
  if (!key) throw new Error(`${b.label} is not configured: add a secrets.json entry of type "${name}"`);
  return { ...(await b.search(ctx, key, query, o, config)), provider: name };
}

/** Several providers at once, results merged by URL, one answer section per provider (Pi's `searchWithProviders`). */
async function many(
  ctx: Ctx,
  names: string[] | undefined,
  query: string,
  o: SearchOptions,
  config: Config,
): Promise<Attributed> {
  const chosen =
    names ??
    (await Promise.all(ALL.map(async (n) => ((await BACKENDS[n].key(ctx)) ? n : undefined)))).filter(
      (n) => n !== undefined,
    );
  if (!chosen.length) throw new Error('No configured search provider available for provider "all".');
  const settled = await Promise.allSettled(chosen.map((n) => one(ctx, n, query, o, config)));
  o.signal.throwIfAborted();
  const ok = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  const failed = settled.flatMap((s, i) =>
    s.status === "rejected" ? [{ provider: String(chosen[i]), error: errorText(s.reason) }] : [],
  );
  const label = (n: string) => backend(n)?.label ?? n;
  if (!ok.length)
    throw new Error(
      `${names ? "Selected" : "All"}-provider search failed:\n  - ${failed.map((f) => `${label(f.provider)}: ${f.error}`).join("\n  - ")}`,
    );
  const seen = new Set<string>();
  const sections = ok.map((r) => `## ${label(r.provider)}\n\n${r.answer || "(No answer text returned.)"}`);
  if (failed.length)
    sections.push(`## Provider errors\n\n${failed.map((f) => `- **${label(f.provider)}:** ${f.error}`).join("\n")}`);
  return {
    provider: "all",
    providers: ok.map((r) => r.provider),
    answer: sections.join("\n\n"),
    results: ok.flatMap((r) => r.results).filter((r) => !seen.has(r.url) && seen.add(r.url)),
    inline: ok.flatMap((r) => r.inline ?? []),
  };
}

/**
 * Searches with `provider` (default the config's, else "auto"): a name, comma-separated names, "all", or "auto": SearXNG,
 * then OpenAI first when the run's model is an OpenAI one, Exa (keyless without a key), OpenAI, Brave, Tavily and
 * Perplexity, moving on after an error or an empty answer (the first empty one is returned if all are).
 */
export async function search(
  ctx: Ctx,
  query: string,
  o: SearchOptions,
  config: Config,
  provider?: string,
): Promise<Attributed> {
  const selection = (provider ?? config.provider ?? "auto").trim().toLowerCase() || "auto";
  if (selection === "all") return many(ctx, undefined, query, o, config);
  if (selection.includes(","))
    return many(
      ctx,
      selection
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      query,
      o,
      config,
    );
  if (selection !== "auto") return one(ctx, selection, query, o, config);
  const errors: string[] = [];
  let firstEmpty: Attributed | undefined;
  const openaiFirst = ctx.run?.type === "openai" || ctx.run?.type === "openai-responses";
  const order: Name[] = openaiFirst
    ? ["searxng", "openai", "exa", "brave", "tavily", "perplexity"]
    : ["searxng", "exa", "openai", "brave", "tavily", "perplexity"];
  for (const name of order) {
    const b = BACKENDS[name];
    const key = await b.key(ctx);
    if (!key) continue;
    try {
      const r = { ...(await b.search(ctx, key, query, o, config)), provider: name };
      if (r.results.length || r.answer.trim()) return r;
      firstEmpty ??= r;
    } catch (e) {
      if (isAbort(e) || o.signal.aborted) throw e;
      errors.push(`${b.label}: ${errorText(e)}`);
    }
  }
  if (firstEmpty) return firstEmpty;
  throw new Error(`Auto provider search failed:\n  - ${errors.join("\n  - ") || "no provider configured"}`);
}
