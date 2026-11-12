import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { z } from "zod";
import { createAgent } from "./agent.ts";
import type { Config } from "./config.ts";
import type { CompactionData, Events, Message, Plugin, ProviderDef } from "./llm.ts";
import { isSummary, tool } from "./llm.ts";
import type { Named } from "./plugins.ts";
import { openSession, type PluginEntry } from "./session.ts";
import { record, scripted, type Turn, tempHome, until } from "./testing.ts";

const echo = tool({
  name: "echo",
  description: "Echoes",
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => text,
});

/** An agent on a scripted provider with a 1000-token window, then `plugins` and a recorder, on a new file session. */
async function setup(
  t: { after: (fn: () => Promise<void>) => void },
  turns: Turn[],
  { plugins = [], config = {}, window = 1000 }: { plugins?: Named[]; config?: Config; window?: number } = {},
) {
  t.after(
    await tempHome({
      config: { provider: "scripted", model: "scripted", compaction: { reserve: 200, keepRecent: 100 }, ...config },
    }),
  );
  const provider = scripted(turns);
  const windowed: ProviderDef = {
    create: (e, o) => ({ ...provider.create(e, o), info: async () => (window ? { contextWindow: window } : {}) }),
  };
  const rec = record();
  const agent = await createAgent({
    extra: [
      { name: "scripted", plugin: { providers: { scripted: windowed }, tools: [echo] } },
      ...plugins,
      { name: "rec", plugin: rec },
    ],
  });
  t.after(() => agent.close());
  const session = await openSession(null);
  await agent.setSession(session);
  const payloads = <E extends keyof Events>(name: E) =>
    rec.events.filter((e) => e.name === name).map((e) => e.payload as Events[E]);
  const command = (name: string) => agent.commands().find((c) => c.name === name);
  return { agent, provider, session, payloads, command };
}

const texts = (messages: readonly Message[] = []) =>
  messages.map((m) =>
    m.role === "user" ? m.content : m.role === "assistant" ? m.text : m.results.map((r) => r.output).join(),
  );
const usage = (input: number) => ({ input, output: 5, cacheRead: 0 });
const big = "y".repeat(800);
const dataOf = (e: PluginEntry<CompactionData> | undefined) => e?.data;

/** a turn that calls echo with a long text, then a reply whose usage puts the context near the window */
const longTurns: Turn[] = [
  { toolCalls: [{ id: "1", name: "echo", input: { text: big } }], usage: usage(100) },
  { text: "a2", usage: usage(900) },
];

