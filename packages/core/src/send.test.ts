import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { createAgent } from "./agent.ts";
import type { Ctx, Events, Message, Plugin, RunEnd } from "./llm.ts";
import { tool } from "./llm.ts";
import type { LoadOptions, Named } from "./plugins.ts";
import { openSession, type PluginEntry, type SessionEntry, type SessionState } from "./session.ts";
import { record, scripted, type Turn, tempHome } from "./testing.ts";

const echo = tool({
  name: "echo",
  description: "Echoes",
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => text,
});

/** An agent on a scripted provider with `turns`, then `plugins` and a recorder, on a new current session. */
async function setup(
  t: { after: (fn: () => Promise<void>) => void },
  turns: Turn[],
  plugins: Named[] = [],
  opts: LoadOptions = {},
) {
  t.after(await tempHome());
  const provider = scripted(turns);
  const rec = record();
  const agent = await createAgent({
    ...opts,
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider }, tools: [echo] } },
      ...plugins,
      { name: "rec", plugin: rec },
    ],
  });
  const session = await openSession(null);
  await agent.setSession(session);
  const names = () =>
    rec.events.map((e) => e.name).filter((n) => n !== "skills" && n !== "init" && n !== "ready" && n !== "mcp_servers");
  const payloads = <E extends keyof Events>(name: E) =>
    rec.events.filter((e) => e.name === name).map((e) => e.payload as Events[E]);
  return { agent, provider, rec, session, names, payloads };
}

/** Each message as its text: a user's content, an assistant's text, a tool message's outputs. */
const texts = (messages: readonly Message[] = []) =>
  messages.map((m) =>
    m.role === "user" ? m.content : m.role === "assistant" ? m.text : m.results.map((r) => r.output).join(),
  );

/** Resolves once `cond` holds (checked every 5 ms), failing after 2 s. */
async function until(cond: () => boolean) {
  for (let i = 0; i < 400 && !cond(); i++) await sleep(5);
  assert.ok(cond(), "timed out");
}

const state = (key: string) => ({
  state: (e: PluginEntry, s: SessionState) => {
    s.data[key] = e.data;
  },
});

test("entry types are namespaced by plugin, and a replacer replays the types of what it replaces", async (t) => {
  const { agent, session } = await setup(
    t,
    [],
    [
      { name: "a", plugin: { entries: state("a") } },
      { name: "b", plugin: { entries: state("b") } },
    ],
    // y stands in for x, whose entries an older session has
    { pieces: [{ name: "y", version: "1.0.0", replaces: ["x"], plugin: { entries: state("y") } }] },
  );
  await session.appendEntry("a:state", 1);
  await session.appendEntry("b:state", 2);
  await session.appendEntry("x:state", 3);
  assert.deepEqual(session.getState().data, { a: 1, b: 2, y: 3 });
  const resumed = await openSession(session.leafId, undefined);
  await agent.setSession(resumed, "resume");
  assert.deepEqual(resumed.getState().data, { a: 1, b: 2, y: 3 });
});

