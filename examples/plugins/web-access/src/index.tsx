import { type CliPlugin, linesRenderer, type Span, theme, type ToolView } from "@hortus/cli";
import { type Ctx, type Tool, type ToolCtx, tool, toolResult } from "@hortus/core";
import { z } from "zod";
import { answerFromPage, type Extraction, extractFields, type Fetched, fetchAll, formatExtraction } from "./fetch.ts";
import { type Recency, search } from "./search.ts";
import {
  dataOf,
  entries,
  type Extracted,
  type FindMode,
  findContent,
  formatFullResults,
  formatSearchSummary,
  newId,
  type QueryResult,
  type Research,
  type Stored,
  slice,
} from "./store.ts";
import {
  activityOf,
  type Config,
  errorText,
  FETCH_MODES,
  type FetchMode,
  isAbort,
  limit3,
  loadConfig,
  maxInline,
  quiet,
  saveConfig,
  showActivity,
  type Workflow,
} from "./web.ts";

const NAMES = ["web_search", "source_check", "fetch_content", "get_search_content"] as const;
const GET = "get_search_content";

/** Per-agent state (`ctx.state`): shared by the tools, handlers and commands of this plugin. */
interface State {
  /** background content fetches, by fetch id: aborted when their session closes */
  pending: Map<string, { controller: AbortController; session: unknown }>;
  /** dynamic activation: the web tools a run started without, by run id, for `web_enable` to add */
  stash: Map<string, Tool[]>;
}

const st = (ctx: Ctx): State => {
  ctx.state.web ??= { pending: new Map(), stash: new Map() } satisfies State;
  return ctx.state.web as State;
};

const stored = (ctx: Ctx) => (ctx.session ? dataOf(ctx.session.getState(), ctx.plugin).results : {});

/** Saves a result for `get_search_content` (and `/search`): an entry, so it survives resume and follows branches. */
async function store(ctx: Ctx, data: Stored) {
  await ctx.session?.appendEntry(`${ctx.plugin}:results`, data);
}

const strip = (f: Fetched[]): Extracted[] => f.map(({ image: _, ...rest }) => rest);
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;

/** Queries from `query` (comma or newline separated lists are split, as Pi's `expandQueryString`) or `queries`. */
function queryList(input: { query?: string; queries?: string[] }): string[] {
  const raw =
    input.queries ?? (input.query?.includes("\n") ? input.query.split("\n") : input.query ? [input.query] : []);
  return [...new Set(raw.map((q) => q.trim()).filter(Boolean))];
}

/** The auto-summary workflow: a model's summary of the results, else (failure, timeout) a deterministic one. */
async function summarize(ctx: Ctx, results: QueryResult[], config: Config) {
  const started = Date.now();
  const prompt = [
    "You are writing the final web search summary for a coding assistant.",
    "Write a concise, factual summary using only the provided search results.",
    "Requirements:",
    "- Keep it readable and skimmable.",
    "- Include key findings and caveats.",
    "- Do not invent sources or claims.",
    "- If evidence is weak or conflicting, say so explicitly.",
    '- End with a short "Sources" section listing the most relevant URLs.',
    config.summaryInstructions?.trim() ?? "",
    "",
    "<search_results>",
    ...results.map((r, i) => `\n[Result ${i + 1}]\n${formatFullResults(r).slice(0, 12_000)}`),
    "\n</search_results>",
  ].join("\n");
  try {
    const reply = await ctx.complete({
      ...(await quiet(ctx, config.summaryModel)).request,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 2000,
      signal: AbortSignal.timeout(config.summaryTimeoutMs ?? 30_000),
    });
    if (!reply.text.trim()) throw new Error("empty summary");
    return {
      text: reply.text.trim(),
      meta: {
        model: config.summaryModel ?? ctx.run?.model ?? null,
        durationMs: Date.now() - started,
        fallbackUsed: false,
      },
    };
  } catch (e) {
    ctx.signal.throwIfAborted();
    const urls = [...new Set(results.flatMap((r) => r.results.map((s) => s.url)))];
    const text = [
      "Summary based on the currently selected search results.",
      "",
      ...results.map((r) =>
        r.error
          ? `- ${r.query}: failed (${r.error})`
          : `- ${r.query}: ${
              r.answer
                .replace(/\s+/g, " ")
                .replace(/\bSources?\s*:.*$/i, "")
                .trim()
                .slice(0, 240) || `returned ${plural(r.results.length, "source")} without answer text.`
            }`,
      ),
      "",
      "Sources",
      ...(urls.length ? urls.slice(0, 12).map((u) => `- ${u}`) : ["- None"]),
    ].join("\n");
    return {
      text,
      meta: { model: null, durationMs: Date.now() - started, fallbackUsed: true, fallbackReason: errorText(e) },
    };
  }
}

/**
 * Fetches `urls` after the call returned (Pi's background fetch), stores them, then tells the model in a plugin message
 * that starts (or steers) a turn; a failure is a message that doesn't. Aborted when the session closes.
 */