test("crossing the threshold compacts before the next request: summary, then the recent messages", async (t) => {
  const { agent, provider, session, payloads } = await setup(t, [...longTurns, { text: "SUMMARY" }, { text: "done" }]);
  await agent.run("hi");
  await agent.run("next");
  // request 3 summarized (no tools, the conversation as text); request 4 is the run's, compacted
  const summarizing = provider.requests[2];
  assert.match(summarizing?.system ?? "", /summar/);
  assert.equal(summarizing?.tools.length, 0);
  assert.match(String((summarizing?.messages[0] as { content?: string } | undefined)?.content), /\[User\]: hi/);
  const sent = provider.requests[3]?.messages ?? [];
  assert.match(texts(sent)[0] ?? "", /<summary>\nSUMMARY\n<\/summary>/);
  // the cut keeps the call with its result: it starts at the assistant message, not the tool message
  assert.deepEqual(texts(sent).slice(1), ["", big, "a2", "next"]);
  assert.equal(sent[1]?.role, "assistant");
  const [compacted] = payloads("compacted");
  assert.equal(compacted?.reason, "threshold");
  assert.equal(compacted?.entry.type, "builtin:compaction:compaction");
  assert.equal(dataOf(compacted?.entry)?.summary, "SUMMARY");
  assert.equal(dataOf(compacted?.entry)?.firstKeptId, session.getState().messages[1]?.entryId);
  // the usage of everything before moved to the session's, so totals hold and the estimate restarts
  assert.equal(
    session.getState().messages.some((m) => m.role === "assistant" && m.usage && m.text !== "done"),
    false,
  );
  assert.equal(session.getState().usage?.input, 1000);
  // the file still has every message
  const lines = (await readFile(session.path as string, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.filter((e) => e.type === "message").map((e) => texts([e.message])[0]),
    ["hi", "", big, "a2", "next", "done"],
  );
});

test("resuming replays the compacted state; a branch from before the compaction has the full history", async (t) => {
  const { agent, session } = await setup(t, [...longTurns, { text: "SUMMARY" }, { text: "done" }]);
  await agent.run("hi");
  await agent.run("next");
  const resumed = await openSession(session.leafId as string);
  await agent.setSession(resumed, "resume");
  assert.deepEqual(texts(resumed.getState().messages).slice(1), ["", big, "a2", "next", "done"]);
  const first = resumed.getState().messages[0];
  assert.equal(first?.role === "user" && first.meta?.type, "summary");
  // "a2" was saved before the compaction entry
  const a2 = session.entries().find((e) => e.type === "message" && texts([e.message])[0] === "a2");
  const branch = await openSession(a2?.id as string);
  await agent.setSession(branch, "resume");
  assert.deepEqual(texts(branch.getState().messages), ["hi", "", big, "a2"]);
});

test("compact handlers: cancel stops it; the first summary (and details) set is final, with no model call", async (t) => {
  let cancel = true;
  const handlers = (summary: string): Plugin => ({
    on: {
      compact: (p) => {
        if (cancel) p.cancel = true;
        p.summary = summary;
        p.details = { by: summary };
      },
    },
  });
  const { agent, provider, session, payloads, command } = await setup(t, [{ text: "x".repeat(800) }, { text: "b" }], {
    plugins: [
      { name: "first", plugin: handlers("first") },
      { name: "second", plugin: handlers("second") },
    ],
  });
  await agent.run("one");
  await agent.run("two");
  assert.equal(await command("compact")?.run(""), "Compaction cancelled by a plugin");
  assert.equal(payloads("compacted").length, 0);
  assert.equal(session.getState().messages.length, 4);

  cancel = false;
  const requests = provider.requests.length;
  assert.equal(await command("compact")?.run(""), undefined);
  assert.equal(provider.requests.length, requests, "no model call");
  const data = dataOf(payloads("compacted")[0]?.entry);
  assert.equal(data?.summary, "first");
  assert.deepEqual(data?.details, { by: "first" });
  assert.equal(data?.usage, undefined);
  assert.deepEqual(texts(session.getState().messages).slice(1), ["x".repeat(800), "two", "b"]);
});

test("moving firstKeptId moves the cut", async (t) => {
  let keep: string | undefined;
  const mover: Plugin = {
    on: {
      compact: (p) => {
        p.firstKeptId = keep;
        p.summary = `summarized ${p.messages.length}`;
      },
    },
  };
  const { agent, session, payloads, command } = await setup(t, [{ text: "x".repeat(800) }, { text: "b" }], {
    plugins: [{ name: "mover", plugin: mover }],
  });
  await agent.run("one");
  await agent.run("two");
  keep = session.getState().messages[3]?.entryId;
  await command("compact")?.run("");
  assert.equal(dataOf(payloads("compacted")[0]?.entry)?.firstKeptId, keep);
  // `messages` followed the moved cut: the three before "b"
  assert.equal(dataOf(payloads("compacted")[0]?.entry)?.summary, "summarized 3");
  assert.deepEqual(texts(session.getState().messages).slice(1), ["b"]);
});

test("a context overflow compacts once and retries once, not in a loop", async (t) => {
  const overflow = () => {
    throw Object.assign(new Error("prompt is too long: 300000 tokens > 200000 maximum"), { status: 400 });
  };
  const { agent, provider, payloads } = await setup(t, [
    { text: "first reply" },
    overflow,
    { text: "S" },
    { text: "ok" },
    overflow,
    { text: "S2" },
    overflow,
  ]);
  await agent.run("first");
  const end = await agent.run("second");
  assert.equal(payloads("compacted").length, 1);
  assert.equal(payloads("compacted")[0]?.reason, "overflow");
  // the retry is the compacted history: the summary, then "second" (kept: the latest cut)
  assert.deepEqual(texts(provider.requests[3]?.messages).slice(1), ["second"]);
  assert.deepEqual(texts(end?.messages).slice(-1), ["ok"]);
  // a retry that overflows again fails the run: one compaction, one retry
  await assert.rejects(agent.run("third"), /too long/);
  assert.equal(payloads("compacted").length, 2);
  assert.equal(provider.requests.length, 7);
});

test("/compact <instructions> and a bus compact_request compact as manual, passing the instructions", async (t) => {
  const { agent, provider, payloads, command, session } = await setup(t, [
    { text: "x".repeat(800) },
    { text: "b" },
    { text: "S1" },
    { text: "c" },
    { text: "S2" },
  ]);
  await agent.run("one");
  await agent.run("two");
  await command("compact")?.run("focus on X");
  assert.match(
    String((provider.requests[2]?.messages[0] as { content?: string } | undefined)?.content),
    /Additional focus: focus on X/,
  );
  await agent.run("three");
  let done: PluginEntry<CompactionData> | undefined;
  await agent.ctx.emit("compact_request", {
    instructions: "Y",
    done: (e) => {
      done = e;
    },
  });
  assert.match(
    String((provider.requests[4]?.messages[0] as { content?: string } | undefined)?.content),
    /Additional focus: Y/,
  );
  // the second summary updates the first
  assert.match(
    String((provider.requests[4]?.messages[0] as { content?: string } | undefined)?.content),
    /<previous-summary>\nS1\n/,
  );
  assert.deepEqual(
    payloads("compact").map((p) => [p.reason, p.instructions, p.previousSummary]),
    [
      ["manual", "focus on X", undefined],
      ["manual", "Y", "S1"],
    ],
  );
  assert.deepEqual(done, payloads("compacted")[1]?.entry);
  assert.deepEqual(done && dataOf(done)?.summary, "S2");
  assert.match(texts(session.getState().messages)[0] ?? "", /S2/);
});

test("compact's all is every message after the previous summary, whatever the cut; done gets why nothing was saved", async (t) => {
  const seen: string[][] = [];
  let cancel = false;
  const plugin: Plugin = {
    on: {
      compact: (p) => {
        seen.push(texts(p.all));
        if (cancel) p.cancel = true;
        // a cut of its own: keep only the last message
        p.firstKeptId = p.all.at(-1)?.entryId;
        p.summary = "S1";
      },
    },
  };
  const { agent, session, command } = await setup(t, [{ text: "x".repeat(800) }, { text: "b" }, { text: "c" }], {
    plugins: [{ name: "p", plugin }],
  });
  await agent.run("one");
  await agent.run("two");
  assert.equal(await command("compact")?.run(""), undefined);
  await agent.run("three");
  assert.deepEqual(texts(session.getState().messages).slice(1), ["b", "three", "c"]);
  const [summary, b] = session.getState().messages;
  assert.equal(isSummary(summary), true);
  assert.equal(isSummary(b), false);
  cancel = true;
  let done: unknown[] | undefined;
  await agent.ctx.emit("compact_request", {
    done: (...args) => {
      done = args;
    },
  });
  assert.deepEqual(done, [undefined, "Compaction cancelled by a plugin"]);
  assert.deepEqual(seen, [
    ["one", "x".repeat(800), "two", "b"],
    // after the previous summary
    ["b", "three", "c"],
  ]);
});

test("a session compacted with an external summary still replays with that plugin uninstalled", async (t) => {
  const external: Plugin = {
    on: {
      compact: (p) => {
        p.summary = "external";
      },
    },
  };
  const { agent, session, command } = await setup(t, [{ text: "x".repeat(800) }, { text: "b" }], {
    plugins: [{ name: "external", plugin: external }],
  });
  await agent.run("one");
  await agent.run("two");
  await command("compact")?.run("");
  await agent.close();
  const again = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: scripted([]) } } }] });
  t.after(() => again.close());
  const resumed = await openSession(session.leafId as string);
  await again.setSession(resumed, "resume");
  assert.match(texts(resumed.getState().messages)[0] ?? "", /external/);
});

