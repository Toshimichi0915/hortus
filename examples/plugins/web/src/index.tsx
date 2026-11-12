import { type CliPlugin, cliOf, linesRenderer, type Span, theme, type ToolView } from "@hortus/cli";
import { tool } from "@hortus/core";
import { z } from "zod";
import {
  batch,
  formatImages,
  formatProviders,
  formatRead,
  formatSearch,
  providers,
  read,
  type SearchDetails,
  search,
  searchImage,
} from "./web.ts";

const many = (what: string) =>
  z.union([z.string(), z.array(z.string()).min(1).max(10)]).describe(`${what}, or a batch`);
const timeoutSeconds = z
  .int()
  .min(1)
  .max(3600)
  .optional()
  .describe("Give up after this many seconds; a batch reports the unfinished items as errors");
const provider = (hint: string) => z.string().optional().describe(hint);

const webSearch = tool({
  name: "web_search",
  description:
    "Read-only/open-world network search: query one configured provider (Exa, Brave, Jina, Tavily, SerpAPI, OpenAI Codex, SearXNG) or fan out to every configured one with provider=all. Accepts one query or a batch; each batch item has its own results or error. Responses report filters the provider ignored. Each result has url, title, snippet; other fields vary by provider. Use web_providers for which providers are configured and their filters.",
  inputSchema: z.object({
    query: many("Search query"),
    provider: provider(
      '"auto" (default) tries the configured providers in order, moving on after payment, rate limit, timeout or server failures; "all" queries every configured one in parallel; or a provider name.',
    ),
    maxResults: z.int().min(1).max(20).optional().describe("Maximum results. Defaults to 10."),
    summary: z.boolean().optional().describe("Request generated summaries or answers when supported."),
    fullText: z.boolean().optional().describe("Request full page text when supported."),
    includeDomains: z.array(z.string()).optional().describe("Only results from these domains."),
    excludeDomains: z.array(z.string()).optional().describe("Exclude results from these domains."),
    category: z.string().optional().describe('Search category (e.g. "news"); support varies.'),
    startPublishedDate: z.string().optional().describe("ISO date: only results published after it."),
    endPublishedDate: z.string().optional().describe("ISO date: only results published before it."),
    timeoutSeconds,
  }),
  async execute({ query, ...rest }, ctx) {
    if (typeof query === "string") {
      const d = await search(ctx, { query, ...rest });
      ctx.update(d);
      return formatSearch(d);
    }
    const outcomes = await batch(query, (q) => search(ctx, { query: q, ...rest }));
    ctx.update(outcomes);
    return outcomes
      .map((o, i) => `[${i + 1}] ${o.item}\n${"error" in o ? `Error: ${o.error}` : formatSearch(o.value)}`)
      .join("\n\n");
  },
});

const webRead = tool({
  name: "web_read",
  description:
    "Read-only/open-world network fetch: read one URL or a batch into normalized content. Automatic reads start with Jina (no key needed) and fall back to the other configured read providers after eligible failures. Content is cut at maxChars; a truncated read returns a continuation token for the rest.",
  inputSchema: z.object({
    url: many("URL to read"),
    provider: provider('"auto" (default) or a read provider name.'),
    format: z.enum(["markdown", "text", "html"]).optional().describe("Preferred content format."),
    maxChars: z.int().min(1).max(200_000).optional().describe("Maximum content characters. Defaults to 20000."),
    continuation: z.string().max(1024).optional().describe("Token from a truncated read of the same single URL."),
    timeoutSeconds,
  }),
  async execute({ url, ...rest }, ctx) {
    if (typeof url === "string") {
      const d = await read(ctx, { url, ...rest });
      ctx.update(d);
      return formatRead(url, d);
    }
    if (rest.continuation) throw new Error("continuation is only supported for a single URL");
    const outcomes = await batch(url, (u) => read(ctx, { url: u, ...rest }));
    ctx.update(outcomes);
    return outcomes
      .map((o, i) => `[${i + 1}] ${"error" in o ? `${o.item}\nError: ${o.error}` : formatRead(o.item, o.value)}`)
      .join("\n\n");
  },
});

