import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "@hortus/cli";
import { createCli } from "@hortus/cli/testing";
import { type AskEvent, type CompletionRequest, createAgent, loadSecrets, openSession } from "@hortus/core";
import { scripted, tempHome } from "@hortus/core/testing";

const dir = fileURLToPath(new URL("..", import.meta.url));
const scriptedSecret = { type: "scripted", apiKey: "scripted" };

interface Sent {
  url: string;
  headers: Headers;
  body?: unknown;
}

/** A fetch (for `LoadOptions.fetch`) answering with `answer`, recording every request in `sent`. */
function stubFetch(answer: (s: Sent) => Response) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const s = {
      url: String(url),
      headers: new Headers(init?.headers),
      body: init?.body && JSON.parse(String(init.body)),
    };
    sent.push(s);
    return answer(s);
  };
  return { fetch, sent };
}

/** The output of the last tool result in `req`. */
const lastOutput = (req: CompletionRequest) => {
  const m = req.messages.at(-1);
  return m?.role === "tool" ? (m.results[0]?.output ?? "") : "";
};

test("web searches with fallback and fan-out, and reads with continuation, keys from secrets.json", async (t) => {
  process.env.WEB_TEST_EXA_KEY = "exa-key";
  t.after(() => delete process.env.WEB_TEST_EXA_KEY);
  t.after(
    await tempHome({
      secrets: {
        scripted: scriptedSecret,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a secrets.json ${VAR}, not a template
        exa: { type: "exa", apiKey: "${WEB_TEST_EXA_KEY}" },
        brave: { type: "brave", apiKey: "brave-key" },
        searx: { type: "searxng", endpoint: "http://searx.test" },
      },
      plugins: { web: dir },
    }),
  );
  const { fetch, sent } = stubFetch(({ url }) => {
    if (url.startsWith("https://api.exa.ai/")) return new Response("slow down", { status: 429 });
    if (url.startsWith("https://api.search.brave.com/"))
      return Response.json({
        web: {
          results: [{ url: "https://github.com/microsoft/typescript/", title: "TypeScript", description: "a &amp; b" }],
        },
      });
    if (url.startsWith("http://searx.test/"))
      return Response.json({
        results: [
          { url: "https://github.com/microsoft/typescript?utm_source=x", title: "TypeScript", content: "c" },
          { url: "https://devblogs.microsoft.com/typescript", title: "Blog", content: "d" },
        ],
      });
    if (url === `https://r.jina.ai/${encodeURIComponent("https://example.com")}`)
      return Response.json({
        code: 200,
        data: { url: "https://example.com/", title: "Example", content: "Hello, world!" },
      });
    throw new Error(`unexpected request ${url}`);
  });
  const provider = scripted([
    { toolCalls: [{ id: "1", name: "web_search", input: { query: "typescript 7", includeDomains: ["github.com"] } }] },
    { toolCalls: [{ id: "2", name: "web_search", input: { query: "typescript 7", provider: "all" } }] },
    { toolCalls: [{ id: "3", name: "web_read", input: { url: "https://example.com", maxChars: 5 } }] },
    (req) => {
      const continuation = lastOutput(req).match(/continuation=(\S+)\]/)?.[1];
      return { toolCalls: [{ id: "4", name: "web_read", input: { url: "https://example.com", continuation } }] };
    },
    { text: "done" },
  ]);
  const agent = await createAgent({
    provided: { "@hortus/cli": version },
    fetch,
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }],
  });
  await agent.run("what's new in typescript 7?");

  assert.match(provider.requests[0]?.system ?? "", /Search the web with web_search/);
  // ${VAR} expanded in the key; exa is rate limited, so auto moves on to brave, which can't filter by domain
  assert.equal(sent.find((s) => s.url.startsWith("https://api.exa.ai/"))?.headers.get("x-api-key"), "exa-key");
  assert.equal(sent.find((s) => s.url.includes("brave"))?.headers.get("x-subscription-token"), "brave-key");
  const auto = lastOutput(provider.requests[1] as CompletionRequest);
  assert.match(auto, /^\[provider=brave\] 1 result\(s\) for "typescript 7" \[brave ignored=includeDomains\]/);
  assert.match(auto, /Snippet: a & b/);
  assert.match(auto, /Provider errors:\n {2}exa: HTTP 429/);
  // all: exa's failure reported, brave's and searxng's hits deduplicated across the utm_ parameter and trailing slash
  const all = lastOutput(provider.requests[2] as CompletionRequest);
  assert.match(all, /^\[provider=all\] 2 result\(s\)/);
  assert.match(all, /Providers: brave, searxng/);
  assert.match(all, /exa: HTTP 429/);
  // jina reads without a key; the rest comes through the continuation
  const first = lastOutput(provider.requests[3] as CompletionRequest);
  assert.equal(sent.find((s) => s.url.startsWith("https://r.jina.ai/"))?.headers.get("authorization"), null);
  assert.match(
    first,
    /^\[provider=jina\] read https:\/\/example.com\n\nExample\n {3}https:\/\/example.com\/\n\nHello\n\n\[truncated; /,
  );
  const rest = lastOutput(provider.requests[4] as CompletionRequest);
  assert.match(rest, /\n\n, world!$/);
});

