import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgent, type Events, type Message, openSession, type ProviderDef, tool } from "@hortus/core";
import { record, scripted, type Turn, tempHome, until } from "@hortus/core/testing";
import { z } from "zod";
import type { VccDetails } from "./index.ts";

// stand-ins for builtin:read and builtin:bash (disabled below)
const read = tool({
  name: "read",
  description: "Reads",
  inputSchema: z.object({ path: z.string() }),
  execute: async () => "export function refresh() {}\n".repeat(20),
});
const bash = tool({
  name: "bash",
  description: "Runs",
  inputSchema: z.object({ command: z.string() }),
  execute: async () => "[main a1b2c3d] fix: refresh token after password reset",
});

/** An agent with vcc on a scripted provider (a `window`-token context, none: no threshold), on a new file session. */
async function setup(t: { after: (fn: () => Promise<void>) => void }, turns: Turn[], window?: number) {
  t.after(
    await tempHome({
      config: {
        provider: "scripted",
        model: "scripted",
        compaction: { reserve: 200, keepRecent: 50 },
        disabledPlugins: ["builtin:read", "builtin:bash", "builtin:skills"],
      },
      plugins: { vcc: fileURLToPath(new URL("..", import.meta.url)) },
    }),
  );
  const provider = scripted(turns);
  const windowed: ProviderDef = {
    create: (e, o) => ({ ...provider.create(e, o), info: async () => (window ? { contextWindow: window } : {}) }),
  };
  const rec = record();
  const agent = await createAgent({
    extra: [
      { name: "scripted", plugin: { providers: { scripted: windowed }, tools: [read, bash] } },
      { name: "rec", plugin: rec },
    ],
  });
  t.after(() => agent.close());
  const session = await openSession(null);
  await agent.setSession(session);
  const compactions = () =>
    rec.events.filter((e) => e.name === "compacted").map((e) => (e.payload as Events["compacted"]).entry);
  const command = (name: string) => agent.commands().find((c) => c.name === name);
  return { agent, provider, session, compactions, command };
}

const usage = (input: number) => ({ input, output: 5, cacheRead: 0 });
const first = (messages: readonly Message[] = []) => {
  const m = messages[0];
  return m?.role === "user" ? m.content : "";
};

test("vcc: a threshold compaction keeps recent turns and writes pi-vcc's sections, with no model call; vcc_recall finds what it dropped", async (t) => {
  const { agent, provider, session, compactions } = await setup(
    t,
    [
      { toolCalls: [{ id: "r", name: "read", input: { path: "src/auth.ts" } }] },
      { toolCalls: [{ id: "b", name: "bash", input: { command: 'git commit -m "fix: refresh token"' } }] },
      { text: "Fixed the login bug: the token is refreshed after a password reset.", usage: usage(300) },
      { text: "Added tests for the refresh path.", usage: usage(900) },
      // run 3: its request crosses 1000 - 200, so it starts compacted
      { toolCalls: [{ id: "q", name: "vcc_recall", input: { query: "refresh token" } }] },
      { text: "done" },
    ],
    1000,
  );
  await agent.run("Fix the login bug in auth please");
  await agent.run("Now add tests for the refresh path");
  await agent.run("What was the commit for the login fix?");

  // 6 requests, all the run's: the summary is pi-vcc's, not a model's
  assert.equal(provider.requests.length, 6);
  const [entry] = compactions();
  const data = entry?.data;
  assert.equal((data?.details as VccDetails | undefined)?.compactor, "pi-vcc");
  assert.equal((data?.details as VccDetails | undefined)?.reason, "threshold");
  // smart keep-tail: the last turn alone is tiny, so it keeps two of the three (the third would keep everything)
  const u2 = session.getState().messages.find((m) => m.role === "user" && m.content.startsWith("Now add"));
  assert.equal(data?.firstKeptId, u2?.entryId);
  const summary = data?.summary ?? "";
  assert.match(summary, /^\[Early Session Requests\]\n- Fix the login bug in auth please\n/);
  assert.match(summary, /\[Files And Changes\]\n- Read: src\/auth\.ts\n/);
  assert.match(summary, /\[Commits\]\n- a1b2c3d: fix: refresh token\n/);
  // the brief: tool calls on one line each, with session-global `#N` refs (u1 #0, read #1, its result #2, bash #3)
  assert.match(
    summary,
    /\[assistant\]\n\* read "src\/auth\.ts" \(#1\)\n\* bash "git commit -m \\?"fix: refresh token\\?"" \(#3\)/,
  );
  assert.match(summary, /Use `vcc_recall` to search/);

  // the run's next request starts with the summary, then the kept turns
  const req = provider.requests[4]?.messages ?? [];
  assert.match(first(req), /<summary>\n\[Early Session Requests\]/);
  assert.equal(req[1]?.role === "user" && req[1].content, "Now add tests for the refresh path");

  // vcc_recall reads the raw session: the commit, summarized away, is found by its `#N`; the current turn is left out
  const recalled = provider.requests[5]?.messages.at(-1);
  const output = recalled?.role === "tool" ? (recalled.results[0]?.output ?? "") : "";
  assert.match(output, /#3 \[assistant\]/);
  assert.match(output, /#4 \[tool_result\]/);
  assert.doesNotMatch(output, /What was the commit/);
});

test("vcc: /pi-vcc keep:0 compacts everything, sends the prompt after it, and the next one merges into the summary", async (t) => {
  const { agent, provider, compactions, command } = await setup(t, [
    { text: "Sure, looking at the parser." },
    { text: "The parser handles nested lists now." },
    { text: "Continuing from the summary." },
    { text: "Docs updated." },
    { text: "ok" },
  ]);
  await agent.run("Please fix the markdown parser");
  await agent.run("Also support nested lists in it");
  assert.equal(
    await command("pi-vcc")?.run("keep:0 carry on with the docs"),
    "pi-vcc: kept 0/2 turns, ~0 tok (summarized 4).",
  );
  // the follow-up prompt runs on the compacted session: the summary alone, then the prompt
  await until(() => provider.requests.length === 3);
  const req = provider.requests[2]?.messages ?? [];
  assert.equal(req.length, 2);
  assert.match(
    first(req),
    /\[Early Session Requests\]\n- Please fix the markdown parser\n- Also support nested lists in it/,
  );
  assert.equal(req[1]?.role === "user" && req[1].content, "carry on with the docs");

  await until(() => !agent.ctx.busy());
  await agent.run("Now update the README for nested lists");
  await command("pi-vcc")?.run("keep:0");
  const summary = compactions()[1]?.data.summary ?? "";
  // the early requests stay as the first summary set them; later user messages go to [User Messages]
  assert.match(
    summary,
    /^\[Early Session Requests\]\n- Please fix the markdown parser\n- Also support nested lists in it\n\n/,
  );
  assert.match(summary, /\[User Messages\]\n- carry on with the docs\n- Now update the README for nested lists\n/);
  // the old brief rolls forward and the recall note isn't repeated
  assert.match(summary, /The parser handles nested lists now[\s\S]*Docs updated/);
  assert.equal(summary.match(/vcc_recall/g)?.length, 1);
});
