import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompleteCallbacks, Message, ResponseMeta } from "../llm.ts";
import anthropic from "../builtin/anthropic.ts";
import { anthropicProvider } from "./anthropic.ts";

test("anthropicProvider drops an empty assistant turn, even a replayed one, which the API rejects, merging the user turns around it", async () => {
  let body: { messages: unknown[] } | undefined;
  const provider = anthropicProvider({
    apiKey: "k",
    baseURL: "http://test",
    maxRetries: 0,
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      throw new Error("sent");
    },
  });
  const messages: Message[] = [
    { role: "user", content: "a" },
    // an empty end_turn reply, replayed as is
    { role: "assistant", text: "", toolCalls: [], raw: { provider: "anthropic http://test m", content: [] } },
    { role: "user", content: "b" },
    { role: "assistant", text: "", toolCalls: [] },
    { role: "user", content: "c" },
  ];
  await assert.rejects(provider.complete({ model: "m", system: "", messages, tools: [] }));
  assert.deepEqual(body?.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
        { type: "text", text: "c" },
      ],
    },
  ]);
});

test("a user message after tool results (context-mode's <active_memory>) joins their turn, after them", async () => {
  let body: { messages: unknown[] } | undefined;
  const provider = anthropicProvider({
    apiKey: "k",
    baseURL: "http://test",
    maxRetries: 0,
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      throw new Error("sent");
    },
  });
  const messages: Message[] = [
    { role: "user", content: "a" },
    { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "t", input: {} }] },
    { role: "tool", results: [{ id: "c1", output: "out" }] },
    { role: "user", content: "<active_memory>m</active_memory>" },
  ];
  await assert.rejects(provider.complete({ model: "m", system: "", messages, tools: [] }));
  assert.deepEqual(body?.messages.slice(2), [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: "out" },
        { type: "text", text: "<active_memory>m</active_memory>" },
      ],
    },
  ]);
});

test("anthropicProvider reports cache reads and writes, both inside input", async () => {
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 300 };
  const sse = [
    event("message_start", {
      message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage },
    }),
    event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
    event("message_stop", {}),
  ].join("");
  const provider = anthropicProvider({
    apiKey: "k",
    baseURL: "http://test",
    maxRetries: 0,
    fetch: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
  });
  const reply = await provider.complete({
    model: "m",
    system: "",
    messages: [{ role: "user", content: "a" }],
    tools: [],
  });
  assert.deepEqual(reply.usage, { input: 321, output: 5, cacheRead: 20, cacheWrite: 300 });
});

test("the built-in anthropic def passes create's headers and fetch to the SDK", async () => {
  const seen: { url: string; header: string | null }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), header: new Headers(init?.headers).get("x-test") });
    return new Response("{}", { status: 400 });
  };
  const def = anthropic.plugin.providers.anthropic;
  const provider = def.create(
    { type: "anthropic", apiKey: "k", endpoint: "http://test" },
    { name: "a", headers: { "x-test": "yes" }, fetch },
  );
  await assert.rejects(provider.complete({ model: "m", system: "", messages: [], tools: [] }));
  assert.ok(seen.some((s) => s.url.endsWith("/v1/messages")));
  assert.ok(seen.every((s) => s.header === "yes"));
});

test("req.maxTokens, else info(model).maxOutput, sets max_tokens; info reports the window, efforts and images", async () => {
  let body: { max_tokens?: number } | undefined;
  const model = {
    type: "model",
    id: "m",
    display_name: "M",
    created_at: "2026-01-01T00:00:00Z",
    max_input_tokens: 1000,
    max_tokens: 1234,
    capabilities: null,
  };
  const provider = anthropicProvider({
    apiKey: "k",
    baseURL: "http://test",
    maxRetries: 0,
    fetch: async (url, init) => {
      if (String(url).includes("/v1/models/")) return Response.json(model);
      body = JSON.parse(String(init?.body));
      throw new Error("sent");
    },
  });
  await assert.rejects(provider.complete({ model: "m", system: "", messages: [], tools: [] }));
  assert.equal(body?.max_tokens, 1234);
  const req = { model: "m", system: "", messages: [], tools: [], maxTokens: 99 };
  await assert.rejects(provider.complete(req));
  assert.equal(body?.max_tokens, 99);
  assert.deepEqual(await provider.info?.("m"), {
    contextWindow: 1000,
    maxOutput: 1234,
    efforts: undefined,
    images: undefined,
  });
});