test("Codex search uses an openai-codex login, refreshed by the plugin that owns it when rejected", async (t) => {
  const login = { type: "openai-codex", accessToken: "old", refreshToken: "r", accountId: "acct" };
  t.after(
    await tempHome({
      secrets: { scripted: scriptedSecret, chatgpt: login },
      plugins: {
        web: dir,
        // the login's owner: an LLM provider plugin (here only its `auth`), not the web plugin
        "codex-login": {
          "hortus.json": JSON.stringify({ name: "codex-login", version: "0.1.0", entrypoint: "index.js" }),
          "index.js": `export default { providers: { "openai-codex": {
            create() { throw new Error("not in this test"); },
            auth: async (e, { refresh }) => (refresh ? { ...e, accessToken: "new" } : e),
          } } };`,
        },
      },
    }),
  );
  const sse = (...events: object[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
  const { fetch, sent } = stubFetch(({ url, headers }) => {
    assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
    if (headers.get("authorization") !== "Bearer new") return new Response("token expired", { status: 401 });
    const source = { url: "https://nodejs.org/en/blog", title: "Node.js Blog" };
    return sse(
      { type: "response.output_item.done", item: { type: "web_search_call", action: { sources: [source] } } },
      { type: "response.completed", response: { model: "gpt-5.5", status: "completed", output: [] } },
    );
  });
  const provider = scripted([
    { toolCalls: [{ id: "1", name: "web_search", input: { query: "node 26", provider: "openai-codex" } }] },
    { text: "done" },
  ]);
  const agent = await createAgent({
    provided: { "@hortus/cli": version },
    fetch,
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }],
  });
  await agent.run("node 26?");

  assert.deepEqual(
    sent.map((s) => [s.headers.get("authorization"), s.headers.get("chatgpt-account-id")]),
    [
      ["Bearer old", "acct"],
      ["Bearer new", "acct"],
    ],
  );
  assert.deepEqual((sent[0]?.body as { tools: unknown } | undefined)?.tools, [
    { type: "web_search", search_context_size: "high" },
  ]);
  assert.match(
    lastOutput(provider.requests[1] as CompletionRequest),
    /1\. Node\.js Blog\n {3}https:\/\/nodejs\.org\/en\/blog/,
  );
  // refreshed through the owner's auth and saved, as ctx.secrets.get would
  assert.deepEqual((await loadSecrets()).chatgpt, { ...login, accessToken: "new" });
});

test("aborting the run aborts a search in flight (ctx.signal)", async (t) => {
  t.after(
    await tempHome({
      secrets: { scripted: scriptedSecret, brave: { type: "brave", apiKey: "k" } },
      plugins: { web: dir },
    }),
  );
  const abort = new AbortController();
  let seen: AbortSignal | undefined;
  // a request that only ends when its signal aborts, and aborts the run once it has started
  const fetch: typeof globalThis.fetch = (_, init) =>
    new Promise((_, reject) => {
      seen = init?.signal ?? undefined;
      seen?.addEventListener("abort", () => reject(seen?.reason));
      abort.abort();
    });
  const provider = scripted([{ toolCalls: [{ id: "1", name: "web_search", input: { query: "x" } }] }]);
  const agent = await createAgent({
    provided: { "@hortus/cli": version },
    fetch,
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }],
  });
  const end = await agent.run("x", { signal: abort.signal });
  assert.equal(seen?.aborted, true);
  assert.deepEqual(end?.aborted, { by: "user" });
  const results = end?.messages.at(-1);
  assert.equal(results?.role === "tool" && results.results[0]?.isError, true);
});

test("/web in the TUI asks which hit to put into the prompt; elsewhere it lists them", async (t) => {
  t.after(
    await tempHome({
      secrets: { scripted: scriptedSecret, brave: { type: "brave", apiKey: "k" } },
      plugins: { web: dir },
    }),
  );
  const { fetch } = stubFetch(() =>
    Response.json({
      web: {
        results: [
          { url: "https://a.test/", title: "A" },
          { url: "https://b.test/", title: "B" },
        ],
      },
    }),
  );
  const asked: string[][] = [];
  const pick = {
    name: "pick",
    plugin: {
      on: {
        ask: (p: AskEvent) => {
          asked.push(p.options?.map((o) => `${o.label} ${o.description}`) ?? []);
          p.resolve("https://b.test/");
        },
      },
    },
  };
  const agent = await createAgent({ fetch, provided: { "@hortus/cli": version }, extra: [pick] });
  assert.match(
    String(
      await agent
        .commands()
        .find((c) => c.name === "web")
        ?.run("q"),
    ),
    /2 result\(s\) for "q"/,
  );
  assert.deepEqual(asked, []);
  const cli = await createCli(await openSession(null), (o) =>
    createAgent({ ...o, fetch, provided: { "@hortus/cli": version }, extra: [pick, ...(o.extra ?? [])] }),
  );
  assert.equal(cli.submit("/web q"), true);
  for (let i = 0; i < 100 && cli.ui.getState().input === ""; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(asked, [["https://a.test/ A", "https://b.test/ B"]]);
  assert.equal(cli.ui.getState().input, "https://b.test/");
});
