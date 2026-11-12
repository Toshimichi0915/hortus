import assert from "node:assert/strict";
import { test } from "node:test";
import { APIUserAbortError } from "openai";
import { z } from "zod";
import { type CompleteCallbacks, type Message, type ResponseMeta, type Tool, tool, toolSchema } from "../llm.ts";
import openai from "../builtin/openai.ts";
import { openaiProvider, openaiResponsesProvider } from "./openai.ts";
import { anthropicProvider } from "./anthropic.ts";

const sse = (...events: object[]) =>
  new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

test("openaiResponsesProvider streams a turn and replays its output only to the same endpoint and model", async () => {
  const bodies: { input: unknown[]; [key: string]: unknown }[] = [];
  let reply = sse();
  const provider = openaiResponsesProvider({
    apiKey: "k",
    baseURL: "http://test/v1",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return reply;
    },
  });
  const output = [
    { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "enc" },
    { id: "rs_2", type: "reasoning", summary: [] },
    { id: "rs_3", type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "t" }], signature: "s" },
    { id: "fc_1", type: "function_call", call_id: "call_1", name: "echo", arguments: '{"text":"hi"}' },
    { id: "fc_2", type: "function_call", call_id: "call_2", name: "echo", arguments: "{bad" },
  ];
  reply = sse(
    { type: "response.reasoning_summary_text.delta", delta: "think" },
    { type: "response.output_text.delta", delta: "Hello" },
    {
      type: "response.completed",
      response: {
        output: [...output, { id: "msg_1", type: "message", content: [{ type: "output_text", text: "Hello" }] }],
        usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } },
      },
    },
  );
  const echo = tool({
    name: "echo",
    description: "",
    inputSchema: z.object({ text: z.string() }),
    execute: async () => "",
  });
  const text: string[] = [];
  const thinking: string[] = [];
  const req = { model: "m", system: "sys", tools: [echo], effort: "high" as const };
  const assistant = await provider.complete(
    { ...req, messages: [{ role: "user", content: "hi" }] },
    { text: (t) => text.push(t), thinking: (t) => thinking.push(t) },
  );
  assert.deepEqual([text, thinking], [["Hello"], ["think"]]);
  assert.equal(assistant.text, "Hello");
  assert.deepEqual(assistant.usage, { input: 10, output: 5, cacheRead: 4 });
  assert.deepEqual(assistant.toolCalls, [
    { id: "call_1", name: "echo", input: { text: "hi" } },
    { id: "call_2", name: "echo", input: "{bad" },
  ]);
  const { instructions, store, reasoning, include, tools } = bodies[0] ?? { input: [] };
  assert.deepEqual(
    { instructions, store, reasoning, include },
    {
      instructions: "sys",
      store: false,
      reasoning: { effort: "high", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    },
  );
  assert.equal((tools as { strict: boolean }[])[0]?.strict, false);

  const image = { type: "image" as const, mediaType: "image/png" as const, data: "AAAA" };
  const history: Message[] = [
    { role: "user", content: "hi" },
    assistant,
    { role: "tool", results: [{ id: "call_1", output: "", images: [image] }] },
  ];
  reply = sse({ type: "response.completed", response: { output: [] } });
  await provider.complete({ ...req, messages: history });
  // ids dropped, and the reasoning with neither encrypted content nor text skipped
  assert.deepEqual(bodies[1]?.input.slice(1), [
    { type: "reasoning", summary: [], encrypted_content: "enc" },
    { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "t" }], signature: "s" },
    { type: "function_call", call_id: "call_1", name: "echo", arguments: '{"text":"hi"}' },
    { type: "function_call", call_id: "call_2", name: "echo", arguments: "{bad" },
    { type: "message", content: [{ type: "output_text", text: "Hello" }] },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
    },
  ]);
  // another model gets the turn rebuilt from text and tool calls
  reply = sse({ type: "response.completed", response: { output: [] } });
  await provider.complete({ ...req, model: "other", messages: history });
  assert.deepEqual(bodies[2]?.input.slice(1, 4), [
    { role: "assistant", content: "Hello" },
    { type: "function_call", call_id: "call_1", name: "echo", arguments: '{"text":"hi"}' },
    { type: "function_call", call_id: "call_2", name: "echo", arguments: '"{bad"' },
  ]);

  reply = sse({ type: "response.failed", response: { output: [], error: { code: "server_error", message: "boom" } } });
  await assert.rejects(provider.complete({ ...req, messages: history }), /boom/);
});