function backgroundFetch(ctx: ToolCtx, urls: string[], inline: Extracted[], config: Config): string {
  const s = st(ctx);
  const id = newId();
  const controller = new AbortController();
  s.pending.set(id, { controller, session: ctx.session });
  const meta = (type: string, details: unknown) => ({ plugin: ctx.plugin, type, display: true, details });
  void (async () => {
    try {
      const covered = new Map(inline.map((c) => [c.url, c]));
      const missing = urls.filter((u) => !covered.has(u));
      const got = await fetchAll(ctx, missing, { mode: "readable", signal: controller.signal }, config);
      for (const g of got) covered.set(g.url, g);
      const fetched = strip(
        urls.map((u) => covered.get(u) ?? { url: u, title: "", content: "", error: "not fetched" }),
      );
      controller.signal.throwIfAborted();
      await store(ctx, { id, type: "fetch", timestamp: Date.now(), urls: fetched });
      const ok = fetched.filter((f) => !f.error).length;
      const availability =
        ok === fetched.length
          ? "Full page content now available."
          : ok
            ? "Partial page content now available."
            : "No page content was fetched. Stored fetch diagnostics are available.";
      await ctx.send(
        {
          content: `Content fetched for ${ok}/${fetched.length} URLs [${id}]. ${availability}`,
          meta: meta("content-ready", { fetchId: id, ok, total: fetched.length }),
        },
        { deliver: "steer" },
      );
    } catch (e) {
      if (controller.signal.aborted || isAbort(e)) return;
      await ctx
        .send(
          { content: `Content fetch failed [${id}]: ${errorText(e)}`, meta: meta("error", { fetchId: id }) },
          { deliver: "context" },
        )
        .catch(() => {});
    } finally {
      s.pending.delete(id);
    }
  })();
  return id;
}

const recency = z.enum(["day", "week", "month", "year"]).optional();
const domainFilter = z.array(z.string()).optional().describe("Prefix - to exclude");
const provider = z
  .string()
  .optional()
  .describe("auto, all, a name, or comma-separated names; omit for the configured default.");