test("a failed model lookup reads as no info and isn't retried on the next turn", async () => {
  let lookups = 0;
  let body: { max_tokens?: number } | undefined;
  const provider = anthropicProvider({
    apiKey: "k",
    baseURL: "http://test",
    maxRetries: 0,
    fetch: async (url, init) => {
      if (String(url).includes("/v1/models/")) {
        lookups++;
        return new Response("{}", { status: 404 });
      }
      body = JSON.parse(String(init?.body));
      throw new Error("sent");
    },
  });
  for (let i = 0; i < 2; i++)
    await assert.rejects(provider.complete({ model: "m", system: "", messages: [], tools: [] }));
  assert.equal(body?.max_tokens, 64000);
  assert.deepEqual(await provider.info?.("m"), {});
  assert.equal(lookups, 1);
});

test("anthropic raw (thinking blocks) is replayed only to the endpoint and model that wrote it", async () => {
  const content = [
    { type: "thinking", thinking: "hmm", signature: "sig" },
    { type: "text", text: "hi" },
  ];
  const assistant = (endpoint: string): Message => ({
    role: "assistant",
    text: "hi",
    toolCalls: [],
    raw: { provider: `anthropic ${endpoint} m`, content },
  });
  const sent = async (endpoint: string, messages: Message[]) => {
    let body: { messages: { content: unknown }[] } | undefined;
    const provider = anthropicProvider({
      apiKey: "k",
      baseURL: endpoint,
      maxRetries: 0,
      fetch: async (url, init) => {
        if (String(url).includes("/v1/models/")) return new Response("{}", { status: 404 });
        body = JSON.parse(String(init?.body));
        throw new Error("sent");
      },
    });
    await assert.rejects(provider.complete({ model: "m", system: "", messages, tools: [] }));
    return body?.messages[1]?.content;
  };
  const history = (endpoint: string): Message[] => [
    { role: "user", content: "a" },
    assistant(endpoint),
    { role: "user", content: "b" },
  ];
  assert.deepEqual(await sent("http://proxy", history("http://proxy")), content);
  assert.deepEqual(await sent("http://direct", history("http://proxy")), [{ type: "text", text: "hi" }]);
});

test("the built-in anthropic def works without a key and never takes a base URL from the environment", async (t) => {
  const saved = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = "http://env.invalid";
  t.after(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved;
  });
  const sent: string[][] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const h = new Headers(init?.headers);
    sent.push([String(url), `${h.get("authorization")}`, `${h.get("x-api-key")}`]);
    return Response.json({ data: [], has_more: false });
  };
  const create = (entry: { apiKey?: string; endpoint?: string }) =>
    anthropic.plugin.providers.anthropic.create({ type: "anthropic", ...entry }, { name: "a", fetch });
  // keyless (a local proxy), not the SDK's credential chain
  await create({ endpoint: "http://localhost:4000" }).listModels();
  await create({ apiKey: "k" }).listModels();
  assert.deepEqual(sent, [
    ["http://localhost:4000/v1/models", "null", "null"],
    ["https://api.anthropic.com/v1/models", "Bearer k", "null"],
  ]);
});

