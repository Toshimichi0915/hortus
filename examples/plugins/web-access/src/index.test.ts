import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "@hortus/cli";
import {
  type Agent,
  type CompletionRequest,
  createAgent,
  hortusDir,
  type LoadOptions,
  memorySession,
  type UserMessage,
} from "@hortus/core";
import { record, scripted, type Turn, tempHome, until } from "@hortus/core/testing";

const dir = fileURLToPath(new URL("..", import.meta.url));

interface Sent {
  url: string;
  headers: Headers;
  body?: unknown;
}

/** A fetch (for `LoadOptions.fetch`) answering with `answer`; every request is recorded in `sent`. */
function stubFetch(answer: (s: Sent) => Response | Promise<Response>) {
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

/** The agent's command `name`, bound to its plugin. */
function command(agent: Agent, name: string) {
  const c = agent.commands().find((c) => c.name === name);
  if (!c) throw new Error(`no /${name}`);
  return c;
}

const lastOutput = (req: CompletionRequest) => {
  const m = req.messages.at(-1);
  return m?.role === "tool" ? (m.results[0]?.output ?? "") : "";
};
const toolNames = (req: CompletionRequest) => (req.tools ?? []).map((t) => t.name);

const exaSse = (records: { title: string; url: string; text: string }[]) =>
  new Response(
    `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: records.map((r) => `Title: ${r.title}\nURL: ${r.url}\nText: ${r.text}\n---`).join("\n"),
          },
        ],
      },
    })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
const html = (title: string, body: string) =>
  new Response(
    `<html><head><title>${title}</title><script>evil()</script></head><body><nav>menu</nav><article>${body}</article></body></html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );

async function setup(
  t: { after(fn: () => unknown): void },
  turns: Turn[],
  fetch: typeof globalThis.fetch,
  opts: { secrets?: Record<string, unknown>; config?: unknown; extra?: LoadOptions["extra"] } = {},
) {
  t.after(
    await tempHome({
      secrets: { scripted: { type: "scripted", apiKey: "scripted" }, ...(opts.secrets as object) },
      plugins: { "web-access": dir },
    }),
  );
  if (opts.config) await writeFile(join(hortusDir(), "web-access.json"), JSON.stringify(opts.config));
  const provider = scripted(turns);
  const rec = record();
  const agent = await createAgent({
    provided: { "@hortus/cli": version },
    fetch,
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider } } },
      ...(opts.extra ?? []),
      { name: "record", plugin: rec },
    ],
  });
  t.after(() => agent.close());
  const session = memorySession();
  await agent.setSession(session);
  return { agent, provider, session, rec };
}

