import type { Secret } from "@hortus/core";

export interface SearchOptions {
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  category?: string;
  startPublishedDate?: string;
  endPublishedDate?: string;
  summary?: boolean;
  fullText?: boolean;
  signal?: AbortSignal;
  /** the host's (`ToolContext.fetch`), for every request */
  fetch: typeof globalThis.fetch;
}
export type Filter = "includeDomains" | "excludeDomains" | "category" | "startPublishedDate" | "endPublishedDate";
export const FILTERS: Filter[] = [
  "includeDomains",
  "excludeDomains",
  "category",
  "startPublishedDate",
  "endPublishedDate",
];

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  publishedDate?: string;
  score?: number;
  summary?: string;
  text?: string;
}
export interface Searched {
  results: SearchResult[];
  metadata?: Record<string, unknown>;
}
export interface ReadOptions {
  format?: "markdown" | "text" | "html";
  signal?: AbortSignal;
  fetch: typeof globalThis.fetch;
}
export interface ReadResult {
  url: string;
  title?: string;
  description?: string;
  content: string;
}
export interface ImageResult {
  title: string;
  pageUrl: string;
  imageUrl: string;
}

/** A backend's credentials: its secrets.json entry (`${VAR}` expanded), and a way to force a refreshed one. */
export interface Login {
  entry?: Secret;
  refresh(): Promise<Secret | undefined>;
}

export interface Backend {
  /** also the secrets.json `type` its entry has */
  name: string;
  /** search filters it honours; the others are reported as ignored */
  filters: Filter[];
  /** categories it understands, when it takes `category` */
  categories?: string[];
  /** works without a secrets.json entry */
  keyless?: "read" | "all";
  search?(login: Login, query: string, opts: SearchOptions): Promise<Searched>;
  read?(login: Login, url: string, opts: ReadOptions): Promise<ReadResult>;
  searchImage?(
    login: Login,
    url: string,
    opts: { maxResults: number; signal?: AbortSignal; fetch: typeof globalThis.fetch },
  ): Promise<ImageResult[]>;
}

/** A failed request; `status` 0 is no response at all. Keys in the URL (`api_key=`) are scrubbed from the message. */
export class HTTPError extends Error {
  constructor(
    readonly status: number,
    url: string,
    body: string,
  ) {
    const safe = url.replace(/([?&]api_key=)[^&]*/g, "$1***");
    super(`HTTP ${status}: ${safe}${body ? `: ${body.replace(/\s+/g, " ").trim().slice(0, 300)}` : ""}`);
  }
}

/** Whether automatic selection may try the next backend: out of credit, rate limited, timed out or down. */
export const canFallBack = (e: unknown, backend: string, op: "search" | "read") =>
  e instanceof HTTPError &&
  ([0, 402, 408, 429].includes(e.status) ||
    e.status >= 500 ||
    (op === "read" && backend === "jina" && e.status === 409));

type HttpInit = RequestInit & { json?: unknown; fetch: typeof globalThis.fetch };

async function http(url: string, init: HttpInit): Promise<Record<string, unknown>> {
  const { json, fetch, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      ...(json === undefined
        ? {}
        : {
            method: "POST",
            body: JSON.stringify(json),
            headers: { "content-type": "application/json", ...rest.headers },
          }),
    });
  } catch (e) {
    throw new HTTPError(0, url, e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) throw new HTTPError(res.status, url, await res.text().catch(() => ""));
  return (await res.json()) as Record<string, unknown>;
}

const key = (login: Login, name: string) => {
  const k = login.entry?.apiKey;
  if (!k) throw new Error(`Missing API key for ${name}: add an entry with "type": "${name}" to ~/.hortus/secrets.json`);
  return k;
};
const base = (login: Login, url: string) => (login.entry?.endpoint ?? url).replace(/\/+$/, "");
// biome-ignore lint/suspicious/noExplicitAny: provider JSON, mapped field by field
type Json = any;
const day = (d: string) => d.slice(0, 10);

