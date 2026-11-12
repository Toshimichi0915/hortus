import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type AskEvent, type AssistantMessage, createAgent, loadSecrets, openSession } from "@hortus/core";
import { record, tempHome } from "@hortus/core/testing";

const dir = fileURLToPath(new URL("..", import.meta.url));

interface Sent {
  method: string;
  url: string;
  auth: string | null;
  team: string | null;
  tag: string | null;
  session: string | null;
  body?: string;
}

/** A fetch (for `LoadOptions.fetch`) answering with `answer`, recording every request in `sent`. */
function stubFetch(answer: (s: Sent) => Response) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const h = new Headers(init?.headers);
    const s = {
      method: init?.method ?? "GET",
      url: String(url),
      auth: h.get("authorization"),
      team: h.get("x-team"),
      tag: h.get("x-tag"),
      session: h.get("x-litellm-session-id"),
      body: init?.body?.toString(),
    };
    sent.push(s);
    return answer(s);
  };
  return { fetch, sent };
}

const anthropicSse = (...events: object[]) =>
  new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

const chatSse = (headers: Record<string, string>, ...chunks: object[]) =>
  new Response([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(""), {
    headers: { "content-type": "text/event-stream", ...headers },
  });

const deployments = [
  {
    model_name: "claude",
    litellm_params: { model: "anthropic/claude-sonnet-4-6" },
    model_info: {
      mode: "chat",
      litellm_provider: "anthropic",
      max_input_tokens: 200000,
      max_output_tokens: 32000,
      supports_vision: true,
      supports_reasoning: true,
      supports_xhigh_reasoning_effort: true,
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
      cache_read_input_token_cost: 0.3e-6,
    },
  },
  {
    model_name: "gpt",
    litellm_params: { model: "openai/gpt-5" },
    model_info: { mode: "responses", litellm_provider: "openai", reasoning_effort_levels: ["none", "low", "high"] },
  },
  { model_name: "llama", model_info: { mode: "chat", supports_reasoning: false, max_input_tokens: 8192 } },
  { model_name: "embed", model_info: { mode: "embedding" } },
  { model_name: "openai/*", model_info: {} },
];

test("routes each proxy model through hortus's own providers with /model/info's limits, efforts and prices", async (t) => {
  process.env.LITELLM_TEST_KEY = "sk-test";
  process.env.LITELLM_TEST_TEAM = "blue";
  t.after(
    await tempHome({
      config: { provider: "proxy", model: "claude" },
      secrets: {
        proxy: {
          type: "litellm",
          endpoint: "http://127.0.0.1:4000/v1/",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: secrets.json's ${VAR} syntax
          apiKey: "${LITELLM_TEST_KEY}",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: secrets.json's ${VAR} syntax
          headers: { "x-team": "${LITELLM_TEST_TEAM}" },
        },
      },
      plugins: {
        litellm: dir,
        // another plugin's wrap of anthropic applies to Claude routed through the proxy too
        tag: {
          "hortus.json": JSON.stringify({ name: "tag", version: "0.1.0", entrypoint: "index.js" }),
          "index.js": `export default { providers: { anthropic: { wrap: (D) => ({ ...D,
            create: (e, o) => D.create(e, { ...o, headers: { ...o.headers, "x-tag": "wrapped" } }) }) } } };`,
        },
      },
    }),
  );
  const { fetch, sent } = stubFetch(({ method, url }) => {
    if (url === "http://127.0.0.1:4000/model/info") return Response.json({ data: deployments });
    if (method === "POST" && url === "http://127.0.0.1:4000/v1/messages") {
      const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 500 };
      return anthropicSse(
        {
          type: "message_start",
          message: {
            id: "m",
            type: "message",
            role: "assistant",
            model: "claude",
            content: [],
            stop_reason: null,
            usage,
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "from claude" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
        { type: "message_stop" },
      );
    }
    if (method === "POST" && url === "http://127.0.0.1:4000/v1/chat/completions") {
      const chunk = { id: "c", object: "chat.completion.chunk", created: 0, model: "llama" };
      return chatSse(
        { "x-litellm-response-cost": "0.25" },
        { ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "from llama" }, finish_reason: null }] },
        { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { ...chunk, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      );
    }
    return new Response("not stubbed", { status: 500 });
  });
  const events = record();
  const agent = await createAgent({ extra: [{ name: "record", plugin: events }], fetch });

  assert.deepEqual(
    (await agent.listModels()).map((m) => `${m.provider}/${m.id}`),
    ["proxy/claude", "proxy/gpt", "proxy/llama"],
  );
  const { provider } = await agent.resolve();
  assert.deepEqual(await provider.info?.("claude"), {
    contextWindow: 200000,
    maxOutput: 32000,
    efforts: ["low", "medium", "high", "xhigh"],
    images: true,
  });
  assert.deepEqual((await provider.info?.("gpt"))?.efforts, ["off", "low", "high"]);
  assert.deepEqual((await provider.info?.("llama"))?.efforts, []);

  const session = await openSession(null);
  await agent.run("hi", { session });
  await agent.run("hi", { model: "llama", session });
  const replies = events.events.flatMap((e) =>
    e.name === "message" && (e.payload as AssistantMessage).role === "assistant" ? [e.payload as AssistantMessage] : [],
  );
  assert.deepEqual(
    replies.map((r) => r.text),
    ["from claude", "from llama"],
  );
  // 1000 uncached input + 500 cached (listed prices), then what the proxy says it charged
  const expected = 1000 * 3e-6 + 100 * 15e-6 + 500 * 0.3e-6;
  assert.ok(Math.abs((replies[0]?.usage?.cost ?? 0) - expected) < 1e-12, String(replies[0]?.usage?.cost));
  assert.equal(replies[1]?.usage?.cost, 0.25);

  const messages = sent.find((s) => s.url.endsWith("/v1/messages"));
  assert.equal(JSON.parse(messages?.body ?? "{}").max_tokens, 32000, "max_tokens from /model/info");
  assert.equal(messages?.tag, "wrapped");
  // every model call carries the session (from the provider's ctx), whichever protocol it went through
  const calls = sent.filter((s) => s.method === "POST");
  assert.equal(calls.length, 2);
  for (const s of calls) assert.equal(s.session, session.id, s.url);
  assert.ok(!sent.some((s) => s.url.includes("/v1/models/")), "maxTokens came with the request: no model lookup");
  for (const s of sent) assert.deepEqual([s.auth, s.team], ["Bearer sk-test", "blue"], s.url);
});

test("falls back to /v1/models and refreshes an expired SSO login, saving the rotated token", async (t) => {
  const sso = {
    type: "litellm",
    endpoint: "http://localhost:4000",
    refreshToken: "r1",
    tokenEndpoint: "http://localhost:4000/v1/token",
    clientId: "hortus",
    expires: 0,
  };
  t.after(await tempHome({ config: {}, secrets: { proxy: sso }, plugins: { litellm: dir } }));
  const { fetch, sent } = stubFetch(({ url }) => {
    if (url === sso.tokenEndpoint) return Response.json({ access_token: "a2", refresh_token: "r2", expires_in: 3600 });
    if (url.endsWith("/model/info")) return new Response("admin only", { status: 403 });
    if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: "m1" }, { id: "m2" }] });
    return new Response("not stubbed", { status: 500 });
  });
  const agent = await createAgent({ fetch });
  assert.deepEqual(
    (await agent.listModels()).map((m) => m.id),
    ["m1", "m2"],
  );
  assert.deepEqual(
    sent.filter((s) => s.url === sso.tokenEndpoint).map((s) => s.body),
    ["grant_type=refresh_token&refresh_token=r1&client_id=hortus"],
  );
  assert.equal(sent.find((s) => s.url.endsWith("/v1/models"))?.auth, "Bearer a2");
  const saved = (await loadSecrets()).proxy;
  assert.deepEqual({ ...saved, expires: 0 }, { ...sso, apiKey: "a2", refreshToken: "r2" });
  assert.ok((saved?.expires as number) > Date.now());

  // a token endpoint off the proxy's origin never gets the refresh token
  const def = agent.providers.litellm;
  await assert.rejects(
    def?.auth?.({ ...sso, tokenEndpoint: "https://evil.test/token" }, { refresh: true, fetch }) ?? Promise.resolve(),
    /origin/,
  );
  assert.throws(() => def?.create({ type: "litellm", endpoint: "http://proxy.test" }, { name: "x" }), /HTTPS/);
});