test("request messages carry their session entryId; run saves each message as it completes", async (t) => {
  let reached = () => {};
  const second = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const { agent, session, payloads } = await setup(t, [
    { toolCalls: [{ id: "1", name: "echo", input: { text: "out" } }] },
    // the run hangs here until it is aborted
    (req) =>
      new Promise((_, reject) => {
        reached();
        req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  ]);
  const abort = new AbortController();
  const running = agent.run("hi", { signal: abort.signal });
  await second;
  // the file has what completed so far
  const lines = (await readFile(session.path ?? "", "utf8")).trim().split("\n");
  // the first run records its cwd first
  const [cwd, ...saved] = lines.map((l) => JSON.parse(l) as SessionEntry);
  assert.deepEqual(cwd, { ...cwd, type: "cwd", cwd: process.cwd() });
  assert.deepEqual(
    saved.map((e) => (e.type === "message" ? e.message.role : e.type)),
    ["user", "assistant", "tool"],
  );
  assert.ok(saved.every((e) => !(e.type === "message" && "entryId" in e.message)));
  const [, req] = payloads("request");
  assert.deepEqual(
    req?.messages.map((m) => m.entryId),
    saved.map((e) => e.id),
  );
  abort.abort();
  assert.deepEqual((await running)?.aborted, { by: "user" });
  assert.deepEqual(texts(session.getState().messages), ["hi", "", "out"]);
});

test("two concurrent runs on different sessions keep their messages apart, on plugins loaded once", async (t) => {
  const reply: Turn = async (req) => {
    await sleep(10);
    return { text: `re: ${texts(req.messages).join("|")}` };
  };
  const { agent, payloads } = await setup(t, [reply, reply]);
  const [a, b] = [await openSession(null), await openSession(null)];
  await Promise.all([agent.run("a", { session: a }), agent.run("b", { session: b })]);
  assert.deepEqual(texts(a.getState().messages), ["a", "re: a"]);
  assert.deepEqual(texts(b.getState().messages), ["b", "re: b"]);
  assert.equal(payloads("init").length, 1);
});

test("exit: the running run's run_end (aborted), then session_close(exit) ignoring cancel, then close, cut off by the timeout", async (t) => {
  const order: string[] = [];
  const plugin: Plugin = {
    on: {
      run_end: ({ aborted }) => void order.push(`run_end ${aborted?.by}`),
      session_close: (p) => {
        order.push(`session_close ${p.reason}`);
        p.cancel = true;
      },
      // never settles
      close: () => {
        order.push("close");
        return new Promise(() => {});
      },
    },
  };
  const { agent } = await setup(
    t,
    [
      (req) =>
        new Promise((_, reject) => {
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ],
    [{ name: "p", plugin }],
  );
  const running = agent.run("hi");
  await sleep(20);
  const started = Date.now();
  await agent.close({ timeout: 100 });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(order, ["run_end host", "session_close exit", "close"]);
  assert.deepEqual((await running)?.aborted, { by: "host", reason: "exit" });
  await assert.rejects(agent.run("again"), /closed/);
});

test("a run uses the session's effort unless told otherwise", async (t) => {
  const { agent, provider, session } = await setup(t, [{}, {}]);
  await session.setEffort("low");
  await agent.run("hi");
  await agent.run("hi", { effort: undefined });
  assert.deepEqual(
    provider.requests.map((r) => r.effort),
    ["low", undefined],
  );
});

test("send from run_start joins the first request and is saved before the reply", async (t) => {
  const plugin: Plugin = {
    on: {
      run_start: async (_, ctx) => {
        // every mode appends before the first request here
        await ctx.send("note", { deliver: "after" });
      },
    },
  };
  const { provider, session, agent } = await setup(t, [{ text: "ok" }], [{ name: "p", plugin }]);
  await agent.run("hi");
  assert.deepEqual(texts(provider.requests[0]?.messages), ["hi", "note"]);
  assert.deepEqual(texts(session.getState().messages), ["hi", "note", "ok"]);
  assert.equal(provider.requests.length, 1);
});

test("context during the final turn calls no model; the next run's first request has it", async (t) => {
  let sent = false;
  const plugin: Plugin = {
    on: {
      response: (_, ctx) => {
        if (sent) return;
        sent = true;
        void ctx.send("fyi");
      },
    },
  };
  const { provider, session, agent } = await setup(t, [{ text: "one" }, { text: "two" }], [{ name: "p", plugin }]);
  await agent.run("hi");
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(texts(session.getState().messages), ["hi", "one", "fyi"]);
  await agent.run("again");
  assert.deepEqual(texts(provider.requests[1]?.messages), ["hi", "one", "fyi", "again"]);
});

test("steer in the final turn_end makes one more model call in the same run", async (t) => {
  let steered: Promise<RunEnd | undefined> | undefined;
  const plugin: Plugin = {
    on: {
      turn_end: (p, ctx) => {
        // from the run's own ctx, it resolves at once
        if (p.stop && !steered) steered = ctx.send("keep going", { deliver: "steer" });
      },
    },
  };
  const { provider, agent, payloads } = await setup(t, [{ text: "one" }, { text: "two" }], [{ name: "p", plugin }]);
  const end = await agent.run("hi");
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(texts(provider.requests[1]?.messages), ["hi", "one", "keep going"]);
  assert.equal(payloads("run_start").length, 1);
  assert.equal(await steered, undefined);
  assert.deepEqual(texts(end?.messages), ["hi", "one", "keep going", "two"]);
});

test("after during a run starts a second run once it ends; idle fires once, after that one", async (t) => {
  const plugin: Plugin = {
    on: {
      response: (_, ctx) => {
        if (!ctx.session?.getState().messages.some((m) => m.role === "user" && m.content === "next"))
          void ctx.send("next", { deliver: "after" });
      },
    },
  };
  const { provider, agent, names, payloads } = await setup(
    t,
    [{ text: "one" }, { text: "two" }],
    [{ name: "p", plugin }],
  );
  await agent.run("hi");
  await until(() => names().includes("idle"));
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(texts(payloads("run_end")[1]?.messages), ["hi", "one", "next", "two"]);
  const order = names().filter((n) => ["run_start", "run_end", "idle", "input"].includes(n));
  assert.deepEqual(order, ["input", "run_start", "run_end", "input", "run_start", "run_end", "idle"]);
  assert.equal(payloads("input")[1]?.source, "p");
});

test("steer from run_end starts a run (a goal loop) with no idle between; from a preview's run_end, none, and no idle", async (t) => {
  let looped = false;
  const plugin: Plugin = {
    on: {
      run_end: ({ source }, ctx) => {
        if (source === "preview") void ctx.send("from preview", { deliver: "steer" });
        else if (!looped) {
          looped = true;
          void ctx.send("again", { deliver: "steer" });
        }
      },
    },
  };
  const { provider, agent, names, session } = await setup(
    t,
    [{ text: "one" }, { text: "two" }],
    [{ name: "p", plugin }],
  );
  await agent.run("hi");
  await until(() => names().includes("idle"));
  assert.deepEqual(
    names().filter((n) => n === "run_end" || n === "idle"),
    ["run_end", "run_end", "idle"],
  );
  assert.deepEqual(texts(session.getState().messages), ["hi", "one", "again", "two"]);
  await agent.ctx.preview(session.getState().messages);
  await sleep(30);
  assert.equal(provider.requests.length, 2);
  assert.equal(names().filter((n) => n === "idle").length, 1);
  assert.equal(names().filter((n) => n === "input").length, 2);
});

test("steer with a model when idle runs on it and resolves with its run_end; the next plain run is back on the session's", async (t) => {
  const { provider, agent } = await setup(t, [{ text: "one" }, { text: "two" }]);
  const end = await agent.ctx.send("hi", { deliver: "steer", model: "m2" });
  assert.deepEqual(texts(end?.messages), ["hi", "one"]);
  await agent.run("again");
  assert.deepEqual(
    provider.requests.map((r) => r.model),
    ["m2", "scripted"],
  );
});

test("a host ctx kept from init targets the current session from a timer; after close, send throws", async (t) => {
  let host: Ctx | undefined;
  const plugin: Plugin = {
    on: {
      init: (_, ctx) => {
        host = ctx;
      },
    },
  };
  const { agent, session } = await setup(t, [{ text: "one" }, { text: "two" }], [{ name: "p", plugin }]);
  await agent.run("a");
  await agent.run("b");
  const next = await openSession(null);
  await agent.setSession(next, "new");
  await new Promise<void>((resolve) => setTimeout(() => void host?.send("ping").then(() => resolve()), 10));
  assert.deepEqual(texts(next.getState().messages), ["ping"]);
  assert.equal(host?.session, next);
  assert.equal(session.getState().messages.length, 4);
  await agent.close();
  await assert.rejects(async () => host?.send("late"), /closed/);
});

test("input: handled starts no run, a rewrite (text or meta) is what's saved, and a starting send fires it with its source", async (t) => {
  const plugin: Plugin = {
    on: {
      input: (p) => {
        if (p.text === "skip") p.handled = true;
        if (p.text === "rewrite") p.text = "rewritten";
        if (p.meta) p.meta = { ...p.meta, details: { edited: true } };
      },
    },
  };
  const { provider, agent, session, payloads } = await setup(
    t,
    [{ text: "one" }, { text: "two" }],
    [{ name: "p", plugin }],
  );
  assert.equal(await agent.run("skip"), undefined);
  assert.equal(provider.requests.length, 0);
  await agent.run("rewrite");
  assert.deepEqual(texts(session.getState().messages), ["rewritten", "one"]);
  await agent.ctx.send(
    { content: "from afar", meta: { plugin: "remote", type: "msg" } },
    { deliver: "steer", source: "remote" },
  );
  assert.deepEqual(
    payloads("input").map((p) => [p.text, p.source, p.meta?.type]),
    [
      ["skip", "user", undefined],
      ["rewritten", "user", undefined],
      ["from afar", "remote", "msg"],
    ],
  );
  const sent = session.getState().messages.at(-2);
  assert.deepEqual(sent?.role === "user" && sent.meta, { plugin: "remote", type: "msg", details: { edited: true } });
});

test("ctx.run has the model's info and who started the run; turn_start counts the run's turns", async (t) => {
  const seen: unknown[] = [];
  const plugin: Plugin = {
    providers: {
      scripted: {
        wrap: (Default) => ({
          create: (e, o) => ({ ...Default.create(e, o), info: async () => ({ contextWindow: 1000 }) }),
        }),
      },
    },
    on: {
      run_start: (_, ctx) => void seen.push([ctx.run?.info, ctx.run?.source]),
      turn_start: ({ index }, ctx) => void seen.push([index, ctx.run?.source]),
    },
  };
  const { agent } = await setup(
    t,
    [{ toolCalls: [{ id: "1", name: "echo", input: { text: "x" } }] }, { text: "done" }, { text: "again" }],
    [{ name: "p", plugin }],
  );
  await agent.run("hi");
  await agent.ctx.send("more", { deliver: "steer", source: "remote" });
  assert.deepEqual(seen, [
    [{ contextWindow: 1000 }, "user"],
    [0, "user"],
    [1, "user"],
    [{ contextWindow: 1000 }, "remote"],
    [0, "remote"],
  ]);
});

test("a host ctx's abort and busy cover only its session's runs", async (t) => {
  const hang: Turn = (req) =>
    new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  const { agent, session } = await setup(t, [hang, hang]);
  const other = await openSession(null);
  const here = agent.run("a");
  const there = agent.run("b", { session: other });
  await until(() => agent.ctx.busy());
  await sleep(10);
  agent.ctx.abort("stop");
  assert.deepEqual((await here)?.aborted, { by: "host", reason: "stop" });
  assert.equal(agent.ctx.busy(), false);
  // the other session's run goes on, until the host ctx follows it there
  await agent.setSession(other);
  assert.equal(agent.ctx.busy(), true);
  agent.ctx.abort();
  assert.deepEqual((await there)?.aborted, { by: "host" });
  assert.notEqual(session, other);
});

test("awaiting a steer or after from a tool of the same run doesn't hang: it resolves at once", async (t) => {
  const sent: (RunEnd | undefined)[] = [];
  const later = tool({
    name: "later",
    description: "Sends",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      sent.push(await ctx.send("after it", { deliver: "after" }), await ctx.send("steered", { deliver: "steer" }));
      return "done";
    },
  });
  const { provider, agent, names } = await setup(
    t,
    [{ toolCalls: [{ id: "1", name: "later", input: {} }] }, { text: "a" }, { text: "b" }],
    [{ name: "p", plugin: { tools: [later] } }],
  );
  await agent.run("go");
  await until(() => names().includes("idle"));
  assert.deepEqual(sent, [undefined, undefined]);
  assert.deepEqual(texts(provider.requests[1]?.messages), ["go", "", "done", "steered"]);
  assert.deepEqual(texts(provider.requests[2]?.messages).at(-1), "after it");
});

test("a steer from outside a run that is still starting waits for its first turn boundary", async (t) => {
  let started = () => {};
  const starting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let go = () => {};
  const gate = new Promise<void>((resolve) => {
    go = resolve;
  });
  const plugin: Plugin = {
    on: {
      run_start: async () => {
        started();
        await gate;
      },
    },
  };
  const { provider, agent } = await setup(t, [{ text: "one" }, { text: "two" }], [{ name: "p", plugin }]);
  const running = agent.run("hi");
  await starting;
  const steered = agent.ctx.send("outside", { deliver: "steer" });
  go();
  const end = await running;
  assert.deepEqual(texts(provider.requests[0]?.messages), ["hi"]);
  assert.deepEqual(texts(provider.requests[1]?.messages), ["hi", "one", "outside"]);
  assert.equal(await steered, end);
});

test("calls left unanswered anywhere in the session are answered as interrupted in requests only, not in the file", async (t) => {
  const plugin: Plugin = {
    on: {
      input: async (_, ctx) => {
        await ctx.send("from input");
      },
    },
  };
  const { provider, agent, session } = await setup(t, [{ text: "ok" }], [{ name: "p", plugin }]);
  await session.append([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      text: "",
      toolCalls: [
        { id: "c1", name: "echo", input: { text: "x" } },
        { id: "c2", name: "echo", input: { text: "y" } },
      ],
    },
    { role: "tool", results: [{ id: "c1", output: "x" }] },
    { role: "assistant", text: "", toolCalls: [{ id: "c3", name: "echo", input: { text: "z" } }] },
  ]);
  const resumed = await openSession(session.leafId);
  await agent.setSession(resumed, "resume");
  // user messages after the dangling one: an idle send, then one from the run's own input handler
  await agent.ctx.send("while idle");
  await agent.run("continue");
  const interrupted = (id: string) => ({ id, output: "Interrupted", isError: true });
  const [req] = provider.requests;
  assert.deepEqual(texts(req?.messages), [
    "hi",
    "",
    "x,Interrupted",
    "",
    "Interrupted",
    "while idle",
    "from input",
    "continue",
  ]);
  assert.deepEqual(req?.messages[2], { role: "tool", results: [{ id: "c1", output: "x" }, interrupted("c2")] });
  assert.deepEqual(req?.messages[4], { role: "tool", results: [interrupted("c3")] });
  const saved = (await openSession(resumed.leafId)).getState().messages;
  assert.deepEqual(texts(saved), ["hi", "", "x", "", "while idle", "from input", "continue", "ok"]);
});

test("tool results answering no call of the message before are left out of requests, not the file", async (t) => {
  const { provider, agent, session } = await setup(t, [{ text: "ok" }]);
  await session.append([
    { role: "user", content: "summary" },
    { role: "tool", results: [{ id: "gone", output: "orphan" }] },
    { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "echo", input: { text: "x" } }] },
    {
      role: "tool",
      results: [
        { id: "c1", output: "x" },
        { id: "gone2", output: "orphan" },
      ],
    },
  ]);
  await agent.run("continue");
  assert.deepEqual(texts(provider.requests[0]?.messages), ["summary", "", "x", "continue"]);
  assert.deepEqual(texts(session.getState().messages), ["summary", "orphan", "", "x,orphan", "continue", "ok"]);
});

