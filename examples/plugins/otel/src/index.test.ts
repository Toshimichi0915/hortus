import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgent, type Message, tool } from "@hortus/core";
import { record, scripted, tempHome, until } from "@hortus/core/testing";
import { openRuns } from "./index.ts";
import { z } from "zod";

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  attributes: { key: string; value: Record<string, unknown> }[];
  events: { name: string }[];
  status?: { code: number; message: string };
}

const attr = (s: OtlpSpan | undefined, key: string) => {
  const v = s?.attributes.find((a) => a.key === key)?.value;
  return v && Object.values(v)[0];
};

test("otel exports each run's span tree as OTLP/JSON, with trace context in bash", async (t) => {
  t.after(await tempHome({ plugins: { otel: fileURLToPath(new URL("..", import.meta.url)) } }));
  const env = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test/",
    OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=secret",
    HORTUS_OTEL_SPAN_NAMING: "genai",
    HORTUS_OTEL_CAPTURE_CONTENT: "full",
    HORTUS_OTEL_PROPAGATE_TO_SHELL: "1",
  };
  Object.assign(process.env, env);
  t.after(() => {
    for (const k of Object.keys(env)) delete process.env[k];
  });

  const sent: { url: string; headers: Headers; body: { resourceSpans: unknown[] } }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response("{}");
  };
  // a tool that asks the model itself, and one that fails
  const ask = tool({
    name: "ask",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => (await ctx.complete({ messages: [{ role: "user", content: "inner" }] })).text,
  });
  const boom = tool({
    name: "boom",
    description: "",
    inputSchema: z.object({}),
    execute: async () => {
      throw new Error("kaboom");
    },
  });
  const usage = { input: 10, output: 5, cacheRead: 2, cost: 0.01 };
  const provider = scripted([
    {
      toolCalls: [
        { id: "c1", name: "bash", input: { command: 'echo "tp=$TRACEPARENT"' } },
        { id: "c2", name: "ask", input: {} },
        { id: "c3", name: "boom", input: {} },
      ],
    },
    { text: "inner reply" },
    { text: "done", usage },
  ]);
  const agent = await createAgent({
    fetch,
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [ask, boom] } }],
  });
  const end = await agent.run("hi");

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, "http://collector.test/v1/traces");
  assert.equal(sent[0]?.headers.get("x-api-key"), "secret");
  const rs = sent[0]?.body.resourceSpans[0] as {
    resource: { attributes: OtlpSpan["attributes"] };
    scopeSpans: { spans: OtlpSpan[] }[];
  };
  assert.equal(attr({ attributes: rs.resource.attributes } as OtlpSpan, "service.name"), "hortus");
  const spans = rs.scopeSpans[0]?.spans ?? [];
  const byName = (name: string) => spans.filter((s) => s.name === name);
  const [root] = byName("invoke_agent hortus");
  const turns = byName("hortus.turn");
  const chats = byName("chat scripted");
  const [bash] = byName("execute_tool bash");
  const [askSpan] = byName("execute_tool ask");
  const [boomSpan] = byName("execute_tool boom");
  assert.equal(spans.length, 9);
  assert.equal(turns.length, 2);
  assert.equal(chats.length, 3);
  assert.ok(spans.every((s) => s.traceId === root?.traceId));
  assert.equal(root?.parentSpanId, undefined);
  assert.equal(attr(root, "hortus.turn_count"), "2");
  assert.equal(attr(root, "hortus.tool_count"), "3");
  assert.equal(attr(root, "hortus.user_prompt"), "hi");
  for (const turn of turns) assert.equal(turn.parentSpanId, root?.spanId);
  // tools are siblings of the first request in its turn; the inner request nests under `ask`
  for (const s of [chats[0], bash, askSpan, boomSpan]) assert.equal(s?.parentSpanId, turns[0]?.spanId);
  assert.equal(chats[1]?.parentSpanId, askSpan?.spanId);
  assert.equal(chats[2]?.parentSpanId, turns[1]?.spanId);
  assert.equal(chats[2]?.kind, 3);
  assert.equal(attr(chats[2], "gen_ai.provider.name"), "scripted");
  assert.equal(attr(chats[2], "gen_ai.operation.name"), "chat");
  assert.equal(attr(chats[2], "gen_ai.usage.input_tokens"), "10");
  assert.equal(attr(chats[2], "gen_ai.usage.output_tokens"), "5");
  assert.equal(attr(chats[2], "gen_ai.usage.cache_read_input_tokens"), "2");
  assert.equal(attr(chats[2], "hortus.cost.usd"), 0.01);
  assert.match(String(attr(chats[2], "gen_ai.output.messages")), /done/);
  // the second request's input is the three tool results
  assert.deepEqual(
    chats[2]?.events.map((e) => e.name),
    ["gen_ai.tool.message", "gen_ai.tool.message", "gen_ai.tool.message", "gen_ai.assistant.message", "gen_ai.choice"],
  );
  assert.equal(boomSpan?.status?.code, 2);
  assert.equal(attr(boomSpan, "hortus.tool.is_error"), true);
  assert.equal(attr(bash, "hortus.tool.is_error"), false);

  // the shell got the bash span as its parent; the model saw only its own command's output
  const results = ((end?.messages ?? []).find((m) => m.role === "tool") as Extract<Message, { role: "tool" }>).results;
  assert.equal(results.find((r) => r.id === "c1")?.output, `tp=00-${root?.traceId}-${bash?.spanId}-01\n`);
  assert.match(String(attr(bash, "gen_ai.tool.call.arguments")), /^\{"command":"echo/);

  // a failing provider call closes its span and the run's with the error
  await assert.rejects(agent.run("again"), /no turn left/);
  const failed = (sent[1]?.body.resourceSpans[0] as typeof rs | undefined)?.scopeSpans[0]?.spans ?? [];
  assert.equal(failed.length, 3);
  for (const name of ["invoke_agent hortus", "chat scripted"]) {
    const s = failed.find((x) => x.name === name);
    assert.equal(s?.status?.code, 2, name);
    assert.match(s?.status?.message ?? "", /no turn left/);
  }
  assert.ok(failed.every((s) => s.traceId !== root?.traceId));

  // its bash wrap is optional: without builtin:bash the plugin still loads (a wrap of nothing would fail the load)
  await createAgent({ disabled: ["builtin:bash"] });
});