const str = { type: "string" };
const webSearch = tool({
  name: "web_search",
  // what scripts get (the result's `value`); the model gets the text
  outputSchema: {
    type: "object",
    required: ["responseId", "results"],
    properties: {
      responseId: { ...str, description: `for ${GET}` },
      fetchId: { ...str, description: "background content fetch, when includeContent" },
      summary: str,
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["query", "results"],
          properties: {
            query: str,
            error: str,
            results: {
              type: "array",
              items: { type: "object", properties: { title: str, url: str, snippet: str } },
            },
          },
        },
      },
    },
  },
  description: `Search the web for sources or answers. Full results are stored for retrieval with ${GET} by responseId. Prefer 2-4 varied queries.`,
  prompt:
    "Web research: prefer web_search({queries:[...]}) with 2-4 varied angles; omit provider unless overriding the default.",
  inputSchema: z.object({
    query: z.string().optional(),
    queries: z.array(z.string()).optional().describe("Run concurrently (up to three at a time); vary the angle"),
    numResults: z.int().min(1).max(20).optional().describe("Default 5"),
    includeContent: z.boolean().optional().describe("Also fetch full page content"),
    recencyFilter: recency,
    domainFilter,
    category: z.string().optional().describe("Exa only, e.g. news"),
    model: z.string().optional().describe("Model ID; needs provider openai"),
    provider,
    workflow: z.enum(["none", "auto-summary"]).optional().describe("Default none; auto-summary summarizes"),
  }),
  async execute(input, ctx) {
    // called by another tool (a codemode script): `ctx.parentId`
    const nested = ctx.parentId !== undefined;
    const config = await loadConfig(ctx);
    const queries = queryList(input);
    if (!queries.length) {
      ctx.update({ error: "No query provided" });
      throw new Error("No query provided. Use 'query' or 'queries' parameter.");
    }
    // nested calls (codemode scripts) don't summarize unless asked, and wait for content instead of a background fetch
    const workflow: Workflow = input.workflow ?? (nested ? "none" : (config.workflow ?? "none"));
    let done = 0;
    const opts = { ...input, recencyFilter: input.recencyFilter as Recency | undefined, signal: ctx.signal };
    const responses = await limit3(queries, async (query) => {
      ctx.update({ phase: "search", progress: done / queries.length, currentQuery: query });
      try {
        const r = await search(ctx, query, opts, config, input.provider);
        return {
          result: {
            query,
            answer: r.answer,
            results: r.results,
            error: null,
            provider: r.provider,
            providers: r.providers ?? [r.provider],
          } as QueryResult,
          inline: r.inline ?? [],
        };
      } catch (e) {
        if (ctx.signal.aborted || isAbort(e)) throw e;
        return {
          result: { query, answer: "", results: [], error: errorText(e), provider: input.provider } as QueryResult,
          inline: [],
        };
      } finally {
        done++;
      }
    });
    const results = responses.map((r) => r.result);
    const urls = [...new Set(results.flatMap((r) => r.results.map((s) => s.url)))];
    let inline = responses.flatMap((r) => r.inline);
    const summary = workflow === "auto-summary" ? await summarize(ctx, results, config) : undefined;

    const max = maxInline(config);
    let fetchId: string | null = null;
    let background = false;
    if (input.includeContent && urls.length) {
      const covered = new Set(inline.map((c) => c.url));
      if (nested && !urls.every((u) => covered.has(u))) {
        const missing = urls.filter((u) => !covered.has(u));
        inline = [...inline, ...strip(await fetchAll(ctx, missing, { mode: "readable", signal: ctx.signal }, config))];
      }
      if (urls.every((u) => inline.some((c) => c.url === u))) {
        fetchId = newId();
        await store(ctx, { id: fetchId, type: "fetch", timestamp: Date.now(), urls: inline });
      } else {
        fetchId = backgroundFetch(ctx, urls, inline, config);
        background = true;
      }
    }
    const searchId = newId();
    await store(ctx, { id: searchId, type: "search", timestamp: Date.now(), queries: results });

    let body: string;
    if (summary) body = summary.text;
    else {
      body =
        results.length === 1
          ? `**Provider:** ${results[0]?.providers?.join(", ") || "unknown"}\n\n`
          : `**Providers used:** ${results.map((r, i) => `Query ${i + 1}: ${r.providers?.join(", ") || "unknown"}`).join("; ")}\n\n`;
      for (const r of results) {
        if (queries.length > 1) body += `## Query: "${r.query}"\n\n`;
        body += r.error ? `Error: ${r.error}\n\n` : `${formatSearchSummary(r.results, r.answer)}\n\n`;
      }
      body = body.trim();
    }
    let guidance = "";
    if (fetchId && !background)
      guidance += `\n---\nFull content for ${urls.length} sources is ready as responseId "${fetchId}". Use ${GET}({ responseId: "${fetchId}", urlIndex: 0, offset: 0, limit: ${max} }) to retrieve the first bounded page.`;
    else if (fetchId)
      guidance += `\n---\nContent fetching in background as responseId "${fetchId}". Will notify when ready.`;
    guidance += `\n---\nFull search results are stored as responseId "${searchId}". Use ${GET}({ responseId: "${searchId}", queryIndex: 0, offset: 0, limit: ${max} }) to retrieve the first bounded page${results.length > 1 ? `; repeat with queryIndex 1 through ${results.length - 1}` : ""}.`;
    let text = `${body}\n${guidance}`;
    const truncated = !summary && text.length > max;
    if (truncated) {
      const marker = `\n\n---\n[Output truncated.]${guidance}`;
      text = `${body.slice(0, Math.max(0, max - marker.length))}${marker}`;
    }
    const details = {
      queries,
      queryCount: queries.length,
      successfulQueries: results.filter((r) => !r.error).length,
      totalResults: results.reduce((n, r) => n + r.results.length, 0),
      includeContent: input.includeContent ?? false,
      fetchId,
      fetchUrls: background ? urls : undefined,
      searchId,
      queryProviders: results.map((r) => ({ query: r.query, providers: r.providers ?? [] })),
      truncated,
      results: results.map((r) => ({ query: r.query, error: r.error, sources: r.results.slice(0, 5) })),
      ...(summary && { summary: { text: summary.text, workflow, ...summary.meta } }),
    };
    ctx.update(details);
    // the text for the model, and the structured result (Pi's structuredContent) for scripts (`outputSchema`)
    return toolResult({
      output: text,
      value: { responseId: searchId, fetchId, results, ...(summary && { summary: summary.text }) },
    });
  },
});

const STOP = new Set(
  "the and for with that this from are was were has have had not but its into than then they them what when which who will would about".split(
    " ",
  ),
);