test("consecutive tool messages after one assistant message merge, orphans left out, open calls interrupted", async (t) => {
  const { provider, agent, session } = await setup(t, [{ text: "ok" }]);
  await session.append([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      text: "",
      toolCalls: [
        { id: "c1", name: "echo", input: { text: "x" } },
        { id: "c2", name: "echo", input: { text: "y" } },
        { id: "c3", name: "echo", input: { text: "z" } },
      ],
    },
    {
      role: "tool",
      results: [
        { id: "c1", output: "x" },
        { id: "gone", output: "orphan" },
      ],
    },
    { role: "tool", results: [{ id: "c2", output: "y" }] },
  ]);
  await agent.run("continue");
  assert.deepEqual(provider.requests[0]?.messages[2], {
    role: "tool",
    results: [
      { id: "c1", output: "x" },
      { id: "c2", output: "y" },
      { id: "c3", output: "Interrupted", isError: true },
    ],
  });
  assert.deepEqual(texts(provider.requests[0]?.messages), ["hi", "", "x,y,Interrupted", "continue"]);
});

test("run_end.messages is the session's messages, a send made without awaiting it included once", async (t) => {
  const plugin: Plugin = {
    on: {
      run_start: (_, ctx) => {
        void ctx.send("note");
      },
    },
  };
  const { provider, session, agent } = await setup(t, [{ text: "ok" }], [{ name: "p", plugin }]);
  const end = await agent.run("hi");
  assert.deepEqual(texts(provider.requests[0]?.messages), ["hi", "note"]);
  assert.deepEqual(texts(end?.messages), ["hi", "note", "ok"]);
  assert.deepEqual(end?.messages, session.getState().messages);
});