test("otel exports a run still open at exit in close, its spans ended then, and keeps no state", async (t) => {
  t.after(await tempHome({ plugins: { otel: fileURLToPath(new URL("..", import.meta.url)) } }));
  const sent: { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] }[] = [];
  const fetch: typeof globalThis.fetch = async (_, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}");
  };
  // ignores the abort, so the run never reaches its run_end
  const stuck = tool({
    name: "stuck",
    description: "",
    inputSchema: z.object({}),
    execute: () => new Promise(() => {}),
  });
  const provider = scripted([{ toolCalls: [{ id: "c1", name: "stuck", input: {} }] }]);
  const agent = await createAgent({
    fetch,
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [stuck] } }],
  });
  void agent.run("hi");
  await until(() => openRuns() === 1);
  await agent.close({ timeout: 50 });
  assert.equal(openRuns(), 0);
  assert.equal(sent.length, 1);
  const spans = sent[0]?.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
  assert.deepEqual(spans.map((s) => s.name).sort(), [
    "hortus.interaction",
    "hortus.llm_request",
    "hortus.tool.stuck",
    "hortus.turn",
  ]);
  assert.equal(
    attr(
      spans.find((s) => s.name === "hortus.interaction"),
      "hortus.exit",
    ),
    true,
  );
  for (const s of spans as (OtlpSpan & { endTimeUnixNano: string; startTimeUnixNano: string })[])
    assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano));
});

test("otel reports the first failed export (ctx.notify) and drops later failures quietly", async (t) => {
  t.after(await tempHome({ plugins: { otel: fileURLToPath(new URL("..", import.meta.url)) } }));
  const fetch: typeof globalThis.fetch = async () => new Response("down", { status: 503 });
  const rec = record();
  const agent = await createAgent({
    fetch,
    extra: [
      { name: "scripted", plugin: { providers: { scripted: scripted([{ text: "a" }, { text: "b" }]) } } },
      { name: "rec", plugin: rec },
    ],
  });
  await agent.run("one");
  await agent.run("two");
  const notes = () =>
    rec.events.filter((e) => e.name === "notify").map((e) => e.payload as { text: string; level: string });
  await until(() => notes().length === 1);
  await new Promise((resolve) => setTimeout(resolve, 20)); // a second (wrong) notify would land by now
  assert.equal(notes().length, 1);
  assert.equal(notes()[0]?.level, "warn");
  assert.match(notes()[0]?.text ?? "", /otel: exporting traces to .* failed \(HTTP 503\)/);
});

test("otel puts a subrun's spans in its parent's trace, under the tool call that started it", async (t) => {
  t.after(await tempHome({ plugins: { otel: fileURLToPath(new URL("..", import.meta.url)) } }));
  const sent: { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] }[] = [];
  const fetch: typeof globalThis.fetch = async (_, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}");
  };
  const spawn = tool({
    name: "spawn",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => (await ctx.subrun("task").done)?.messages.length,
  });
  const provider = scripted([
    { toolCalls: [{ id: "s", name: "spawn", input: {} }] },
    { text: "child done" },
    { text: "parent done" },
  ]);
  const agent = await createAgent({
    fetch,
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [spawn] } }],
  });
  await agent.run("hi");
  await until(() => sent.length === 2);
  const spans = sent.flatMap((b) => b.resourceSpans[0]?.scopeSpans[0]?.spans ?? []);
  const roots = spans.filter((s) => s.name === "hortus.interaction");
  const tool_ = spans.find((s) => s.name === "hortus.tool.spawn");
  assert.equal(roots.length, 2);
  const child = roots.find((s) => s.parentSpanId);
  assert.equal(child?.parentSpanId, tool_?.spanId);
  assert.ok(spans.every((s) => s.traceId === tool_?.traceId));
});
