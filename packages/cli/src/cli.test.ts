import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Agent,
  type Command,
  type Ctx,
  createAgent,
  type Message,
  openSession,
  type Plugin,
  readTool,
  type Session,
} from "@hortus/core";
import { scripted, tempDir, tempHome, until } from "@hortus/core/testing";
import { z } from "zod";
import { cliPieces } from "./builtin/index.ts";
import { createCli, replay, runEffort, type UiState } from "./cli.ts";
import { suggest } from "./command-menu.tsx";
import { findCommand } from "./commands.ts";
import { usageLine } from "./entry.ts";

/** the ctx of an event on `session` (observers only read its session) */
const on = (session: Session) => ({ session }) as Ctx;

test("status follows the session's model and provider, and a stale resolve doesn't overwrite a newer one", async (t) => {
  const session = await openSession(null, await tempDir(t, "hortus-"));
  const resolve = async ({ model = "m0", provider = "p0" }: { model?: string; provider?: string }) => {
    // resolving "slow" finishes after a later change to "fast"
    if (model === "slow") await sleep(50);
    // m1 reports its efforts, the others don't
    const info = async (m: string) => ({ contextWindow: 1000, efforts: m === "m1" ? ["off", "high"] : undefined });
    return { name: provider, model, provider: { info } };
  };
  const agent = {
    plugins: [],
    resolve,
    run: async () => {},
    setSession: async () => true,
    ctx: { emit: async () => {} },
  } as unknown as Agent;
  const cli = await createCli(session, async () => agent);
  const status = async () => {
    await sleep(10);
    return cli.ui.getState().status;
  };
  assert.deepEqual(await status(), { name: "p0", model: "m0", window: 1000, efforts: undefined });
  await session.setModel("m1");
  assert.deepEqual(await status(), { name: "p0", model: "m1", window: 1000, efforts: ["off", "high"] });
  await session.setProvider("p1");
  assert.deepEqual(await status(), { name: "p1", model: "m1", window: 1000, efforts: ["off", "high"] });
  await session.setModel("slow");
  await session.setModel("fast");
  await until(() => cli.ui.getState().status?.model === "fast", 5000);
  await sleep(80); // the slow, stale status would land by now
  assert.deepEqual(cli.ui.getState().status, { name: "p1", model: "fast", window: 1000, efforts: undefined });
});

test("streamed deltas reach the store once a frame, and none are lost when the reply ends", async (t) => {
  const session = await openSession(null, await tempDir(t, "hortus-"));
  const ctx = on(session);
  let observer: Plugin | undefined;
  const run = async () => {
    for (const d of ["a", "b", "c"]) await observer?.on?.text?.(d, ctx);
    await sleep(60);
    await observer?.on?.text?.("d", ctx);
    // ends the reply before the "d" frame fires
    await observer?.on?.message?.({ role: "assistant", text: "abcd", toolCalls: [] }, ctx);
  };
  const resolve = async () => ({ name: "p", model: "m", provider: {} });
  const cli = await createCli(session, async (o) => {
    observer = o.extra?.[0]?.plugin;
    return {
      plugins: [],
      resolve,
      run,
      setSession: async () => true,
      ctx: { emit: async () => {} },
    } as unknown as Agent;
  });
  const lives: string[] = [];
  cli.ui.subscribe((s, prev) => {
    if (s.live !== prev.live) lives.push(s.live.text);
  });
  assert.equal(cli.submit("hi"), true);
  await until(() => lives.length === 2 && !cli.ui.getState().busy, 5000);
  assert.deepEqual(lives, ["abc", ""]);
  const last = cli.ui.getState().entries.at(-1);
  assert.equal(last?.kind === "assistant" && last.text, "abcd");
});

