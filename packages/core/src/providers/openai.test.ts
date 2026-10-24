import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { type Message, tool } from "../llm.ts";
import { openaiResponsesProvider } from "./openai.ts";

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
    (t) => text.push(t),
    (t) => thinking.push(t),
  );
  assert.deepEqual([text, thinking], [["Hello"], ["think"]]);
  assert.equal(assistant.text, "Hello");
  assert.deepEqual(assistant.usage, { input: 10, output: 5, cached: 4 });
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
    { role: "tool", results: [{ id: "call_1", output: "", image }] },
  ];
  reply = sse({ type: "response.completed", response: { output: [] } });
  await provider.complete(
    { ...req, messages: history },
    () => {},
    () => {},
  );
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
  await provider.complete(
    { ...req, model: "other", messages: history },
    () => {},
    () => {},
  );
  assert.deepEqual(bodies[2]?.input.slice(1, 4), [
    { role: "assistant", content: "Hello" },
    { type: "function_call", call_id: "call_1", name: "echo", arguments: '{"text":"hi"}' },
    { type: "function_call", call_id: "call_2", name: "echo", arguments: '"{bad"' },
  ]);

  reply = sse({ type: "response.failed", response: { output: [], error: { code: "server_error", message: "boom" } } });
  await assert.rejects(
    provider.complete(
      { ...req, messages: history },
      () => {},
      () => {},
    ),
    /boom/,
  );
});
