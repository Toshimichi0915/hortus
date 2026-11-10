import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { runTool } from "./agent.ts";
import { tool } from "./llm.ts";

const progress = tool({
  name: "progress",
  description: "",
  inputSchema: z.object({ fail: z.boolean() }),
  execute: async ({ fail }, ctx) => {
    ctx.update({ done: 1 });
    ctx.update({ done: 2 });
    if (fail) throw new Error("boom");
    return "ok";
  },
});

test("a tool's updates reach onUpdate in order, and the last one is the result's details, even when it throws", async () => {
  const seen: unknown[] = [];
  const ok = await runTool([progress], { id: "1", name: "progress", input: { fail: false } }, [], (d) => seen.push(d));
  assert.deepEqual(seen, [{ done: 1 }, { done: 2 }]);
  assert.deepEqual(ok, { id: "1", output: "ok", details: { done: 2 } });
  const failed = await runTool([progress], { id: "2", name: "progress", input: { fail: true } });
  assert.deepEqual(failed, { id: "2", output: "boom", isError: true, details: { done: 2 } });
  // a tool that never updates has no details key at all, so saved results don't change
  const plain = tool({ name: "plain", description: "", inputSchema: z.object({}), execute: async () => "x" });
  assert.deepEqual(await runTool([plain], { id: "3", name: "plain", input: {} }), { id: "3", output: "x" });
});