test("a keyless proxy gets no authorization header", async (t) => {
  t.after(
    await tempHome({
      config: { provider: "proxy", model: "llama" },
      secrets: { proxy: { type: "litellm", endpoint: "http://127.0.0.1:4000" } },
      plugins: { litellm: dir },
    }),
  );
  const { fetch, sent } = stubFetch(({ url }) => {
    if (url.endsWith("/model/info")) return Response.json({ data: deployments });
    const chunk = { id: "c", object: "chat.completion.chunk", created: 0, model: "llama" };
    return chatSse(
      {},
      { ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: "stop" }] },
    );
  });
  const agent = await createAgent({ fetch });
  await agent.run("hi");
  assert.ok(sent.some((s) => s.url.endsWith("/v1/chat/completions")));
  for (const s of sent) assert.equal(s.auth, null, s.url);
});

test("/litellm:login asks for the proxy URL and a masked key, checks them, and saves the entry", async (t) => {
  t.after(
    await tempHome({
      config: {},
      secrets: { old: { type: "litellm", endpoint: "https://known.test" } },
      plugins: { litellm: dir },
    }),
  );
  const asks: AskEvent[] = [];
  const answers = ["https://proxy.test/v1", "sk-new"];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const ok =
      String(url) === "https://proxy.test/v1/models" &&
      new Headers(init?.headers).get("authorization") === "Bearer sk-new";
    return ok ? Response.json({ data: [] }) : new Response("no", { status: 401 });
  };
  const agent = await createAgent({
    fetch,
    extra: [
      {
        name: "user",
        plugin: {
          on: {
            ask: (p) => {
              asks.push(p);
              p.resolve(answers.shift());
            },
          },
        },
      },
    ],
  });
  const login = agent.commands().find((c) => c.name === "litellm:login");
  assert.match(String(await login?.run("work")), /^Logged in to https:\/\/proxy\.test as secrets\.json entry "work"/);
  assert.deepEqual(
    asks.map((a) => [a.question, a.options?.map((o) => o.label), a.secret ?? false]),
    [
      ["LiteLLM proxy URL", ["https://known.test"], false],
      ["API key for https://proxy.test", undefined, true],
    ],
  );
  assert.deepEqual((await loadSecrets()).work, { type: "litellm", endpoint: "https://proxy.test", apiKey: "sk-new" });
  // a rejected key saves nothing; no one to answer cancels
  answers.push("https://proxy.test", "sk-bad");
  await assert.rejects(login?.run("bad") ?? Promise.resolve(), /rejected the key \(HTTP 401\)/);
  assert.equal((await loadSecrets()).bad, undefined);
  await assert.rejects(login?.run("none") ?? Promise.resolve(), /Login cancelled/);
});