test("openaiProvider drops an empty assistant turn, which Chat Completions rejects", async () => {
  let body: { messages: unknown[] } | undefined;
  const provider = openaiProvider({
    apiKey: "k",
    baseURL: "http://test/v1",
    maxRetries: 0,
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      throw new Error("sent");
    },
  });
  const messages: Message[] = [
    { role: "user", content: "a" },
    { role: "assistant", text: "", toolCalls: [] },
    { role: "user", content: "b" },
  ];
  await assert.rejects(provider.complete({ model: "m", system: "", messages, tools: [] }));
  assert.deepEqual(body?.messages.slice(1), [
    { role: "user", content: "a" },
    { role: "user", content: "b" },
  ]);
});

test("the built-in openai defs pass create's headers and fetch to the SDK", async () => {
  for (const type of ["openai", "openai-responses"] as const) {
    const seen: (string | null)[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      seen.push(new Headers(init?.headers).get("x-test"));
      return new Response("{}", { status: 400 });
    };
    const provider = openai.plugin.providers[type].create(
      { type, apiKey: "k", endpoint: "http://test/v1" },
      { name: "o", headers: { "x-test": "yes" }, fetch },
    );
    await assert.rejects(provider.complete({ model: "m", system: "", messages: [], tools: [] }));
    assert.deepEqual(seen, ["yes"]);
  }
});

test("the built-in openai defs work without a key and never take a base URL, org or project from the environment", async (t) => {
  const env = { OPENAI_BASE_URL: "http://env.invalid/v1", OPENAI_ORG_ID: "org-env", OPENAI_PROJECT_ID: "proj-env" };
  const saved = Object.keys(env).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, env);
  t.after(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  for (const type of ["openai", "openai-responses"] as const) {
    const sent: string[][] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const h = new Headers(init?.headers);
      sent.push([String(url), ...["authorization", "openai-organization", "openai-project"].map((k) => `${h.get(k)}`)]);
      return Response.json({ object: "list", data: [{ id: "m", object: "model", created: 0, owned_by: "x" }] });
    };
    const create = (entry: { apiKey?: string; endpoint?: string }) =>
      openai.plugin.providers[type].create({ type, ...entry }, { name: "o", fetch });
    // a local server: no key, no authorization header (it used to throw "Missing credentials")
    assert.deepEqual(await create({ endpoint: "http://localhost:11434/v1" }).listModels(), ["m"]);
    await create({ apiKey: "k" }).listModels();
    assert.deepEqual(sent, [
      ["http://localhost:11434/v1/models", "null", "null", "null"],
      ["https://api.openai.com/v1/models", "Bearer k", "null", "null"],
    ]);
  }
});

/** Callbacks recording what a provider reports besides its reply. */
function reporter() {
  const r: { deltas: string[]; payload?: unknown; meta?: ResponseMeta; callbacks: CompleteCallbacks } = {
    deltas: [],
    callbacks: {
      toolInput: (d) => r.deltas.push(`${d.id} ${d.name} ${d.partial}`),
      payload: (p) => {
        r.payload = p;
      },
      meta: (m) => {
        r.meta = { ...r.meta, ...m };
      },
    },
  };
  return r;
}
const partials = (deltas: string[]) => deltas.map((d) => d.split(" ").slice(2).join(" ")).join("");
const image = (data: string) => ({ type: "image" as const, mediaType: "image/png" as const, data });
const twoImages: Message[] = [
  { role: "user", content: "a" },
  { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "echo", input: {} }] },
  { role: "tool", results: [{ id: "c1", output: "two", images: [image("AA=="), image("BB==")] }] },
];