const exa: Backend = {
  name: "exa",
  filters: ["includeDomains", "excludeDomains", "category", "startPublishedDate", "endPublishedDate"],
  async search(login, query, o) {
    const r: Json = await http(`${base(login, "https://api.exa.ai")}/search`, {
      headers: { "x-api-key": key(login, "exa") },
      signal: o.signal,
      fetch: o.fetch,
      json: {
        query,
        type: "auto",
        numResults: o.maxResults,
        category: o.category,
        includeDomains: o.includeDomains,
        excludeDomains: o.excludeDomains,
        startPublishedDate: o.startPublishedDate,
        endPublishedDate: o.endPublishedDate,
        contents: { text: o.fullText ?? false, highlights: true, ...(o.summary ? { summary: true } : {}) },
      },
    });
    return {
      results: r.results.map((x: Json) => ({
        url: x.url,
        title: x.title ?? "",
        snippet: x.highlights?.[0] ?? x.text?.slice(0, 200) ?? "",
        publishedDate: x.publishedDate,
        score: x.score,
        summary: x.summary,
        text: x.text,
      })),
    };
  },
};

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeHtml = (s: string) =>
  s.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z]+));/gi, (m, hex, dec, name) =>
    name ? (entities[name.toLowerCase()] ?? m) : String.fromCodePoint(Number.parseInt(hex ?? dec, hex ? 16 : 10)),
  );

const brave: Backend = {
  name: "brave",
  filters: ["startPublishedDate", "endPublishedDate"],
  async search(login, query, o) {
    const p = new URLSearchParams({
      q: query,
      count: String(o.maxResults ?? 10),
      extra_snippets: "true",
      text_decorations: "false",
    });
    // Brave only takes a closed range, so a lone bound is closed with the epoch or today
    if (o.startPublishedDate || o.endPublishedDate)
      p.set(
        "freshness",
        `${day(o.startPublishedDate ?? "1970-01-01")}to${day(o.endPublishedDate ?? new Date().toISOString())}`,
      );
    const r: Json = await http(`${base(login, "https://api.search.brave.com")}/res/v1/web/search?${p}`, {
      headers: { "X-Subscription-Token": key(login, "brave") },
      signal: o.signal,
      fetch: o.fetch,
    });
    return {
      results: (r.web?.results ?? []).map((x: Json) => ({
        url: x.url,
        title: x.title,
        snippet: decodeHtml(x.description ?? ""),
        ...(x.page_age ? { publishedDate: x.page_age } : {}),
        ...(x.extra_snippets?.length ? { text: x.extra_snippets.join("\n") } : {}),
      })),
    };
  },
};

const jinaOk = (r: Json, url: string) => {
  if (r.code >= 400 || r.status >= 40000)
    throw new HTTPError(r.code >= 400 ? r.code : Math.floor(r.status / 100), url, r.message ?? r.error ?? "");
};

const jina: Backend = {
  name: "jina",
  filters: ["includeDomains", "category"],
  categories: ["web", "images", "news"],
  keyless: "read",
  async search(login, query, o) {
    const p = new URLSearchParams({ q: query, count: String(Math.min(Math.max(o.maxResults ?? 10, 1), 20)) });
    if (o.category && this.categories?.includes(o.category)) p.set("type", o.category);
    for (const d of o.includeDomains ?? []) p.append("site", d);
    const url = `${base(login, "https://s.jina.ai")}/search?${p}`;
    const r: Json = await http(url, {
      headers: { Authorization: `Bearer ${key(login, "jina")}`, Accept: "application/json" },
      signal: o.signal,
      fetch: o.fetch,
    });
    jinaOk(r, url);
    return {
      results: (r.data ?? []).map((x: Json) => ({
        url: x.url,
        title: x.title ?? "",
        snippet: x.description ?? (x.content ?? x.text ?? "").slice(0, 200),
        publishedDate: x.publishedTime,
        text: x.content ?? x.text,
      })),
    };
  },
  async read(login, page, o) {
    // the read endpoint sits next to the search one: s.jina.ai → r.jina.ai
    const url = `${base(login, "https://s.jina.ai").replace(/(^https?:\/\/(?:.+\.)?)s\.jina\.ai$/, "$1r.jina.ai")}/${encodeURIComponent(page)}`;
    const k = login.entry?.apiKey;
    const r: Json = await http(url, {
      headers: {
        Accept: "application/json",
        ...(k ? { Authorization: `Bearer ${k}` } : {}),
        ...(o.format ? { "X-Return-Format": o.format } : {}),
      },
      signal: o.signal,
      fetch: o.fetch,
    });
    jinaOk(r, url);
    const d = r.data ?? { url: page, content: "" };
    return { url: d.url, title: d.title, description: d.description, content: d.content ?? d.text ?? d.html ?? "" };
  },
};

