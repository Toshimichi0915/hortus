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