test("a second run on a session waits for the first to end; idle fires once, after both", async (t) => {
  const slow = tool({
    name: "slow",
    description: "Slow",
    inputSchema: z.object({}),
    execute: async () => {
      await sleep(30);
      return "done";
    },
  });
  const { provider, agent, session, payloads } = await setup(
    t,
    [{ toolCalls: [{ id: "1", name: "slow", input: {} }] }, { text: "a-final" }, { text: "b-reply" }],
    [{ name: "slow", plugin: { tools: [slow] } }],
  );
  const a = agent.run("A");
  await until(() => provider.requests.length === 1);
  const b = agent.run("B");
  await Promise.all([a, b]);
  assert.deepEqual(
    provider.requests.map((r) => texts(r.messages)),
    [["A"], ["A", "", "done"], ["A", "", "done", "a-final", "B"]],
  );
  assert.deepEqual(texts(session.getState().messages), ["A", "", "done", "a-final", "B", "b-reply"]);
  assert.equal(payloads("idle").length, 1);
});

test("a run's next request sees messages a reducer rewrote mid-run (a compaction)", async (t) => {
  const compact = tool({
    name: "compact",
    description: "Compacts",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      await ctx.session?.appendEntry("c:compaction", "summary");
      return "compacted";
    },
  });
  const entries = {
    // keeps the assistant message whose call is running, so its result isn't split from it
    compaction: (e: PluginEntry<string>, s: SessionState) => {
      s.messages = [{ role: "user", content: e.data }, ...s.messages.slice(-1)];
    },
  };
  const { provider, agent } = await setup(
    t,
    [{ toolCalls: [{ id: "1", name: "compact", input: {} }] }, { text: "ok" }],
    [{ name: "c", plugin: { tools: [compact], entries } }],
  );
  const end = await agent.run("hi");
  assert.deepEqual(texts(provider.requests[1]?.messages), ["summary", "", "compacted"]);
  assert.deepEqual(texts(end?.messages), ["summary", "", "compacted", "ok"]);
});