/** Tavily answers a spent plan with 432/433, never 402. */
const tavilyHttp = (url: string, init: HttpInit) =>
  http(url, init).catch((e) => {
    throw e instanceof HTTPError && (e.status === 432 || e.status === 433) ? Object.assign(e, { status: 402 }) : e;
  });

const tavily: Backend = {
  name: "tavily",
  filters: ["includeDomains", "excludeDomains", "category", "startPublishedDate", "endPublishedDate"],
  categories: ["general", "news", "finance"],
  async search(login, query, o) {
    const r: Json = await tavilyHttp(`${base(login, "https://api.tavily.com")}/search`, {
      signal: o.signal,
      fetch: o.fetch,
      json: {
        api_key: key(login, "tavily"),
        query,
        max_results: o.maxResults ?? 10,
        search_depth: "basic",
        ...(o.category && this.categories?.includes(o.category) ? { topic: o.category } : {}),
        include_answer: o.summary ?? false,
        include_raw_content: o.fullText ?? false,
        include_published_date: true,
        include_domains: o.includeDomains,
        exclude_domains: o.excludeDomains,
        ...(o.startPublishedDate ? { start_date: day(o.startPublishedDate) } : {}),
        ...(o.endPublishedDate ? { end_date: day(o.endPublishedDate) } : {}),
      },
    });
    return {
      results: r.results.map((x: Json) => ({
        url: x.url,
        title: x.title,
        snippet: x.content,
        score: x.score,
        ...(x.published_date ? { publishedDate: x.published_date } : {}),
        ...(typeof x.raw_content === "string" ? { text: x.raw_content } : {}),
      })),
      ...(r.answer === undefined ? {} : { metadata: { answer: r.answer } }),
    };
  },
  async read(login, url, o) {
    const r: Json = await tavilyHttp(`${base(login, "https://api.tavily.com")}/extract`, {
      headers: { Authorization: `Bearer ${key(login, "tavily")}` },
      signal: o.signal,
      fetch: o.fetch,
      json: { urls: [url], extract_depth: "basic", format: o.format === "text" ? "text" : "markdown" },
    });
    const x = r.results?.[0];
    if (!x) throw new Error(`Tavily extract failed: ${r.failed_results?.[0]?.error ?? "no result returned"}`);
    return { url: x.url, ...(x.title ? { title: x.title } : {}), content: x.raw_content ?? "" };
  },
};

const searxng: Backend = {
  name: "searxng",
  filters: ["category"],
  async search(login, query, o) {
    const p = new URLSearchParams({ q: query, format: "json", pageno: "1" });
    if (o.category) p.set("categories", o.category);
    const r: Json = await http(`${base(login, "http://localhost:8080")}/search?${p}`, {
      signal: o.signal,
      fetch: o.fetch,
    });
    return {
      results: r.results.slice(0, o.maxResults).map((x: Json) => ({
        url: x.url,
        title: x.title,
        snippet: x.content ?? "",
        score: x.score,
        publishedDate: x.publishedDate,
      })),
    };
  },
};

const serpapi: Backend = {
  name: "serpapi",
  filters: [],
  async search(login, query, o) {
    const p = new URLSearchParams({
      engine: "google",
      q: query,
      api_key: key(login, "serpapi"),
      num: String(o.maxResults ?? 10),
    });
    const r: Json = await http(`${base(login, "https://serpapi.com")}/search?${p}`, {
      signal: o.signal,
      fetch: o.fetch,
    });
    return {
      results: (r.organic_results ?? [])
        .slice(0, o.maxResults ?? 10)
        .map((x: Json) => ({ url: x.link, title: x.title, snippet: x.snippet ?? "", publishedDate: x.date })),
    };
  },
  async searchImage(login, image, o) {
    const p = new URLSearchParams({
      engine: "google_lens",
      type: "visual_matches",
      url: image,
      api_key: key(login, "serpapi"),
    });
    const r: Json = await http(`${base(login, "https://serpapi.com")}/search?${p}`, {
      signal: o.signal,
      fetch: o.fetch,
    });
    // Lens reports an empty page as `error` under a `Success` status
    if (r.error && r.search_metadata?.status !== "Success") throw new Error(r.error);
    return (r.visual_matches ?? [])
      .filter((x: Json) => x.link && (x.image ?? x.thumbnail))
      .slice(0, o.maxResults)
      .map((x: Json) => ({ title: x.title ?? x.source ?? "", pageUrl: x.link, imageUrl: x.image ?? x.thumbnail }));
  },
};