test("a run that fails keeps its completed messages in the session, and the transcript shows the error", async (t) => {
  t.after(await tempHome());
  const session = await openSession(null);
  // the second request has no turn left: the provider fails after a tool call and its result
  const provider = scripted([{ toolCalls: [{ id: "1", name: "nope", input: {} }] }]);
  const cli = await createCli(session, (o) =>
    createAgent({ ...o, extra: [{ name: "s", plugin: { providers: { scripted: provider } } }, ...(o.extra ?? [])] }),
  );
  const idle = new Promise<void>((resolve) => cli.ui.subscribe((s, prev) => prev.busy && !s.busy && resolve()));
  cli.submit("hi");
  await idle;
  assert.deepEqual(
    session.getState().messages.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
  const last = cli.ui.getState().entries.at(-1);
  assert.match(last?.kind === "error" ? last.text : "", /no turn left/);
});

test("after response.retry the transcript shows only the retried attempt's text", async (t) => {
  t.after(await tempHome());
  const session = await openSession(null);
  let retried = false;
  const retry: Plugin = {
    on: {
      response: (r) => {
        if (!retried) r.retry = retried = true;
      },
    },
  };
  const provider = scripted([{ text: "first attempt" }, { text: "second attempt" }]);
  const cli = await createCli(session, (o) =>
    createAgent({
      ...o,
      extra: [
        { name: "s", plugin: { providers: { scripted: provider } } },
        { name: "retry", plugin: retry },
        ...(o.extra ?? []),
      ],
    }),
  );
  const idle = new Promise<void>((resolve) => cli.ui.subscribe((s, prev) => prev.busy && !s.busy && resolve()));
  cli.submit("hi");
  await idle;
  const texts = cli.ui.getState().entries.flatMap((e) => (e.kind === "assistant" ? [e.text] : []));
  assert.deepEqual(texts, ["second attempt"]);
});

test("a live call the provider ran itself shows after the text before it, with its result", async (t) => {
  t.after(await tempHome());
  const session = await openSession(null);
  const result = { id: "s1", output: "found" };
  const provider = scripted([{ text: "searching", toolCalls: [{ id: "s1", name: "web_search", input: {}, result }] }]);
  const cli = await createCli(session, (o) =>
    createAgent({ ...o, extra: [{ name: "s", plugin: { providers: { scripted: provider } } }, ...(o.extra ?? [])] }),
  );
  const idle = new Promise<void>((resolve) => cli.ui.subscribe((s, prev) => prev.busy && !s.busy && resolve()));
  cli.submit("hi");
  await idle;
  const shown = cli.ui
    .getState()
    .entries.flatMap((e) => (e.kind === "assistant" ? [e.text] : e.kind === "tool" ? [e.result?.output] : []));
  assert.deepEqual(shown, ["searching", "found"]);
});

test("a run on another session draws nothing; effort set on the shown session from outside the CLI shows", async (t) => {
  t.after(await tempHome({ config: { provider: "scripted", model: "scripted", effort: "medium" } }));
  const session = await openSession(null);
  const provider = scripted([
    { text: "elsewhere", toolCalls: [{ id: "1", name: "nope", input: {} }] },
    { text: "done" },
  ]);
  // a send from run_end acts as when idle: appended to that run's session outside any run
  const late: Plugin = {
    on: {
      run_end: async (_, ctx) => {
        if (ctx.session !== session) await ctx.send("late note");
      },
    },
  };
  const cli = await createCli(session, (o) =>
    createAgent({
      ...o,
      extra: [
        { name: "s", plugin: { providers: { scripted: provider } } },
        { name: "late", plugin: late },
        ...(o.extra ?? []),
      ],
    }),
  );
  await sleep(10);
  const before = cli.ui.getState().entries;
  const other = await openSession(null);
  await cli.agent.run("other's prompt", { session: other });
  assert.equal(other.getState().messages.length, 5);
  assert.deepEqual(cli.ui.getState().entries, before);
  assert.deepEqual(cli.ui.getState().live, { thinking: "", text: "" });
  // as a plugin would, through ctx.session
  await session.setEffort("low");
  assert.equal(cli.ui.getState().effort, "low");
  await session.setEffort(undefined);
  assert.equal(cli.ui.getState().effort, "medium");
});

test("a resumed transcript shows a call the provider ran itself, with its result", () => {
  const call = { id: "s1", name: "web_search", input: { q: "x" } };
  const result = { id: "s1", output: "found" };
  const tools = replay([
    { role: "user", content: "hi" },
    { role: "assistant", text: "", toolCalls: [{ ...call, result }] },
  ]).filter((e) => e.kind === "tool");
  assert.deepEqual(
    tools.map((e) => e.kind === "tool" && { call: e.call.id, result: e.result }),
    [{ call: "s1", result }],
  );
});

test("a resumed transcript shows plugin entries after a keep-nothing compaction's summary", () => {
  const branch = [
    { type: "message", id: "m1" },
    { type: "compaction", id: "c1" },
    { type: "todo:list", id: "p1", data: { n: 1 } },
  ] as unknown as Parameters<typeof replay>[2];
  // a compaction keeping nothing: its summary (the compaction entry's id) is the only message
  const out = replay([{ role: "user", content: "summary", entryId: "c1" }], (k) => k === "todo:list", branch);
  assert.deepEqual(
    out.filter((e) => e.kind === "todo:list").map((e) => "entryId" in e && e.entryId),
    ["p1"],
  );
});

test("runs use the set effort only if the model takes it, or while its efforts are unknown", () => {
  const state = (effort: UiState["effort"], efforts?: UiState["effort"][]) =>
    ({ effort, status: { name: "p", model: "m", efforts } }) as UiState;
  assert.equal(runEffort(state("max")), "max");
  assert.equal(runEffort(state("max", ["off", "high"])), undefined);
  assert.equal(runEffort(state("high", ["off", "high"])), "high");
  assert.equal(runEffort(state(undefined, ["off", "high"])), undefined);
});

test("a tool block shows its call, then each update's details, then its result, and resumes as it ended", async (t) => {
  const session = await openSession(null, await tempDir(t, "hortus-"));
  const ctx = on(session);
  let observer: Plugin | undefined;
  let step = async () => {};
  const call = { id: "c1", name: "search", input: { q: "x" } };
  const run = async () => {
    const result = { id: "c1", output: "found", details: { sources: 3 } };
    await observer?.on?.message?.({ role: "assistant", text: "", toolCalls: [call] }, ctx);
    await observer?.on?.tool_call?.({ call }, ctx);
    // a call the tool makes itself through ctx.runTool gets no block of its own
    await observer?.on?.tool_call?.({ call: { id: "c1/1", name: "read", input: {}, parentId: "c1" } }, ctx);
    await step();
    await observer?.on?.tool_update?.({ call, details: { progress: 0.5 } }, ctx);
    await step();
    await observer?.on?.tool_result?.({ call, result }, ctx);
    await observer?.on?.message?.({ role: "tool", results: [result] }, ctx);
    // as core saves them
    await session.append([
      { role: "assistant", text: "", toolCalls: [call] },
      { role: "tool", results: [result] },
    ]);
  };
  const resolve = async () => ({ name: "p", model: "m", provider: {} });
  const cli = await createCli(session, async (o) => {
    observer = o.extra?.[0]?.plugin;
    return {
      plugins: [],
      resolve,
      run,
      setSession: async () => true,
      ctx: { emit: async () => {} },
    } as unknown as Agent;
  });
  const blocks = () => cli.ui.getState().entries.filter((e) => e.kind === "tool");
  const seen: unknown[] = [];
  step = async () => {
    const [b] = blocks();
    seen.push(b && { result: b.result, details: b.details });
  };
  cli.submit("go");
  await sleep(20);
  assert.deepEqual(seen, [
    { result: undefined, details: undefined },
    { result: undefined, details: { progress: 0.5 } },
  ]);
  const [done] = blocks();
  assert.deepEqual(done && { call: done.call, result: done.result, details: done.details }, {
    call,
    result: { id: "c1", output: "found", details: { sources: 3 } },
    details: { sources: 3 },
  });
  assert.equal(blocks().length, 1, "updated in place, not added");
  // the result (details included) is saved, so a resumed transcript draws the block as it ended
  const [replayed] = replay(session.getState().messages).filter((e) => e.kind === "tool");
  assert.deepEqual(replayed?.details, { sources: 3 });
});

test("disabledPlugins: each cli:* piece removes its commands from the / menu; load conflicts show as error lines", async (t) => {
  const commands = (p: (typeof cliPieces)[number]) =>
    ((p.plugin.commands as Command[] | undefined) ?? []).map((c) => `/${c.name}`);
  for (const piece of cliPieces) {
    const cleanup = await tempHome({ config: { disabledPlugins: [piece.name] } });
    try {
      const session = await openSession(null, await tempDir(t, "hortus-"));
      const cli = await createCli(session, (opts) =>
        createAgent({
          ...opts,
          pieces: cliPieces,
          extra: [{ name: "dup", plugin: { tools: [readTool] } }, ...(opts.extra ?? [])],
        }),
      );
      const names = (suggest(cli.commands, "/", new Map()) ?? []).map((c) => c.value.trim());
      for (const other of cliPieces)
        for (const name of commands(other))
          assert.equal(names.includes(name), other !== piece, `${piece.name}: ${name}`);
      assert.match(
        cli.ui
          .getState()
          .entries.map((e) => (e.kind === "error" ? e.text : ""))
          .join("\n"),
        /Plugin dup provides tool read, which builtin:read already does/,
      );
    } finally {
      await cleanup();
    }
  }
});

test("the usage line totals the cost providers report", () => {
  const reply = (cost?: number) => ({
    role: "assistant" as const,
    text: "",
    toolCalls: [],
    usage: { input: 1000, output: 10, cacheRead: 0, cost },
  });
  assert.doesNotMatch(usageLine([reply()]), /\$/);
  assert.match(usageLine([reply(0.25), reply(), reply(0.5)]), / \$0\.750$/);
});

test("an idle handler awaiting the run its steer starts doesn't hang the CLI", async (t) => {
  t.after(await tempHome({ config: { provider: "scripted", model: "scripted" } }));
  const session = await openSession(null);
  let sent = false;
  let ended: unknown;
  // a goal loop: once idle, keep going and wait for that run's end
  const goal: Plugin = {
    on: {
      idle: async (_, ctx) => {
        if (sent) return;
        sent = true;
        ended = await ctx.send("continue", { deliver: "steer" });
      },
    },
  };
  const provider = scripted([{ text: "one" }, { text: "two" }]);
  const cli = await createCli(session, (o) =>
    createAgent({
      ...o,
      extra: [
        { name: "s", plugin: { providers: { scripted: provider } } },
        { name: "goal", plugin: goal },
        ...(o.extra ?? []),
      ],
    }),
  );
  await sleep(10);
  cli.submit("hi");
  await until(() => !cli.ui.getState().busy && !!ended, 5000);
  assert.ok(ended);
  assert.deepEqual(
    session.getState().messages.map((m) => (m.role === "user" ? m.content : m.role === "assistant" ? m.text : "")),
    ["hi", "one", "continue", "two"],
  );
  await cli.close();
});

test("a run a send starts on a session not shown leaves the prompt free and keeps that session's effort", async (t) => {
  t.after(await tempHome({ config: { provider: "scripted", model: "scripted", effort: "medium" } }));
  const other = await openSession(null);
  await other.setEffort("high");
  const busy: boolean[] = [];
  const provider = scripted([
    { text: "one" },
    () => {
      busy.push(cli.ui.getState().busy);
      return { text: "two" };
    },
  ]);
  // from the first run's end on `other`, a steer starts a second there
  const again: Plugin = {
    on: {
      run_end: (_, ctx) =>
        void (ctx.session === other && provider.requests.length === 1 && ctx.send("again", { deliver: "steer" })),
    },
  };
  const cli = await createCli(await openSession(null), (o) =>
    createAgent({
      ...o,
      extra: [
        { name: "s", plugin: { providers: { scripted: provider } } },
        { name: "again", plugin: again },
        ...(o.extra ?? []),
      ],
    }),
  );
  await sleep(10);
  await cli.agent.run("hi", { session: other });
  await sleep(30);
  assert.deepEqual(busy, [false]);
  assert.deepEqual(
    provider.requests.map((r) => r.effort),
    ["high", "high"],
  );
  await cli.close();
});

test("/new and /resume fire session_close then session_open; a cancelled close keeps the session; effort and name are the session's", async (t) => {
  t.after(await tempHome({ config: { provider: "scripted", model: "scripted", effort: "medium" } }));
  const seen: string[] = [];
  let keep = false;
  const lifecycle: Plugin = {
    on: {
      session_open: ({ reason }) => void seen.push(`open ${reason}`),
      session_close: (p) => {
        seen.push(`close ${p.reason}`);
        if (keep) p.cancel = true;
      },
    },
  };
  const provider = scripted([{ text: "one" }]);
  const old = await openSession(null);
  await old.setEffort("low");
  await old.setName("the old one");
  await old.append([{ role: "user", content: "hi" }]);
  const cli = await createCli(await openSession(null), (o) =>
    createAgent({
      ...o,
      pieces: cliPieces,
      extra: [
        { name: "s", plugin: { providers: { scripted: provider } } },
        { name: "life", plugin: lifecycle },
        ...(o.extra ?? []),
      ],
    }),
  );
  await sleep(10);
  // config.json's effort, until a session has its own
  assert.equal(cli.ui.getState().effort, "medium");
  const run = async (line: string) => {
    assert.equal(cli.submit(line), true);
    await sleep(30);
    const e = cli.ui.getState().entries.at(-1);
    return e?.kind === "tool" ? e.call.name : e?.text;
  };
  const candidates = (await findCommand(cli.commands, "resume")?.complete?.()) ?? [];
  assert.match(candidates[0]?.label ?? "", /the old one$/);
  await run(`/resume ${old.id}`);
  assert.equal(cli.session.path, old.path);
  assert.equal(cli.ui.getState().effort, "low");
  assert.equal(cli.agent.session(), cli.session);
  // two quick changes show once each, not again as the session's saves land
  const efforts: unknown[] = [];
  const stop = cli.ui.subscribe((s, prev) => void (s.effort !== prev.effort && efforts.push(s.effort)));
  cli.setEffort("medium");
  cli.setEffort("high");
  await sleep(10);
  stop();
  assert.deepEqual(efforts, ["medium", "high"]);
  assert.equal(cli.session.getState().effort, "high");
  await run("/new");
  assert.notEqual(cli.session.path, old.path);
  // config.json was saved with it: the new session's default
  assert.equal(cli.ui.getState().effort, "high");
  keep = true;
  const kept = cli.session;
  assert.equal(await run("/new"), "A plugin kept the current session");
  assert.equal(cli.session, kept);
  assert.equal(cli.agent.session(), kept);
  await cli.close();
  assert.deepEqual(seen, [
    "open start",
    ...["close resume", "open resume"],
    ...["close new", "open new"],
    "close new",
    "close exit",
  ]);
});

test("the usage line adds tool results' own usage to the totals", () => {
  const usage = { input: 1000, output: 10, cacheRead: 0 };
  const messages: Message[] = [
    { role: "assistant", text: "", toolCalls: [{ id: "1", name: "sub", input: {} }], usage },
    { role: "tool", results: [{ id: "1", output: "done", usage: { ...usage, input: 2000, cost: 0.5 } }] },
  ];
  assert.match(usageLine(messages), /^↑ 3\.0K ↓ 0\.0K -\/- CH 0\.0% \$0\.500$/);
});

test("subruns (depth > 0) never reach the transcript", async (t) => {
  t.after(await tempHome());
  const session = await openSession(null);
  const provider = scripted([
    { toolCalls: [{ id: "s", name: "spawn", input: {} }] },
    { text: "child says", toolCalls: [{ id: "c", name: "read", input: { path: "nope" } }] },
    { text: "child done" },
    { text: "parent done" },
  ]);
  const spawn: Plugin = {
    tools: [
      {
        name: "spawn",
        description: "",
        inputSchema: z.object({}),
        execute: async (_, ctx) => (await ctx.subrun("task").done)?.messages.length,
      },
    ],
  };
  let observer: Plugin | undefined;
  const cli = await createCli(session, (o) => {
    observer = o.extra?.[0]?.plugin;
    return createAgent({
      ...o,
      extra: [
        { name: "s", plugin: { providers: { scripted: provider } } },
        { name: "spawn", plugin: spawn },
        ...(o.extra ?? []),
      ],
    });
  });
  const idle = new Promise<void>((resolve) => cli.ui.subscribe((s, prev) => prev.busy && !s.busy && resolve()));
  cli.submit("hi");
  await idle;
  const shown = () =>
    cli.ui
      .getState()
      .entries.flatMap((e) =>
        e.kind === "tool"
          ? [`tool:${e.call.name}`]
          : e.kind === "user" || e.kind === "assistant"
            ? [e.text.trim()]
            : [],
      );
  assert.deepEqual(shown(), ["hi", "tool:spawn", "parent done"]);
  // a child's event even on the shown session is dropped
  const child = { session, run: { depth: 1 } } as Ctx;
  await observer?.on?.message?.({ role: "user", content: "from a child" }, child);
  await observer?.on?.tool_call?.({ call: { id: "x", name: "read", input: {} } }, child);
  assert.deepEqual(shown(), ["hi", "tool:spawn", "parent done"]);
});

test("the usage line adds the session's own usage (subruns outside a tool)", () => {
  const usage = { input: 1000, output: 10, cacheRead: 0 };
  assert.match(usageLine([], undefined, usage), /^↑ 1\.0K ↓ 0\.0K/);
});