test("disabledPlugins: builtin:compaction → no compaction, the runs go on", async (t) => {
  const { agent, provider, payloads, command } = await setup(t, [...longTurns, { text: "done" }], {
    config: { disabledPlugins: ["builtin:compaction"] },
  });
  await agent.run("hi");
  const end = await agent.run("next");
  assert.equal(payloads("compacted").length, 0);
  assert.equal(command("compact"), undefined);
  assert.deepEqual(texts(provider.requests[2]?.messages), ["hi", "", big, "a2", "next"]);
  assert.deepEqual(texts(end?.messages).at(-1), "done");
});

test("config compaction.enabled: false stops automatic compaction, not /compact", async (t) => {
  const { agent, payloads, command } = await setup(t, [...longTurns, { text: "done" }, { text: "S" }], {
    config: { compaction: { enabled: false, reserve: 200, keepRecent: 100 } },
  });
  await agent.run("hi");
  await agent.run("next");
  assert.equal(payloads("compacted").length, 0);
  await command("compact")?.run("");
  assert.equal(payloads("compacted").length, 1);
});

const kinds = (messages: readonly Message[]) =>
  messages.map((m) => (m.role === "user" ? (m.meta?.type ?? "user") : m.role));

test("a handler moving firstKeptId onto a tool message keeps its call too", async (t) => {
  let session: { getState: () => { messages: readonly Message[] } } | undefined;
  const mover: Plugin = {
    on: {
      compact: (p) => {
        p.firstKeptId = session?.getState().messages[2]?.entryId;
        p.summary = "s";
      },
    },
  };
  const setupped = await setup(t, [...longTurns, { text: "done" }], { plugins: [{ name: "mover", plugin: mover }] });
  session = setupped.session;
  await setupped.agent.run("hi");
  assert.deepEqual(kinds(setupped.session.getState().messages), ["user", "assistant", "tool", "assistant"]);
  await setupped.command("compact")?.run("");
  assert.deepEqual(kinds(setupped.session.getState().messages), ["summary", "assistant", "tool", "assistant"]);
  await setupped.agent.run("next");
  assert.deepEqual(kinds(setupped.provider.requests[2]?.messages ?? []), [
    "summary",
    "assistant",
    "tool",
    "assistant",
    "user",
  ]);
});