// Codex: web search through the Responses API of a ChatGPT login, the bearer only ever sent to OpenAI's endpoint
const CODEX = "https://chatgpt.com/backend-api/codex/responses";

/** `chatgpt_account_id` from the access token's claims, when the entry doesn't name the account. */
function accountId(entry: Secret, token: string) {
  if (typeof entry.accountId === "string") return entry.accountId;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return claims["https://api.openai.com/auth"]?.chatgpt_account_id as string | undefined;
  } catch {
    return undefined;
  }
}

async function codexSearch(entry: Secret | undefined, query: string, o: SearchOptions): Promise<Searched> {
  const token = entry?.accessToken ?? entry?.apiKey;
  if (typeof token !== "string")
    throw new Error('No Codex login: add an "openai-codex" entry to ~/.hortus/secrets.json');
  const account = accountId(entry as Secret, token);
  let res: Response;
  try {
    res = await o.fetch(CODEX, {
      method: "POST",
      signal: o.signal,
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(account ? { "chatgpt-account-id": account } : {}),
        "OpenAI-Beta": "responses=experimental",
        originator: "hortus-web",
      },
      body: JSON.stringify({
        model: typeof entry?.searchModel === "string" ? entry.searchModel : "gpt-5.5",
        stream: true,
        store: false,
        include: ["web_search_call.action.sources"],
        instructions: "Search the web to answer the user's query. Cite your sources and keep the answer concise.",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query }] }],
        tools: [{ type: "web_search", search_context_size: "high" }],
        tool_choice: { type: "web_search" },
      }),
    });
  } catch (e) {
    throw new HTTPError(0, CODEX, e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) throw new HTTPError(res.status, CODEX, await res.text().catch(() => ""));
  // ponytail: reads the whole stream before parsing; it's only used once complete anyway
  const events: Json[] = (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
  const results = new Map<string, SearchResult>();
  const answer: string[] = [];
  let searched = false;
  const add = (url: unknown, title: unknown) => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return;
    const prev = results.get(url);
    if (!prev || (prev.title === url && title))
      results.set(url, { url, title: typeof title === "string" && title ? title : url, snippet: "" });
  };
  const collect = (item: Json) => {
    if (item?.type === "web_search_call") {
      searched = true;
      for (const s of [...(item.action?.sources ?? []), ...(item.sources ?? []), ...(item.results ?? [])])
        add(s.url ?? s.source_website_url, s.title ?? s.caption);
    }
    if (item?.type === "message")
      for (const part of item.content ?? []) {
        if (part.type !== "output_text") continue;
        if (part.text) answer.push(part.text);
        for (const a of part.annotations ?? []) if (a.type === "url_citation") add(a.url, a.title);
      }
  };
  for (const e of events) {
    if (e.type === "error" || e.type === "response.failed") {
      const detail = JSON.stringify(e);
      throw new HTTPError(
        /unauthori[sz]ed|token|401/i.test(detail) ? 401 : /rate|quota|429/i.test(detail) ? 429 : 502,
        CODEX,
        detail,
      );
    }
    if (e.type === "response.web_search_call.completed") searched = true;
    if (e.type === "response.output_item.done") collect(e.item);
    if (e.type === "response.completed" || e.type === "response.done") {
      for (const item of e.response?.output ?? []) collect(item);
      if (!searched) throw new HTTPError(502, CODEX, "Codex answered without running web search");
      return {
        results: [...results.values()].slice(0, o.maxResults ?? 10),
        metadata: { model: e.response?.model, ...(o.summary && answer.length ? { answer: answer.join("\n\n") } : {}) },
      };
    }
  }
  throw new HTTPError(502, CODEX, "Codex stream ended before completion");
}

const codex: Backend = {
  name: "openai-codex",
  filters: [],
  async search(login, query, o) {
    try {
      return await codexSearch(login.entry, query, o);
    } catch (e) {
      // a rejected token: ask the login's owner for a fresh one, once
      if (!(e instanceof HTTPError && e.status === 401)) throw e;
      return codexSearch(await login.refresh(), query, o);
    }
  },
};

// ponytail: 7 of the package's 12 backends (every auth shape and capability); context, firecrawl, mojeek, serpbase and
// tinyfish are more of the same, add them as Backends here
/** In the package's order of automatic selection (searxng, keyless and self-hosted, last). */
export const BACKENDS: Backend[] = [exa, brave, jina, tavily, serpapi, codex, searxng];
