import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgent, hortusDir, tool } from "@hortus/core";
import { scripted, tempHome, type Turn, until } from "@hortus/core/testing";
import { z } from "zod";
import { openRuns, type Span } from "./index.ts";

/** The tree as `name[!]` (! = closed with an error), children in brackets. */
const shape = (s: Span): string =>
  `${s.name}${s.error ? "!" : ""}${s.children.length ? `[${s.children.map(shape).join(", ")}]` : ""}`;

test("tracer writes one span tree per run, nested by parent, with failures closed with their error", async (t) => {
  t.after(await tempHome({ plugins: { tracer: fileURLToPath(new URL("..", import.meta.url)) } }));
  // a tool that asks the model itself and runs another tool
  const ask = tool({
    name: "ask",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      await ctx.complete({ messages: [{ role: "user", content: "inner" }] });
      return (await ctx.runTool({ id: "x", name: "nope", input: {} })).output;
    },
  });
  // the third request has no turn left: the provider fails
  const provider = scripted([{ toolCalls: [{ id: "c1", name: "ask", input: {} }] }, { text: "inner reply" }]);
  const agent = await createAgent({
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [ask] } }],
  });
  await assert.rejects(agent.run("hi"), /no turn left/);

  const lines = (await readFile(join(hortusDir(), "traces.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const root = JSON.parse(lines[0] as string) as Span;
  assert.equal(shape(root), "run![request, tool ask[request, tool nope!], request!]");
  assert.match(root.error ?? "", /no turn left/);
  assert.match(root.children[2]?.error ?? "", /no turn left/);
  assert.equal(root.children[1]?.children[1]?.id, "c1/1");
  const all = (s: Span): Span[] => [s, ...s.children.flatMap(all)];
  for (const s of all(root)) assert.ok(s.end !== undefined && s.end >= s.start, s.name);
});

test("tracer writes a run still open at exit in close, its open spans ended then, and keeps no state", async (t) => {
  t.after(await tempHome({ plugins: { tracer: fileURLToPath(new URL("..", import.meta.url)) } }));
  // ignores the abort, so the run never reaches its run_end
  const stuck = tool({
    name: "stuck",
    description: "",
    inputSchema: z.object({}),
    execute: () => new Promise(() => {}),
  });
  const provider = scripted([{ toolCalls: [{ id: "c1", name: "stuck", input: {} }] }]);
  const agent = await createAgent({
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [stuck] } }],
  });
  void agent.run("hi");
  await until(() => openRuns() === 1);
  await agent.close({ timeout: 50 });
  assert.equal(openRuns(), 0);
  const [line] = (await readFile(join(hortusDir(), "traces.jsonl"), "utf8")).trim().split("\n");
  const root = JSON.parse(line ?? "{}") as Span;
  assert.equal(shape(root), "run[request, tool stuck]");
  assert.equal(root.attrs?.exit, true);
  const all = (s: Span): Span[] => [s, ...s.children.flatMap(all)];
  for (const s of all(root)) assert.ok(s.end !== undefined && s.end >= s.start, s.name);
});

test("tracer nests a subrun's spans under the tool call that started it, in its parent's tree", async (t) => {
  t.after(await tempHome({ plugins: { tracer: fileURLToPath(new URL("..", import.meta.url)) } }));
  const spawn = tool({
    name: "spawn",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => (await ctx.subrun("task").done)?.messages.length,
  });
  const provider = scripted([
    { toolCalls: [{ id: "s", name: "spawn", input: {} }] },
    { toolCalls: [{ id: "r", name: "nope", input: {} }] },
    { text: "child done" },
    { text: "parent done" },
  ]);
  const agent = await createAgent({
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [spawn] } }],
  });
  await agent.run("hi");
  const lines = (await readFile(join(hortusDir(), "traces.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const root = JSON.parse(lines[0] as string) as Span;
  assert.equal(shape(root), "run[request, tool spawn[run[request, tool nope!, request]], request]");
  assert.equal(openRuns(), 0);
});

test("tracer writes a subrun that outlives its parent once, on its own, not in its parent's tree", async (t) => {
  t.after(await tempHome({ plugins: { tracer: fileURLToPath(new URL("..", import.meta.url)) } }));
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let done: Promise<unknown> | undefined;
  const spawn = tool({
    name: "spawn",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      done = ctx.subrun("task").done;
      // the child is running (its request sent) before the parent ends
      await until(() => provider.requests.length === 2);
      return "started";
    },
  });
  // the child's request (its last message the task) waits for the parent to end; the parent's second doesn't
  const reply: Turn = async (req) => {
    if (req.messages.at(-1)?.role === "user") await held;
    return { text: "done" };
  };
  const provider = scripted([{ toolCalls: [{ id: "s", name: "spawn", input: {} }] }, reply, reply]);
  const agent = await createAgent({
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [spawn] } }],
  });
  const parent = agent.run("hi");
  await parent;
  release();
  await done;
  const lines = (await readFile(join(hortusDir(), "traces.jsonl"), "utf8")).trim().split("\n");
  assert.deepEqual(
    lines.map((l) => shape(JSON.parse(l) as Span)),
    ["run[request, tool spawn, request]", "run[request]"],
  );
  assert.equal(openRuns(), 0);
});