test("idle on a session that isn't current: its handlers' ctx is that session, and their sends land there", async (t) => {
  let sent = false;
  const plugin: Plugin = {
    on: {
      idle: async ({ session }, ctx) => {
        assert.equal(ctx.session, session);
        if (!sent) {
          sent = true;
          await ctx.send("from idle");
        }
      },
    },
  };
  const { agent, session, payloads } = await setup(t, [{ text: "ok" }], [{ name: "p", plugin }]);
  const other = await openSession(null);
  await agent.run("hi", { session: other });
  await until(() => payloads("idle").length === 1);
  await until(() => other.getState().messages.length === 3);
  assert.deepEqual(texts(other.getState().messages), ["hi", "ok", "from idle"]);
  assert.deepEqual(session.getState().messages, []);
});

test("close: sends queued behind aborted runs resolve with undefined and start nothing", async (t) => {
  const errors: string[] = [];
  const { provider, agent } = await setup(
    t,
    [
      (req) =>
        new Promise((_, reject) => {
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ],
    [],
    { onError: (_, e) => void errors.push(e.message) },
  );
  const running = agent.run("hi");
  await until(() => provider.requests.length === 1);
  const steered = agent.ctx.send("steer", { deliver: "steer" });
  const after = agent.ctx.send("after", { deliver: "after" });
  await agent.close({ timeout: 500 });
  await running;
  assert.equal(await steered, undefined);
  assert.equal(await after, undefined);
  assert.deepEqual(errors, []);
  assert.equal(provider.requests.length, 1);
});