test("openaiProvider reports its payload, response meta and streamed tool input, and sends every image", async () => {
  const bodies: { messages: { role: string; content: unknown }[] }[] = [];
  const chunk = { id: "cc_1", object: "chat.completion.chunk", created: 0, model: "m-1" };
  const sseChunks = (...chunks: object[]) =>
    new Response(
      [...chunks.map((c) => `data: ${JSON.stringify({ ...chunk, ...c })}\n\n`), "data: [DONE]\n\n"].join(""),
      {
        headers: { "content-type": "text/event-stream", "x-cost": "0.5" },
      },
    );
  let finish = "tool_calls";
  const provider = openaiProvider({
    apiKey: "k",
    baseURL: "http://test/v1",
    maxRetries: 0,
    fetch: async (_, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const call = (args: string, first: boolean) => ({
        index: 0,
        ...(first && { id: "c1", type: "function" }),
        function: { ...(first && { name: "echo" }), arguments: args },
      });
      return sseChunks(
        {
          choices: [
            { index: 0, delta: { role: "assistant", tool_calls: [call('{"text":', true)] }, finish_reason: null },
          ],
        },
        { choices: [{ index: 0, delta: { tool_calls: [call('"hi"}', false)] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
      );
    },
  });
  const r = reporter();
  const req = { model: "m", system: "", messages: [{ role: "user" as const, content: "a" }], tools: [] };
  const msg = await provider.complete(req, r.callbacks);
  assert.deepEqual(r.deltas, ['c1 echo {"text":', 'c1 echo "hi"}']);
  assert.deepEqual(JSON.parse(partials(r.deltas)), msg.toolCalls[0]?.input);
  assert.equal((r.payload as { model: string }).model, "m");
  assert.deepEqual(
    { ...r.meta, headers: r.meta?.headers?.["x-cost"] },
    { stopReason: "tool_use", responseId: "cc_1", model: "m-1", status: 200, headers: "0.5" },
  );
  for (const [reason, expected] of [
    ["stop", "end"],
    ["length", "max_tokens"],
  ] as const) {
    finish = reason;
    await provider.complete(req, r.callbacks);
    assert.equal(r.meta?.stopReason, expected);
  }
  await provider.complete({ ...req, messages: twoImages });
  const images = bodies.at(-1)?.messages.at(-1);
  assert.deepEqual(
    [images?.role, (images?.content as { type: string }[] | undefined)?.map((c) => c.type)],
    ["user", ["image_url", "image_url"]],
  );
});

test("openaiProvider accumulates chunks whose id varies, and surfaces an abort mid-stream as an abort", async () => {
  const line = (id: string, delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  let stall = false;
  const provider = openaiProvider({
    apiKey: "k",
    baseURL: "http://test/v1",
    maxRetries: 0,
    fetch: async () =>
      new Response(
        stall
          ? new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode(line("a", { content: "he" }))) })
          : [
              line("a1", { content: "he" }),
              line("a2", { content: "llo" }),
              line("a3", {}, "stop"),
              "data: [DONE]\n\n",
            ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const req = { model: "m", system: "", messages: [{ role: "user" as const, content: "a" }], tools: [] };
  assert.equal((await provider.complete(req)).text, "hello");
  stall = true;
  const controller = new AbortController();
  await assert.rejects(
    provider.complete({ ...req, signal: controller.signal }, { text: () => controller.abort() }),
    APIUserAbortError,
  );
});

test("openaiResponsesProvider reports its payload, response meta and streamed tool input, and sends every image", async () => {
  const bodies: { input: { type?: string; output?: unknown }[] }[] = [];
  let incomplete: object | undefined;
  let called = true;
  const provider = openaiResponsesProvider({
    apiKey: "k",
    baseURL: "http://test/v1",
    maxRetries: 0,
    fetch: async (_, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const item = { id: "fc_1", type: "function_call", call_id: "c1", name: "echo", arguments: "" };
      const reply = sse(
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"text":' },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '"hi"}' },
        {
          type: incomplete ? "response.incomplete" : "response.completed",
          response: {
            id: "resp_1",
            model: "m-1",
            output: incomplete || !called ? [] : [{ ...item, arguments: '{"text":"hi"}' }],
            incomplete_details: incomplete ?? null,
          },
        },
      );
      reply.headers.set("x-cost", "0.5");
      return reply;
    },
  });
  const r = reporter();
  const req = { model: "m", system: "", messages: [{ role: "user" as const, content: "a" }], tools: [] };
  const msg = await provider.complete(req, r.callbacks);
  assert.deepEqual(r.deltas, ['c1 echo {"text":', 'c1 echo "hi"}']);
  assert.deepEqual(JSON.parse(partials(r.deltas)), msg.toolCalls[0]?.input);
  assert.equal((r.payload as { model: string }).model, "m");
  assert.deepEqual(
    { ...r.meta, headers: r.meta?.headers?.["x-cost"] },
    { stopReason: "tool_use", responseId: "resp_1", model: "m-1", status: 200, headers: "0.5" },
  );
  incomplete = { reason: "max_output_tokens" };
  await provider.complete(req, r.callbacks);
  assert.equal(r.meta?.stopReason, "max_tokens");
  incomplete = undefined;
  called = false;
  await provider.complete(req, r.callbacks);
  assert.equal(r.meta?.stopReason, "end");
  await provider.complete({ ...req, messages: twoImages });
  const output = bodies.at(-1)?.input.at(-1)?.output as { type: string }[];
  assert.deepEqual(
    output.map((c) => c.type),
    ["input_text", "input_image", "input_image"],
  );
});

test("openaiProvider accumulates tool calls however an endpoint splits their id, name and arguments", async () => {
  const chunk = (choices: object[], extra: object = {}) =>
    `data: ${JSON.stringify({ id: "a", object: "chat.completion.chunk", created: 0, model: "m", choices, ...extra })}\n\n`;
  const tc = (calls: object[], finish: string | null = null) =>
    chunk([{ index: 0, delta: { tool_calls: calls }, finish_reason: finish }]);
  const fn = (f: object, extra: object = {}) => ({ type: "function", function: f, ...extra });
  const run = async (...lines: string[]) => {
    const inputs: string[] = [];
    const provider = openaiProvider({
      apiKey: "k",
      baseURL: "http://test/v1",
      maxRetries: 0,
      fetch: async () =>
        new Response([...lines, "data: [DONE]\n\n"].join(""), { headers: { "content-type": "text/event-stream" } }),
    });
    const m = await provider.complete(
      { model: "m", system: "", messages: [{ role: "user", content: "a" }], tools: [] },
      { toolInput: (d) => inputs.push(`${d.id}:${d.name}:${d.partial}`) },
    );
    return { m, inputs };
  };

  // two calls interleaved by index, then a usage-only chunk with no choices
  const interleaved = await run(
    tc([{ index: 0, id: "c0", ...fn({ name: "a", arguments: "" }) }]),
    tc([{ index: 1, id: "c1", ...fn({ name: "b", arguments: '{"y"' }) }]),
    tc([{ index: 0, ...fn({ arguments: '{"x":1}' }) }]),
    tc([{ index: 1, ...fn({ arguments: ":2}" }) }]),
    tc([], "tool_calls"),
    chunk([], { usage: { prompt_tokens: 5, completion_tokens: 3 } }),
  );
  assert.deepEqual(interleaved.m.toolCalls, [
    { id: "c0", name: "a", input: { x: 1 } },
    { id: "c1", name: "b", input: { y: 2 } },
  ]);
  assert.deepEqual(interleaved.m.usage, { input: 5, output: 3, cacheRead: 0 });

  // id and name repeated on every delta
  const repeated = await run(
    tc([{ index: 0, id: "c0", ...fn({ name: "a", arguments: '{"x"' }) }]),
    tc([{ index: 0, id: "c0", ...fn({ name: "a", arguments: ":1}" }) }]),
    tc([], "tool_calls"),
  );
  assert.deepEqual(repeated.m.toolCalls, [{ id: "c0", name: "a", input: { x: 1 } }]);
  assert.deepEqual(repeated.inputs, ['c0:a:{"x"', "c0:a::1}"]);

  // the name in a later delta than the id and the first arguments: toolInput waits for it
  const later = await run(
    tc([{ index: 0, id: "c0", ...fn({ arguments: '{"x"' }) }]),
    tc([{ index: 0, ...fn({ name: "a", arguments: ":1}" }) }]),
    tc([], "tool_calls"),
  );
  assert.deepEqual(later.m.toolCalls, [{ id: "c0", name: "a", input: { x: 1 } }]);
  assert.deepEqual(later.inputs, ['c0:a:{"x":1}']);

  // no id: one is generated, the same for toolInput and the result
  const noId = await run(tc([{ index: 0, ...fn({ name: "a", arguments: '{"x":1}' }) }]), tc([], "tool_calls"));
  const id = noId.m.toolCalls[0]?.id ?? "";
  assert.match(id, /^call_/);
  assert.deepEqual(noId.inputs, [`${id}:a:{"x":1}`]);

  // never named: an error, not a silently dropped call
  await assert.rejects(
    run(tc([{ index: 0, id: "c0", ...fn({ arguments: "{}" }) }]), tc([], "tool_calls")),
    /without a name/,
  );
});

test("both OpenAI APIs send a user message's images before its text, two user messages in a row as two, and never entryId or meta", async () => {
  const bodies: string[] = [];
  const options = {
    apiKey: "k",
    baseURL: "http://test/v1",
    maxRetries: 0,
    fetch: async (_: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response("{}", { status: 400 });
    },
  };
  const image = { type: "image" as const, mediaType: "image/png" as const, data: "AA==" };
  const messages: Message[] = [
    { role: "user", content: "look", images: [image], entryId: "e1" },
    { role: "user", content: "a note", meta: { plugin: "p", type: "note" }, entryId: "e2" },
  ];
  const req = { model: "m", system: "", messages, tools: [] };
  await assert.rejects(openaiProvider(options).complete(req));
  await assert.rejects(openaiResponsesProvider(options).complete(req));
  const [chat, responses] = bodies.map((b) => JSON.parse(b));
  assert.deepEqual(
    chat.messages.filter((m: { role: string }) => m.role === "user").map((m: { content: unknown }) => m.content),
    [
      [
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
        { type: "text", text: "look" },
      ],
      "a note",
    ],
  );
  assert.deepEqual(
    responses.input.filter((m: { role: string }) => m.role === "user").map((m: { content: unknown }) => m.content),
    [
      [
        { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "auto" },
        { type: "input_text", text: "look" },
      ],
      "a note",
    ],
  );
  for (const b of bodies) assert.doesNotMatch(b, /entryId|meta|e1/);
});

test("every provider declares a tool's jsonSchema as is, else inputSchema's, adds its providerOptions, and never sends its meta", async () => {
  const bodies: string[] = [];
  const fetch = async (_: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response("{}", { status: 400 });
  };
  const options = { apiKey: "k", baseURL: "http://test/v1", maxRetries: 0, fetch };
  const schema = { type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] } }, $defs: {} };
  const tools: Tool[] = [
    {
      name: "raw",
      description: "",
      inputSchema: z.looseObject({}),
      jsonSchema: schema,
      meta: { secret: "zz" },
      providerOptions: {
        openai: { x_chat: 1 },
        "openai-responses": { strict: true },
        anthropic: { cache_control: { type: "ephemeral" } },
      },
      execute: async () => "",
    },
    { name: "zod", description: "", inputSchema: z.object({ b: z.number() }), execute: async () => "" },
  ];
  const req = { model: "m", system: "", messages: [{ role: "user" as const, content: "a" }], tools };
  await assert.rejects(openaiProvider(options).complete(req));
  await assert.rejects(openaiResponsesProvider(options).complete(req));
  await assert.rejects(anthropicProvider({ ...options, baseURL: "http://test" }).complete({ ...req, maxTokens: 1 }));
  const [chat, responses, anthropic] = bodies.map((b) => JSON.parse(b));
  const zod = toolSchema(tools[1] as Tool);
  assert.deepEqual(
    chat.tools.map((t: { function: { parameters: unknown } }) => t.function.parameters),
    [schema, zod],
  );
  assert.deepEqual(
    responses.tools.map((t: { parameters: unknown }) => t.parameters),
    [schema, zod],
  );
  assert.deepEqual(
    anthropic.tools.map((t: { input_schema: unknown }) => t.input_schema),
    [schema, zod],
  );
  for (const b of bodies) assert.doesNotMatch(b, /zz/);
  // each API's own providerOptions, spread into its tool def
  assert.equal(chat.tools[0].x_chat, 1);
  assert.equal(responses.tools[0].strict, true);
  assert.deepEqual(anthropic.tools[0].cache_control, { type: "ephemeral" });
  assert.equal(anthropic.tools[1].cache_control, undefined);
});

test("every provider sends temperature only when the request sets it", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch = async (_: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 400 });
  };
  const options = { apiKey: "k", baseURL: "http://test/v1", maxRetries: 0, fetch };
  const providers = [
    openaiProvider(options),
    openaiResponsesProvider(options),
    anthropicProvider({ ...options, baseURL: "http://test" }),
  ];
  const req = { model: "m", system: "", messages: [], tools: [], maxTokens: 1 };
  for (const p of providers) {
    await assert.rejects(p.complete({ ...req, temperature: 0.2 }));
    await assert.rejects(p.complete(req));
  }
  assert.deepEqual(
    bodies.map((b) => b.temperature),
    [0.2, undefined, 0.2, undefined, 0.2, undefined],
  );
});
