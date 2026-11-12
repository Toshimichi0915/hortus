import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgent } from "@hortus/core";
import { scripted, tempHome } from "@hortus/core/testing";

test("hello loads from its plugin dir, adds its prompt and its tool runs", async (t) => {
  t.after(await tempHome({ plugins: { hello: fileURLToPath(new URL("..", import.meta.url)) } }));
  const provider = scripted([{ toolCalls: [{ id: "1", name: "hello", input: { name: "Ada" } }] }, { text: "done" }]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  await agent.run("greet Ada");
  assert.match(provider.requests[0]?.system ?? "", /Greet people with the hello tool\.$/);
  assert.deepEqual(provider.requests[1]?.messages.at(-1), {
    role: "tool",
    results: [{ id: "1", output: "Hello, Ada!" }],
  });
});