/** Gathers cited passages about a claim (Pi's `source_check`): sources, then the sentences sharing its terms. */
const sourceCheck = tool({
  name: "source_check",
  description: "Gather cited web passages about a claim for manual review.",
  prompt: "Use source_check to gather source evidence with passage citations for a claim.",
  inputSchema: z.object({
    claim: z.string().describe("Assertion to check"),
    queries: z.array(z.string()).optional().describe("Default: the claim"),
    numResults: z.int().min(1).max(20).optional().describe("Default 5"),
    fetchContent: z.boolean().optional().describe("Fetch top 5 pages for exact passages"),
    recencyFilter: recency,
    domainFilter,
    provider,
  }),
  async execute(input, ctx) {
    const claim = input.claim.trim();
    if (!claim) throw new Error("'claim' is required.");
    const config = await loadConfig(ctx);
    const queries = (
      input.queries?.map((q) => q.trim()).filter(Boolean).length
        ? input.queries.map((q) => q.trim()).filter(Boolean)
        : [claim]
    ).slice(0, 8);
    const byUrl = new Map<string, { title: string; url: string; snippet: string }>();
    const summaries: string[] = [];
    const errors: { query: string; error: string }[] = [];
    let used: string | undefined;
    for (const [i, query] of queries.entries()) {
      ctx.update({ phase: "search", progress: i / queries.length, currentQuery: query });
      try {
        const r = await search(
          ctx,
          query,
          {
            ...input,
            recencyFilter: input.recencyFilter as Recency | undefined,
            numResults: input.numResults ?? 5,
            signal: ctx.signal,
          },
          config,
          input.provider,
        );
        used ??= r.provider;
        if (r.answer) summaries.push(`${query}: ${r.answer}`);
        for (const s of r.results) if (!byUrl.has(s.url)) byUrl.set(s.url, s);
      } catch (e) {
        if (ctx.signal.aborted || isAbort(e)) throw e;
        errors.push({ query, error: errorText(e) });
      }
    }
    const sources = [...byUrl.values()].slice(0, 20).map((s, i) => ({ ...s, rank: i + 1 }));
    const fetched =
      input.fetchContent && sources.length
        ? await fetchAll(
            ctx,
            sources.slice(0, 5).map((s) => s.url),
            { mode: "readable", signal: ctx.signal },
            config,
          )
        : [];
    const terms = [
      ...new Set(
        claim
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 2 && !STOP.has(w)),
      ),
    ];
    const need = Math.max(1, Math.ceil(terms.length * 0.4));
    const passages = sources.flatMap((s) => {
      const text = fetched.find((f) => f.url === s.url && !f.error)?.content || s.snippet;
      return text
        .split(/(?<=[.!?])\s+|\n+/)
        .map((t) => ({ t: t.trim(), score: terms.filter((w) => t.toLowerCase().includes(w)).length }))
        .filter((p) => p.t && p.score >= need)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)
        .map((p) => ({ rank: s.rank, url: s.url, text: p.t.slice(0, 600) }));
    });
    const artifact: Research = {
      claim,
      provider: used,
      ...(summaries.length && { summary: summaries.join("\n\n") }),
      sources,
      passages,
      ...(errors.length && { errors }),
    };
    const id = newId();
    await store(ctx, { id, type: "research", timestamp: Date.now(), artifact });
    const lines = [`# Source check: ${claim}`, ""];
    if (sources.length) {
      lines.push("## Sources");
      let budget = 4000;
      let omitted = 0;
      for (const s of sources) {
        lines.push(`${s.rank}. ${s.title}\n   ${s.url}`);
        for (const [n, p] of passages.filter((p) => p.rank === s.rank).entries()) {
          const text = p.text.length > 400 ? `${p.text.slice(0, 400)}…` : p.text;
          if (text.length > budget) omitted++;
          else {
            budget -= text.length;
            lines.push(`   - P${s.rank}.${n + 1}: ${text}`);
          }
        }
      }
      if (omitted) lines.push(`${plural(omitted, "more passage")} in the artifact.`);
      lines.push("");
    }
    if (errors.length) lines.push(`Search errors: ${errors.map((e) => `${e.query}: ${e.error}`).join("; ")}`);
    lines.push(`Artifact responseId: ${id} (retrievable via ${GET}).`);
    ctx.update({
      responseId: id,
      sourceCount: sources.length,
      passageCount: passages.length,
      searchCount: queries.length,
    });
    return lines.join("\n");
  },
});

