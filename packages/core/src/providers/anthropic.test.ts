import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../llm.ts";
import { anthropicProvider } from "./anthropic.ts";

test("anthropicProvider drops an empty assistant turn, even a replayed one, which the API rejects", async () => {
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
    { role: "assistant", text: "", toolCalls: [], raw: { provider: "anthropic", content: [] } },
    { role: "user", content: "b" },
    { role: "assistant", text: "", toolCalls: [] },
    { role: "user", content: "c" },
  ];
  await assert.rejects(
    provider.complete(
      { model: "m", system: "", messages, tools: [] },
      () => {},
      () => {},
    ),
  );
  assert.deepEqual(
    body?.messages.map((m) => (m as { role: string }).role),
    ["user", "user", "user"],
  );
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
  const reply = await provider.complete(
    { model: "m", system: "", messages: [{ role: "user", content: "a" }], tools: [] },
    () => {},
    () => {},
  );
  assert.deepEqual(reply.usage, { input: 321, output: 5, cacheRead: 20, cacheWrite: 300 });
});