test("anthropicProvider reports its payload, response meta and streamed tool input, and sends every image", async () => {
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const usage = { input_tokens: 1, output_tokens: 1 };
  const reply = (stop: string, ...blocks: string[]) =>
    [
      event("message_start", {
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "m-1",
          content: [],
          stop_reason: null,
          usage,
        },
      }),
      ...blocks,
      event("message_delta", { delta: { stop_reason: stop }, usage }),
      event("message_stop", {}),
    ].join("");
  const toolUse = [
    event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "t1", name: "echo", input: {} } }),
    event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"text":' } }),
    event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '"hi"}' } }),
    event("content_block_stop", { index: 0 }),
  ];
  const bodies: { messages: { content: unknown }[] }[] = [];
  let sse = reply("tool_use", ...toolUse);
  const provider = anthropicProvider({
    apiKey: "k",
    baseURL: "http://test",
    maxRetries: 0,
    fetch: async (_, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(sse, { headers: { "content-type": "text/event-stream", "x-cost": "0.5" } });
    },
  });
  const deltas: string[] = [];
  const reported: { payload?: unknown; meta?: ResponseMeta } = {};
  const callbacks: CompleteCallbacks = {
    toolInput: (d) => deltas.push(`${d.id} ${d.name} ${d.partial}`),
    payload: (p) => {
      reported.payload = p;
    },
    meta: (m) => {
      reported.meta = { ...reported.meta, ...m };
    },
  };
  const req = { model: "m", system: "", messages: [{ role: "user" as const, content: "a" }], tools: [] };
  const msg = await provider.complete(req, callbacks);
  assert.deepEqual(deltas, ['t1 echo {"text":', 't1 echo "hi"}']);
  assert.deepEqual(JSON.parse(deltas.map((d) => d.split(" ").slice(2).join(" ")).join("")), msg.toolCalls[0]?.input);
  assert.equal((reported.payload as { model: string }).model, "m");
  assert.deepEqual(
    { ...reported.meta, headers: reported.meta?.headers?.["x-cost"] },
    { stopReason: "tool_use", responseId: "msg_1", model: "m-1", status: 200, headers: "0.5" },
  );
  for (const [stop, expected] of [
    ["end_turn", "end"],
    ["max_tokens", "max_tokens"],
  ]) {
    sse = reply(stop as string);
    await provider.complete(req, callbacks);
    assert.equal(reported.meta?.stopReason, expected);
  }
  const image = (data: string) => ({ type: "image" as const, mediaType: "image/png" as const, data });
  await provider.complete({
    ...req,
    messages: [
      ...req.messages,
      { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "echo", input: {} }] },
      { role: "tool", results: [{ id: "t1", output: "two", images: [image("AA=="), image("BB==")] }] },
    ],
  });
  const result = (bodies.at(-1)?.messages.at(-1)?.content as { content: { type: string }[] }[] | undefined)?.[0];
  assert.deepEqual(
    result?.content.map((c) => c.type),
    ["text", "image", "image"],
  );
});

test("a user message's images are sent before its text; its entryId and meta never are", async () => {
  const bodies: string[] = [];
  const provider = anthropicProvider({
    apiKey: "k",
    baseURL: "http://test",
    maxRetries: 0,
    fetch: async (_, init) => {
      bodies.push(String(init?.body));
      return new Response("{}", { status: 400 });
    },
  });
  const image = { type: "image" as const, mediaType: "image/png" as const, data: "AA==" };
  const messages: Message[] = [
    { role: "user", content: "look", images: [image], entryId: "e1" },
    { role: "user", content: "a note", meta: { plugin: "p", type: "note" }, entryId: "e2" },
  ];
  await assert.rejects(provider.complete({ model: "m", system: "", messages, tools: [], maxTokens: 1 }));
  const body = JSON.parse(bodies[0] ?? "{}");
  assert.deepEqual(
    body.messages.map((m: { content: unknown }) => m.content),
    [
      [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
        { type: "text", text: "look" },
        { type: "text", text: "a note" },
      ],
    ],
  );
  assert.doesNotMatch(bodies[0] ?? "", /entryId|meta|e1/);
});