const fetchContent = tool({
  name: "fetch_content",
  description: `Fetch web pages, GitHub repos and images, as the mode allows. Full content is stored for retrieval with ${GET}.`,
  prompt:
    'Use fetch_content to fetch URL content, direct images and GitHub repos. For specific values (a price, version, date or limit), use mode "extract" with fields instead of reading the whole page, when it is allowed.',
  inputSchema: z.object({
    url: z.string().optional(),
    urls: z.array(z.string()).optional(),
    forceClone: z.boolean().optional().describe("Clone GitHub repos over the size limit"),
    prompt: z.string().optional().describe("Question for answer mode"),
    mode: z
      .enum(FETCH_MODES)
      .optional()
      .describe(
        "readable (default): page as markdown; raw: the body as is; answer: a model answers prompt from each page; extract: typed fields (if allowed)",
      ),
    answerModel: z.string().optional().describe("provider/model-id for answer mode"),
    fields: z.record(z.string(), z.string()).optional().describe('For extract: name → "type" or "type: what to find"'),
    redirects: z.enum(["same-origin"]).optional().describe("Refuse cross-origin redirects"),
  }),
  async execute(input, ctx) {
    const config = await loadConfig(ctx);
    const allowed: readonly FetchMode[] = config.fetch?.allowedModes ?? ["readable", "raw", "answer"];
    const mode = input.mode ?? config.fetch?.defaultMode ?? "readable";
    const fail = (error: string): never => {
      ctx.update({ error });
      throw new Error(error);
    };
    if (!allowed.includes(mode)) fail(`Fetch mode "${mode}" is disabled by fetch.allowedModes.`);
    if (mode === "answer" && !input.prompt) fail("mode answer requires prompt.");
    if (mode === "raw" && (input.forceClone || input.prompt || input.answerModel))
      fail("mode raw cannot be combined with forceClone, prompt, or answerModel.");
    if (mode !== "answer" && input.answerModel) fail("answerModel requires mode answer.");
    if (mode !== "extract" && input.fields) fail("fields requires mode extract.");
    if (mode === "extract" && !input.fields) fail("mode extract requires fields.");
    const urls = [
      ...new Set([...(input.urls ?? []), ...(input.url ? [input.url] : [])].map((u) => u.trim()).filter(Boolean)),
    ];
    if (!urls.length) fail("No URL provided. Use the 'url' parameter, or 'urls' for parallel fetches.");

    ctx.update({ phase: "fetch", progress: 0, urls });
    const pages = await fetchAll(
      ctx,
      urls,
      { mode, forceClone: input.forceClone, sameOrigin: input.redirects === "same-origin", signal: ctx.signal },
      config,
    );
    const textual =
      mode === "answer" || mode === "extract"
        ? pages.map((p) => (!p.error && p.image ? { ...p, error: "requires textual fetched content" } : p))
        : pages;
    const model = input.answerModel ?? config.fetch?.answerModel;
    const shown =
      mode === "answer"
        ? await Promise.all(
            textual.map(async (p) => {
              if (p.error) return p;
              try {
                return { ...p, content: await answerFromPage(ctx, input.prompt ?? "", p, model, ctx.signal) };
              } catch (e) {
                if (ctx.signal.aborted) throw e;
                return { ...p, error: `Page answer failed: ${errorText(e)}` };
              }
            }),
          )
        : textual;
    const responseId = newId();
    await store(ctx, { id: responseId, type: "fetch", timestamp: Date.now(), urls: strip(pages) });
    const ok = shown.filter((p) => !p.error).length;
    const max = maxInline(config);

    if (mode === "extract") {
      const extractions = await Promise.all(
        shown.map(async (p): Promise<Extraction | { error: string }> => {
          if (p.error) return { error: p.error };
          return extractFields(ctx, p, input.fields ?? {}, config.fetch?.answerModel, ctx.signal).catch((e) => {
            if (ctx.signal.aborted) throw e;
            return { error: `Field extraction failed: ${errorText(e)}` };
          });
        }),
      );
      let out = "## Extracted fields\n";
      for (const [i, p] of shown.entries()) {
        const x = extractions[i] ?? { error: "not extracted" };
        out += `\n### ${p.title || p.url}\n${"error" in x && typeof x.error === "string" ? `Error: ${x.error}\n` : formatExtraction(x as Extraction)}`;
      }
      if (out.length > max)
        out = `${out.slice(0, max)}\n\n[Results cut at ${max} characters; ask for fewer fields or URLs.]\n`;
      out += `\n---\nThe fetched pages are stored as responseId "${responseId}". Use ${GET}({ responseId: "${responseId}", urlIndex: 0 }) to read the first one; urlIndex follows the order above.`;
      ctx.update({ urls, urlCount: urls.length, successful: ok, mode, responseId, extractions });
      if (!ok) throw new Error(out);
      return out;
    }

    if (urls.length === 1) {
      const p = shown[0];
      if (!p || p.error) return fail(p?.error ?? "No result");
      const page = slice(p.content, 0, max);
      const truncated = page.endOffset < p.content.length;
      let out = page.text;
      if (truncated) {
        out += `\n\n---\nShowing ${page.endOffset} of ${p.content.length} chars. `;
        out +=
          mode === "answer"
            ? `Stored content is the original source, not the remaining answer. Use ${GET}({ responseId: "${responseId}", urlIndex: 0, offset: 0 }) to read the original source from the beginning.`
            : `Use ${GET}({ responseId: "${responseId}", urlIndex: 0, offset: ${page.endOffset} }) for the next slice.`;
      } else
        out += `\n\n---\n${mode === "answer" ? "Original source content" : "Full content"} is stored as responseId "${responseId}". Use ${GET}({ responseId: "${responseId}", urlIndex: 0, offset: 0 }) to retrieve it.`;
      ctx.update({
        urls,
        urlCount: 1,
        successful: 1,
        totalChars: p.content.length,
        title: p.title,
        responseId,
        truncated,
        hasImage: !!p.image,
        mode,
        mimeType: p.mimeType,
        status: p.status,
      });
      return p.image ? [{ ...p.image, text: out }] : out;
    }

    let budget = mode === "answer" ? max : 0;
    let out = mode === "answer" ? "## Page answers\n" : "## Fetched URLs\n\n";
    for (const p of shown) {
      if (mode !== "answer")
        out += p.error ? `- ${p.url}: Error - ${p.error}\n` : `- ${p.title || p.url} (${p.content.length} chars)\n`;
      else if (p.error) out += `\n### ${p.url}\nError: ${p.error}\n`;
      else {
        const part = p.content.slice(0, budget);
        budget -= part.length;
        out += `\n### ${p.title || p.url}\n${part}${part.length === p.content.length ? "" : "\n[answer truncated at the output limit; fetch fewer URLs per call for complete answers]"}\n`;
      }
    }
    out +=
      mode === "answer"
        ? `\n---\nStored content is the original source pages, not the answers. Use ${GET}({ responseId: "${responseId}", urlIndex: 0, offset: 0 }) to read the first source; urlIndex follows the order above.`
        : `\n---\nUse ${GET}({ responseId: "${responseId}", urlIndex: 0 }) to retrieve bounded content slices.`;
    ctx.update({
      urls,
      urlCount: urls.length,
      successful: ok,
      totalChars: shown.reduce((n, p) => n + p.content.length, 0),
      responseId,
    });
    if (!ok) throw new Error(out);
    return out;
  },
});