const webSearchImage = tool({
  name: "web_search_image",
  description:
    "Read-only/open-world reverse image search: find public pages containing or resembling an image available by URL.",
  inputSchema: z.object({
    url: z.string().describe("Public HTTP or HTTPS image URL."),
    provider: provider("Reverse image search provider. Defaults to serpapi (Google Lens)."),
    maxResults: z.int().min(1).max(20).optional().describe("Maximum matches. Defaults to 10."),
  }),
  async execute(input, ctx) {
    const d = await searchImage(ctx, input);
    ctx.update(d);
    return formatImages(input.url, d);
  },
});

const webProviders = tool({
  name: "web_providers",
  description:
    "Read-only local status: list the web providers, whether each is configured in ~/.hortus/secrets.json, what it does and which search filters it honours.",
  inputSchema: z.object({}),
  async execute(_, ctx) {
    const list = await providers(ctx);
    ctx.update(list);
    return formatProviders(list);
  },
});

const PROMPT = `Search the web with web_search (pass a query array for independent batch results, or provider=all to query every configured provider in parallel) and read pages with web_read.
- Use web_search when the user asks for fresh web information, news, references, or links; web_read when they need a specific URL's contents; web_search_image for reverse image lookup.
- Prefer a single provider when the user names one; use provider=all when freshness or coverage matters and at least two providers are configured.
- Use web_providers when provider availability or filter support is unclear.
- Request summaries or full text deliberately: they increase cost and context size. Pass maxResults conservatively (5-10) unless asked for more.
- Forward domain, category, and date filters when the user gives concrete values.`;

const TITLES: Record<string, string> = {
  web_search: "Web Search",
  web_read: "Web Read",
  web_search_image: "Search by Image",
  web_providers: "Web Providers",
};

/** One line for the call (title, then its query or URL), then the result's header and its first few hits. */
const webRenderer = linesRenderer(({ call, result, details }: ToolView): Span[][] => {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const subject = [input.query ?? input.url ?? ""].flat().join(" | ");
  const extra = typeof input.provider === "string" ? ` · ${input.provider}` : "";
  const head: Span[] = [
    { text: TITLES[call.name] ?? call.name, bold: true },
    { text: ` ${subject}${extra}`, color: theme.dim },
  ];
  if (!result) return [head];
  const [first = ""] = result.output.split("\n");
  if (result.isError) return [head, [{ text: first, color: theme.red }]];
  const hits = (details as SearchDetails | undefined)?.results;
  const top = call.name === "web_search" && Array.isArray(hits) ? hits.slice(0, 5) : [];
  return [
    head,
    [{ text: first, color: theme.muted }],
    ...top.map((h): Span[] => [
      { text: `  ${h.title || h.url}`, color: theme.text },
      { text: ` ${h.url}`, color: theme.dim },
    ]),
  ];
});

/**
 * Web search, read and reverse image search over the backends of @agntn/web, with credentials from secrets.json
 * entries whose `type` is the backend (`{ "brave": { "type": "brave", "apiKey": "${BRAVE_API_KEY}" } }`), and Codex
 * search over an `openai-codex` login refreshed by the plugin that owns it.
 */
export default {
  // the guidance covers all four tools; it rides on web_search, so it's in the prompt whenever that is declared
  tools: [{ ...webSearch, prompt: PROMPT }, webRead, webSearchImage, webProviders],
  commands: [
    {
      name: "web",
      args: "<query>",
      description: "Search the web; in the TUI, pick a hit to put its URL into the prompt",
      run: async (arg, ctx) => {
        if (!arg?.trim()) throw new Error("Usage: /web <query>");
        const d = await search(ctx, { query: arg });
        const tui = ctx.host.kind === "tui" && ctx.host.interactive;
        if (!tui || !d.results.length) return formatSearch(d);
        const url = await ctx.ask({
          question: `${d.results.length} result(s) for "${d.query}": put one into the prompt?`,
          options: d.results.map((h) => ({ label: h.url, ...(h.title && { description: h.title }) })),
        });
        if (typeof url !== "string") return formatSearch(d);
        const cli = cliOf(ctx);
        const input = cli.ui.getState().input;
        cli.setInput(input ? `${input.trimEnd()} ${url}` : url);
        return undefined;
      },
    },
    {
      name: "web-providers",
      description: "List the web providers",
      run: async (_, ctx) => formatProviders(await providers(ctx)),
    },
  ],
  cli: {
    tools: Object.fromEntries(Object.keys(TITLES).map((name) => [name, webRenderer])),
  },
} satisfies CliPlugin;