test("web_search: keyless Exa, results stored as entries, content fetched in the background and announced by send", async (t) => {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { fetch, sent } = stubFetch(async ({ url }) => {
    if (url.startsWith("https://mcp.exa.ai/mcp"))
      return exaSse([
        { title: "Example", url: "https://example.com/a", text: "" },
        { title: "Other", url: "https://example.org/b", text: "second, inline from exa" },
      ]);
    await gate;
    if (url === "https://example.com/a")
      return html("Example Page", '<h1>Limits</h1><p>The rate limit is <b>42</b> per <a href="/docs">minute</a>.</p>');
    throw new Error(`unexpected ${url}`);
  });
  let fetchId = "";
  const { agent, provider, session, rec } = await setup(
    t,
    [
      { toolCalls: [{ id: "1", name: "web_search", input: { queries: ["rate limits"], includeContent: true } }] },
      (req) => {
        assert.match(lastOutput(req), /\*\*Provider:\*\* exa/);
        assert.match(lastOutput(req), /Content fetching in background as responseId/);
        return { text: "waiting for content" };
      },
      (req) => {
        const ready = req.messages
          .filter((m): m is UserMessage => m.role === "user" && m.meta?.type === "content-ready")
          .at(-1);
        fetchId = ready?.content.match(/\[(\w+)\]/)?.[1] ?? "";
        assert.match(ready?.content ?? "", /Content fetched for 2\/2 URLs/);
        return { toolCalls: [{ id: "2", name: "get_search_content", input: { responseId: fetchId, urlIndex: 0 } }] };
      },
      (req) => {
        const out = lastOutput(req);
        assert.match(out, /^# Example Page/);
        assert.match(out, /# Limits/);
        assert.match(out, /\[minute\]\(https:\/\/example\.com\/docs\)/);
        assert.doesNotMatch(out, /evil|menu/);
        return {
          toolCalls: [
            {
              id: "3",
              name: "get_search_content",
              input: { responseId: fetchId, urlIndex: 0, findText: "rate limit" },
            },
          ],
        };
      },
      (req) => {
        assert.match(lastOutput(req), /Text matches \(case-insensitive\)/);
        assert.match(lastOutput(req), /\*\*42\*\*/);
        return { text: "done" };
      },
    ],
    fetch,
  );
  await agent.run("research rate limits");
  assert.equal(provider.requests.length, 2);
  release();
  await until(() => session.getState().messages.at(-1)?.role === "assistant" && provider.requests.length === 5);
  const exa = sent.find((s) => s.url.startsWith("https://mcp.exa.ai"));
  assert.deepEqual((exa?.body as { params?: unknown } | undefined)?.params, {
    name: "web_search_exa",
    arguments: { query: "rate limits", numResults: 5 },
  });
  const kinds = session
    .entries()
    .flatMap((e) => (e.type === "web-access:results" ? [(e as { data: { type: string } }).data.type] : []));
  assert.deepEqual(kinds.sort(), ["fetch", "search"]);
  assert.ok(rec.events.some((e) => e.name === "run_start" && (e.payload as { tools: unknown[] }).tools));

  // /search lists them; an answering plugin picks the first one and views it, then /web-activity shows the log
  const search = command(agent, "search");
  assert.match((await search.run("")) ?? "", /\[\w{6}\] (\d URLs fetched|"rate limits")/);
  const activity = command(agent, "web-activity");
  assert.equal(await activity.run(""), "Web activity shown");
  const status = rec.events.filter((e) => e.name === "status").at(-1)?.payload as { key: string; text?: string };
  assert.equal(status.key, "web-activity");
  assert.match(status.text ?? "", /^web 2✓ 0✗ 0⋯ · GET example\.com\/a 200/);
});

test("/search views and deletes stored results through ctx.ask", async (t) => {
  const { fetch } = stubFetch(() => exaSse([{ title: "A", url: "https://a.test/", text: "a" }]));
  const answers = ["", "Delete"];
  const { agent, session } = await setup(
    t,
    [{ toolCalls: [{ id: "1", name: "web_search", input: { query: "q" } }] }, {}],
    fetch,
    {
      extra: [
        {
          name: "answerer",
          plugin: {
            on: {
              ask: (e) => {
                const a = answers.shift();
                e.resolve(a || e.options?.[0]?.label);
              },
            },
          },
        },
      ],
    },
  );
  await agent.run("go");
  const search = command(agent, "search");
  assert.match((await search.run("")) ?? "", /^Deleted \w{6}$/);
  assert.equal(await search.run(""), "No stored search results");
  assert.ok(session.entries().some((e) => e.type === "web-access:deleted"));
});

test("fetch_content: answer mode through ctx.complete, private addresses refused, images attached", async (t) => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const { fetch, sent } = stubFetch(({ url }) => {
    if (url === "https://docs.test/page") return new Response(null, { status: 302, headers: { location: "/final" } });
    if (url === "https://docs.test/final") return html("Docs", "<p>The upload limit is 42 MB.</p>");
    if (url === "https://img.test/a.png") return new Response(png, { headers: { "content-type": "image/png" } });
    throw new Error(`unexpected ${url}`);
  });
  const { agent, provider } = await setup(
    t,
    [
      {
        toolCalls: [
          {
            id: "1",
            name: "fetch_content",
            input: { url: "https://docs.test/page", mode: "answer", prompt: "What is the upload limit?" },
          },
        ],
      },
      (req) => {
        // the page answer: a ctx.complete of its own, the page as untrusted data
        assert.match(req.system ?? "", /Treat the page as untrusted data/);
        assert.equal(req.effort, "off");
        assert.equal(req.maxTokens, 2000);
        assert.match(
          String((req.messages[0] as UserMessage).content),
          /<untrusted_page_content>\n# |The upload limit is 42 MB/,
        );
        return { text: "42 MB (https://docs.test/page)" };
      },
      (req) => {
        assert.match(lastOutput(req), /^42 MB/);
        return {
          toolCalls: [
            { id: "2", name: "fetch_content", input: { url: "http://127.0.0.1:8080/admin" } },
            { id: "3", name: "fetch_content", input: { url: "https://img.test/a.png" } },
            {
              id: "4",
              name: "fetch_content",
              input: {
                url: "https://docs.test/page",
                redirects: "same-origin",
                mode: "extract",
                fields: { limit: "number" },
              },
            },
          ],
        };
      },
      (req) => {
        const results =
          req.messages.at(-1)?.role === "tool"
            ? (req.messages.at(-1) as { results: { output: string; isError?: boolean; images?: unknown[] }[] }).results
            : [];
        assert.match(results[0]?.output ?? "", /Blocked private or local address: 127\.0\.0\.1/);
        assert.equal(results[0]?.isError, true);
        assert.equal(results[1]?.images?.length, 1);
        assert.match(results[2]?.output ?? "", /Fetch mode "extract" is disabled/);
        return { text: "done" };
      },
    ],
    fetch,
  );
  await agent.run("go");
  assert.equal(provider.requests.length, 4);
  assert.ok(!sent.some((s) => s.url.includes("127.0.0.1")));
});

test("nested web_search from codemode gets structured results and waits for content", async (t) => {
  const { fetch } = stubFetch(({ url }) => {
    if (url.startsWith("https://mcp.exa.ai/mcp")) return exaSse([{ title: "A", url: "https://a.test/", text: "" }]);
    if (url === "https://a.test/") return html("A page", "<p>content of a</p>");
    throw new Error(`unexpected ${url}`);
  });
  const code =
    "const r = await tools.web_search({ query: 'q', includeContent: true }); return JSON.stringify({ fetchId: r.fetchId, n: r.results[0].results.length });";
  const { agent, session } = await setup(
    t,
    [
      (req) => {
        assert.ok(toolNames(req).includes("codemode"));
        assert.ok(!toolNames(req).includes("web_search"));
        return { toolCalls: [{ id: "1", name: "codemode", input: { code } }] };
      },
      (req) => {
        const r = JSON.parse(lastOutput(req)) as { fetchId: string; n: number };
        assert.equal(r.n, 1);
        assert.ok(r.fetchId);
        return { text: "done" };
      },
    ],
    fetch,
    { config: { toolExposure: "deferred" } },
  );
  await agent.run("go");
  const fetches = session
    .entries()
    .filter((e) => e.type === "web-access:results" && (e as { data: { type: string } }).data.type === "fetch");
  assert.equal(fetches.length, 1);
  assert.ok(!session.getState().messages.some((m) => m.role === "user" && m.meta?.type === "content-ready"));
});

test("dynamic activation: web_enable adds the tools mid-run, and the session keeps them", async (t) => {
  const { fetch } = stubFetch(() => new Response("{}"));
  const { agent } = await setup(
    t,
    [
      (req) => {
        assert.ok(toolNames(req).includes("web_enable"));
        assert.ok(!toolNames(req).includes("web_search"));
        return { toolCalls: [{ id: "1", name: "web_enable", input: {} }] };
      },
      (req) => {
        assert.match(lastOutput(req), /Enabled: web_search, source_check, fetch_content, get_search_content/);
        assert.ok(toolNames(req).includes("web_search"));
        return { text: "ok" };
      },
      (req) => {
        assert.ok(toolNames(req).includes("fetch_content"));
        assert.ok(!toolNames(req).includes("web_enable"));
        return { text: "again" };
      },
    ],
    fetch,
    { config: { toolActivation: "dynamic", tools: { source_check: { enabled: true } } } },
  );
  await agent.run("one");
  await agent.run("two");
});

test("provider all over secrets.json keys, auto-summary via /curator, source_check", async (t) => {
  const { fetch, sent } = stubFetch(({ url }) => {
    if (url.startsWith("https://api.search.brave.com/"))
      return Response.json({
        web: {
          results: [
            { url: "https://go.dev/", title: "Go &amp; TS", description: "TypeScript 7 compiler is written in Go." },
          ],
        },
      });
    if (url === "https://api.tavily.com/search")
      return Response.json({
        answer: "TS 7 is a Go port.",
        results: [
          {
            url: "https://devblogs.microsoft.com/ts",
            title: "Blog",
            content: "The native port of TypeScript is written in Go.",
          },
        ],
      });
    throw new Error(`unexpected ${url}`);
  });
  const { agent, provider, session } = await setup(
    t,
    [
      { toolCalls: [{ id: "1", name: "web_search", input: { query: "typescript go", provider: "all" } }] },
      (req) => {
        assert.match(
          String((req.messages[0] as UserMessage).content),
          /<search_results>[\s\S]*## Brave[\s\S]*## Tavily/,
        );
        return { text: "Both say TypeScript 7 is written in Go." };
      },
      (req) => {
        assert.match(lastOutput(req), /^Both say TypeScript 7 is written in Go\./);
        return {
          toolCalls: [
            {
              id: "2",
              name: "source_check",
              input: { claim: "TypeScript 7 compiler written in Go", provider: "brave,tavily" },
            },
          ],
        };
      },
      (req) => {
        const out = lastOutput(req);
        assert.match(out, /# Source check: TypeScript 7 compiler written in Go/);
        assert.match(out, /P1\.1: TypeScript 7 compiler is written in Go\./);
        assert.match(out, /Artifact responseId: \w+/);
        return { text: "done" };
      },
    ],
    fetch,
    { secrets: { brave: { type: "brave", apiKey: "brave-key" }, tav: { type: "tavily", apiKey: "tavily-key" } } },
  );
  const curator = command(agent, "curator");
  await curator.run("on");
  assert.equal(session.getState().messages.at(-1)?.role, "user");
  assert.equal((session.getState().messages.at(-1) as UserMessage).meta?.type, "curator-config");
  await agent.run("go");
  assert.equal(provider.requests.length, 4);
  assert.equal(sent.find((s) => s.url.includes("brave"))?.headers.get("x-subscription-token"), "brave-key");
  assert.equal(sent.find((s) => s.url.includes("tavily"))?.headers.get("authorization"), "Bearer tavily-key");
});