const getSearchContent = tool({
  name: GET,
  description: "Page through or search stored content from web_search, fetch_content and source_check by responseId.",
  prompt: `Use ${GET} after web_search, fetch_content or source_check to read stored content; findText finds passages without paging.`,
  inputSchema: z.object({
    responseId: z.string(),
    query: z.string().optional(),
    queryIndex: z.int().min(0).optional(),
    url: z.string().optional(),
    urlIndex: z.int().min(0).optional(),
    offset: z.int().min(0).optional(),
    limit: z.int().min(1).optional().describe("Characters, default the maximum"),
    findText: z
      .union([z.string().min(1).max(500), z.array(z.string().min(1).max(500)).min(1).max(10)])
      .optional()
      .describe("Find passages instead of paging"),
    findMode: z.enum(["exact", "case-insensitive", "fuzzy"]).optional(),
  }),
  async execute(input, ctx) {
    const max = maxInline(await loadConfig(ctx));
    const fail = (error: string, text = error): never => {
      ctx.update({ error, responseId: input.responseId });
      throw new Error(text);
    };
    if (input.findMode && input.findText === undefined)
      fail(
        "findMode requires findText",
        `findMode "${input.findMode}" requires findText; provide findText or omit findMode.`,
      );
    const data = stored(ctx)[input.responseId];
    if (!data)
      return fail(
        "Not found",
        `No stored results for responseId "${input.responseId}". Use a responseId returned by web_search, fetch_content or source_check.`,
      );
    const limit = input.limit ?? max;
    if (limit > max) fail("Invalid limit", `Invalid limit: ${limit}; limit must be an integer from 1 to ${max}.`);
    const findMode: FindMode = input.findMode ?? "case-insensitive";

    /** A slice (or the found passages) of `content`, with how to get the next one. */
    const page = (content: string, title: string, next: string, details: Record<string, unknown>) => {
      if (input.findText !== undefined) {
        const found = findContent(content, [input.findText].flat(), findMode);
        ctx.update({
          ...details,
          title,
          contentLength: content.length,
          findMode,
          matchCount: found.matchCount,
          returnedMatches: found.returnedMatches,
        });
        return `# ${title}\n\n${found.text}`;
      }
      const offset = input.offset ?? 0;
      if (offset > content.length)
        fail("Offset out of range", `Offset ${offset} is out of range; valid range is 0-${content.length}.`);
      const s = slice(content, offset, limit);
      const more = s.endOffset < content.length;
      ctx.update({
        ...details,
        title,
        contentLength: content.length,
        offset,
        limit,
        returnedChars: s.endOffset - offset,
        nextOffset: more ? s.endOffset : null,
        truncated: more,
      });
      return `# ${title}\n\n${s.text}${more || offset > 0 ? `\n\n---\nShowing chars ${offset}-${s.endOffset} of ${content.length}.${more ? ` Use ${GET}({ responseId: "${input.responseId}", ${next}offset: ${s.endOffset}, limit: ${limit} }) for the next slice.` : ""}` : ""}`;
    };

    if (data.type === "research")
      return page(JSON.stringify(data.artifact, null, 2), `Source check: ${data.artifact.claim}`, "", {
        responseId: data.id,
        type: "research",
      });
    if (data.type === "search") {
      const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
      const i =
        input.query !== undefined
          ? data.queries.findIndex((q) => q.query === input.query)
          : (input.queryIndex ?? (data.queries.length === 1 ? 0 : -1));
      const q = data.queries[i];
      if (!q)
        return fail(
          "Query not found",
          `Specify an existing query or queryIndex for responseId "${input.responseId}". Available queries: ${available || "none"}.`,
        );
      if (q.error) return fail(q.error, `Error retrieving query "${q.query}": ${q.error}`);
      return page(formatFullResults(q), `"${q.query}"`, `queryIndex: ${i}, `, {
        responseId: data.id,
        query: q.query,
        resultCount: q.results.length,
      });
    }
    const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
    const i =
      input.url !== undefined
        ? data.urls.findIndex((u) => u.url === input.url)
        : (input.urlIndex ?? (data.urls.length === 1 ? 0 : -1));
    const u = data.urls[i];
    if (!u)
      return fail(
        "URL not found",
        `Specify an existing url or urlIndex for responseId "${input.responseId}". Available URLs:\n  ${available || "none"}`,
      );
    if (u.error) return fail(u.error, `Error retrieving URL "${u.url}": ${u.error}`);
    return page(u.content, u.title || u.url, `urlIndex: ${i}, `, { url: u.url });
  },
});