test("/compact keeping nothing while parallel calls run keeps their reply, so their results have their calls", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let started = 0;
  const slow = tool({
    name: "slow",
    description: "Waits",
    inputSchema: z.object({}),
    execute: async () => {
      started++;
      await gate;
      return "r";
    },
  });
  const keepNothing: Plugin = {
    tools: [slow],
    on: {
      compact: (p) => {
        p.firstKeptId = undefined;
        p.summary = "s";
      },
    },
  };
  const { agent, provider, session, command } = await setup(
    t,
    [
      {
        toolCalls: [
          { id: "1", name: "slow", input: {} },
          { id: "2", name: "slow", input: {} },
        ],
      },
      { text: "done" },
    ],
    { plugins: [{ name: "keep-nothing", plugin: keepNothing }] },
  );
  const running = agent.run("go");
  await until(() => started === 2);
  assert.equal(await command("compact")?.run(""), undefined);
  release();
  await running;
  assert.deepEqual(kinds(session.getState().messages), ["summary", "assistant", "tool", "assistant"]);
  assert.deepEqual(kinds(provider.requests[1]?.messages ?? []), ["summary", "assistant", "tool"]);
});

test("a small window: keepRecent is fitted to it, so a compaction doesn't leave the context over the threshold", async (t) => {
  const { agent, provider, payloads } = await setup(
    t,
    [
      { text: "A".repeat(1600) },
      { text: "B".repeat(1600), usage: usage(900) },
      { text: "S" },
      { text: "C".repeat(800) },
      { text: "done" },
    ],
    { config: { compaction: { reserve: 200, keepRecent: 600 } } },
  );
  await agent.run("a");
  await agent.run("b");
  await agent.run("c");
  const end = await agent.run("d");
  assert.equal(payloads("compacted").length, 1);
  assert.deepEqual(texts(provider.requests[3]?.messages).slice(1), ["B".repeat(1600), "c"]);
  assert.deepEqual(texts(end?.messages).at(-1), "done");
});

