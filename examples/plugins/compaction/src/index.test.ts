import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type CompactionData, createAgent, type Message, openSession, type ProviderDef } from "@hortus/core";
import { record, scripted, tempHome } from "@hortus/core/testing";
import { summarize } from "./index.ts";

test("compaction: crossing the threshold, the summary comes from the messages, with no model call", async (t) => {
  t.after(
    await tempHome({
      config: { provider: "scripted", model: "scripted", compaction: { reserve: 200, keepRecent: 50 } },
      plugins: { compaction: fileURLToPath(new URL("..", import.meta.url)) },
    }),
  );
  const provider = scripted([
    { toolCalls: [{ id: "1", name: "read", input: { path: "src/a.ts" } }] },
    { text: "a.ts exports parse", usage: { input: 900, output: 5, cacheRead: 0 } },
    { text: "done" },
  ]);
  // a 1000-token window, so the second run's request crosses 1000 - 200
  const windowed: ProviderDef = {
    create: (e, o) => ({ ...provider.create(e, o), info: async () => ({ contextWindow: 1000 }) }),
  };
  const rec = record();
  const agent = await createAgent({
    extra: [
      { name: "scripted", plugin: { providers: { scripted: windowed } } },
      { name: "rec", plugin: rec },
    ],
  });
  t.after(() => agent.close());
  await agent.setSession(await openSession(null));
  await agent.run("what does a.ts export?");
  await agent.run("x".repeat(400));
  // three run requests: none summarizing
  assert.equal(provider.requests.length, 3);
  const compacted = rec.events.find((e) => e.name === "compacted")?.payload as {
    entry: { data: CompactionData };
    reason: string;
  };
  assert.equal(compacted.reason, "threshold");
  assert.match(compacted.entry.data.summary, /## User requests\n- what does a.ts export\?/);
  assert.match(compacted.entry.data.summary, /## Files touched\n- src\/a.ts/);
  assert.deepEqual(compacted.entry.data.details, { files: ["src/a.ts"] });
  const first = provider.requests[2]?.messages[0];
  assert.match(first?.role === "user" ? first.content : "", /## Last reply\na.ts exports parse/);
});

test("compaction: each summary merges the previous one's lists, capped, rather than nesting it", () => {
  const turn = (i: number): Message[] => [
    { role: "user", content: `ask ${i}` },
    {
      role: "assistant",
      text: `reply ${i}`,
      toolCalls: [{ id: `${i}`, name: "read", input: { path: `f${i % 3}.ts` } }],
    },
  ];
  let summary: string | undefined = "## Goal\nA model's summary";
  for (let i = 0; i < 30; i++) summary = summarize(turn(i), summary).summary;
  assert.equal(summary?.match(/## Earlier/g)?.length, 1);
  assert.match(summary ?? "", /^## Earlier\n## Goal\nA model's summary\n\n## User requests\n- ask 10\n/);
  assert.equal(summary?.match(/^- ask/gm)?.length, 20);
  assert.match(summary ?? "", /- ask 29\n\n## Files touched\n- f0.ts\n- f1.ts\n- f2.ts\n\n## Last reply\nreply 29$/);
  // no new reply: the previous one's stays
  assert.match(
    summarize([{ role: "user", content: "more" }], summary).summary,
    /- more\n[\s\S]*## Last reply\nreply 29$/,
  );
});