/** Dynamic activation's loader (Pi's `web_enable`): adds the web tools to the running run from its next request on. */
const webEnable = tool({
  name: "web_enable",
  description:
    "Enable the web tools (search, source checking, content fetching, stored-result retrieval). Does not search or fetch. Enabled tools are available on the next model request.",
  prompt:
    "If tools for web search and content fetching are not already available, call web_enable first whenever current, external, or linked information could help; the tools appear on the next model request.",
  inputSchema: z.object({}),
  async execute(_, ctx) {
    const tools = st(ctx).stash.get(ctx.run?.id ?? "") ?? [];
    for (const t of tools) if (!ctx.tools.some((x) => x.name === t.name)) ctx.tools.push(t);
    await ctx.session?.appendEntry(`${ctx.plugin}:enabled`, {});
    return `Enabled: ${tools.map((t) => t.name).join(", ") || "(already enabled)"}.`;
  },
});

const TITLES: Record<string, string> = {
  web_search: "Web Search",
  source_check: "Source Check",
  fetch_content: "Fetch",
  get_search_content: "Get Content",
  web_enable: "Enable Web Access",
};

/** One line for the call, then a progress bar while it runs, else the result's header line (and top sources). */
const renderer = linesRenderer(({ call, result, details }: ToolView): Span[][] => {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const d = (details ?? {}) as Record<string, unknown>;
  const subject = [input.queries ?? input.query ?? input.claim ?? input.urls ?? input.url ?? input.responseId ?? ""]
    .flat()
    .join(" | ");
  const extras = [input.mode, input.provider, input.workflow].filter((x) => typeof x === "string" && x).join(" · ");
  const head: Span[] = [
    { text: TITLES[call.name] ?? call.name, bold: true },
    { text: ` ${subject}${extras ? ` · ${extras}` : ""}`, color: theme.dim },
  ];
  if (!result) {
    if (typeof d.progress !== "number") return [head];
    const n = Math.floor(d.progress * 10);
    return [
      head,
      [
        {
          text: `[${"█".repeat(n)}${"░".repeat(10 - n)}] ${d.phase ?? "working"}${d.currentQuery ? ` ${d.currentQuery}` : ""}`,
          color: theme.accent,
        },
      ],
    ];
  }
  if (result.isError) return [head, [{ text: (result.output.split("\n")[0] ?? "").slice(0, 200), color: theme.red }]];
  let line = result.output.split("\n").find((l) => l.trim()) ?? "";
  if (call.name === "web_search")
    line = `${d.successfulQueries}/${d.queryCount} queries, ${plural(Number(d.totalResults ?? 0), "result")}${d.fetchUrls ? " · fetching content in background" : ""}`;
  if (call.name === "fetch_content")
    line =
      d.urlCount === 1
        ? `${d.title || "Untitled"} (${d.totalChars ?? 0} chars)${d.truncated ? " [truncated]" : ""}${d.hasImage ? " [image]" : ""}`
        : `${d.successful}/${d.urlCount} URLs (content stored)`;
  if (call.name === "get_search_content")
    line =
      typeof d.matchCount === "number"
        ? `${d.title} (${d.matchCount} matches, ${d.returnedMatches} shown)`
        : `${d.title ?? "Content"} (${d.contentLength ?? 0} chars)`;
  if (call.name === "source_check")
    line = `${plural(Number(d.sourceCount ?? 0), "source")}, ${plural(Number(d.passageCount ?? 0), "passage")}`;
  const sources =
    call.name === "web_search"
      ? ((d.results as { sources: { title: string; url: string }[] }[] | undefined) ?? [])
          .flatMap((r) => r.sources)
          .slice(0, 5)
      : [];
  return [
    head,
    [{ text: line, color: theme.muted }],
    ...sources.map((s): Span[] => [
      { text: `  ${s.title || s.url}`, color: theme.text },
      { text: ` ${s.url}`, color: theme.dim },
    ]),
  ];
});

const age = (r: Stored) => {
  const m = Math.floor((Date.now() - r.timestamp) / 60_000);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
};
const label = (r: Stored) =>
  `[${r.id.slice(0, 6)}] ${
    r.type === "search"
      ? `"${r.queries[0]?.query ?? "unknown"}" (${plural(r.queries.length, "query")})`
      : r.type === "fetch"
        ? `${r.urls.length} URLs fetched`
        : `source check "${r.artifact.claim}"`
  } - ${age(r)}`;

function describe(r: Stored): string {
  let info = `ID: ${r.id}\nType: ${r.type}\nAge: ${age(r)}\n\n`;
  if (r.type === "search")
    info += `Queries:\n${r.queries
      .slice(0, 10)
      .map((q) => `- "${q.query}" (${plural(q.results.length, "result")})`)
      .join("\n")}`;
  if (r.type === "fetch")
    info += `URLs:\n${r.urls
      .slice(0, 10)
      .map((u) => `- ${u.url} (${u.error || `${u.content.length} chars`})`)
      .join("\n")}`;
  if (r.type === "research") info += `Claim: ${r.artifact.claim}\nSources: ${r.artifact.sources.length}`;
  return info;
}