test("/compact during a run: the reply to the request sent before it doesn't trigger another", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { agent, provider, payloads, command } = await setup(t, [
    { text: "x".repeat(800) },
    async () => {
      await gate;
      return { text: "b".repeat(800), usage: usage(900) };
    },
    { text: "S" },
    () => {
      throw new Error("boom");
    },
    { text: "done" },
  ]);
  await agent.run("one");
  const running = agent.run("two");
  await until(() => provider.requests.length === 2);
  assert.equal(await command("compact")?.run(""), undefined);
  release();
  await running;
  // a request failing without a reply leaves the usage stale
  await assert.rejects(agent.run("three"), /boom/);
  const end = await agent.run("four");
  assert.equal(payloads("compacted").length, 1);
  assert.deepEqual(texts(end?.messages).at(-1), "done");
});

test("an unknown window: the summary call gets the newest part of the conversation, at most half what overflowed", async (t) => {
  const overflow = () => {
    throw Object.assign(new Error("prompt is too long"), { status: 400 });
  };
  const { agent, provider, payloads } = await setup(
    t,
    [
      { text: "x".repeat(4000) },
      { text: "y", usage: { input: 1010, output: 1, cacheRead: 0 } },
      overflow,
      { text: "S" },
      { text: "ok" },
    ],
    { window: 0 },
  );
  await agent.run("first");
  await agent.run("second");
  const end = await agent.run("t".repeat(800));
  assert.equal(payloads("compacted")[0]?.reason, "overflow");
  assert.deepEqual(texts(end?.messages).at(-1), "ok");
  const prompt = String((provider.requests[3]?.messages[0] as { content?: string } | undefined)?.content);
  const conversation = /<conversation>\n([\s\S]*)\n<\/conversation>/.exec(prompt)?.[1] ?? "";
  // tokensBefore: 1011 + 800/4 = 1211, so at most 2422 characters (with the clip's note)
  assert.ok(conversation.length < 2500, `${conversation.length} characters`);
  assert.match(conversation, /^\[1 earlier parts left out\]\n\n\[Assistant\]: x+… \[\d+ more characters\]/);
  assert.match(conversation, /\[User\]: second\n\n\[Assistant\]: y$/);
});

test("/compact with an unknown window caps the summary call's conversation at half the estimate", async (t) => {
  const { agent, provider, command } = await setup(
    t,
    [{ text: "x".repeat(4000), usage: usage(10) }, { text: "y", usage: usage(1000) }, { text: "S" }],
    { window: 0 },
  );
  await agent.run("first");
  await agent.run("second");
  assert.equal(await command("compact")?.run(""), undefined);
  const prompt = String((provider.requests[2]?.messages[0] as { content?: string } | undefined)?.content);
  const conversation = /<conversation>\n([\s\S]*)\n<\/conversation>/.exec(prompt)?.[1] ?? "";
  // tokensBefore: 1005, so at most 2010 characters (with the clip's note)
  assert.ok(conversation.length < 2100, `${conversation.length} characters`);
});