/**
 * Pi's pi-web-access: web search over SearXNG, OpenAI, Exa (keyless through its MCP endpoint), Brave, Tavily and
 * Perplexity with fallbacks; page, image and GitHub fetching with answer and field-extraction modes run through
 * `ctx.complete`; results stored as session entries for `get_search_content`; content fetched in the background
 * announced with `ctx.send`; source checks; `/search`, `/curator` and `/web-activity`.
 */
export default {
  tools: [webSearch, sourceCheck, fetchContent, getSearchContent, webEnable],
  entries,
  on: {
    run_start: async (p, ctx) => {
      const config = await loadConfig(ctx);
      const mine = (t: Tool) => t.plugin === ctx.plugin;
      const off = new Set(NAMES.filter((n) => config.tools?.[n]?.enabled === false));
      p.tools = p.tools
        .filter((t) => !(mine(t) && off.has(t.name as (typeof NAMES)[number])))
        .map((t) =>
          mine(t) && t.name !== "web_enable" && config.toolExposure === "deferred"
            ? { ...t, exposure: "codemode" as const }
            : t,
        );
      const dynamic = config.toolActivation === "dynamic" && config.toolExposure !== "deferred";
      if (!dynamic || (ctx.session && dataOf(ctx.session.getState(), ctx.plugin).enabled)) {
        p.tools = p.tools.filter((t) => !(mine(t) && t.name === "web_enable"));
        return;
      }
      const web = p.tools.filter((t) => mine(t) && t.name !== "web_enable");
      if (ctx.run) st(ctx).stash.set(ctx.run.id, web);
      p.tools = p.tools.filter((t) => !web.includes(t));
    },
    run_end: (_, ctx) => {
      if (ctx.run) st(ctx).stash.delete(ctx.run.id);
    },
    session_closed: ({ session }, ctx) => {
      for (const [id, f] of st(ctx).pending)
        if (f.session === session) {
          f.controller.abort();
          st(ctx).pending.delete(id);
        }
    },
    close: (_, ctx) => {
      for (const f of st(ctx).pending.values()) f.controller.abort();
      st(ctx).pending.clear();
    },
  },
  commands: [
    {
      name: "search",
      description: "Browse stored web search results",
      async run(_, ctx) {
        const all = Object.values(stored(ctx)).reverse();
        if (!all.length) return "No stored search results";
        const choice = await ctx.ask({
          question: "Stored Search Results",
          options: all.map((r) => ({ label: label(r) })),
        });
        const picked = typeof choice === "string" ? all.find((r) => label(r) === choice) : undefined;
        if (!picked) return all.map(label).join("\n");
        const action = await ctx.ask({
          question: `Result ${picked.id.slice(0, 6)}`,
          options: [{ label: "View details" }, { label: "Delete" }],
        });
        if (action === "Delete") {
          await ctx.session?.appendEntry(`${ctx.plugin}:deleted`, { id: picked.id });
          return `Deleted ${picked.id.slice(0, 6)}`;
        }
        return action === "View details" ? describe(picked) : undefined;
      },
    },
    {
      name: "curator",
      args: "[on|off|none|auto-summary]",
      description: "Toggle or configure the search summary workflow",
      complete: () => ["on", "off", "none", "auto-summary"].map((value) => ({ value })),
      async run(arg, ctx) {
        const a = arg.trim().toLowerCase();
        const current = (await loadConfig(ctx)).workflow ?? "none";
        // Pi's "on" opens its browser curator (summary-review); here it is the auto summary
        const workflow: Workflow | undefined =
          a === ""
            ? current === "none"
              ? "auto-summary"
              : "none"
            : a === "off" || a === "none"
              ? "none"
              : a === "on" || a === "auto-summary" || a === "summary-review"
                ? "auto-summary"
                : undefined;
        if (!workflow) throw new Error(`Unknown option: ${a}. Use on, off, none, or auto-summary.`);
        await saveConfig(ctx, { workflow });
        const text =
          workflow === "none"
            ? "Curator disabled — web_search will return raw results"
            : "Auto-summary enabled — web_search will generate a summary of its results";
        await ctx.send(
          { content: text, meta: { plugin: ctx.plugin, type: "curator-config", display: true, details: { workflow } } },
          { deliver: "context" },
        );
      },
    },
    {
      name: "web-activity",
      description: "Toggle the web request activity in the status bar",
      run(_, ctx) {
        const a = activityOf(ctx);
        a.visible = !a.visible;
        showActivity(ctx);
        return `Web activity ${a.visible ? "shown" : "hidden"}`;
      },
    },
  ],
  cli: { tools: Object.fromEntries(Object.keys(TITLES).map((name) => [name, renderer])) },
} satisfies CliPlugin;
