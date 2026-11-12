import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "@hortus/cli";
import { createAgent, openSession, tool } from "@hortus/core";
import { record, scripted, tempHome, until } from "@hortus/core/testing";
import { z } from "zod";
import { type LsRun, openRuns } from "./index.ts";

type Run = LsRun & { session_name: string };
interface Batch {
  url: string;
  headers: Headers;
  body: { post: Run[]; patch: Partial<Run>[] };
}

/** stubs LangSmith; `runs()` is every run as the server would have it (posts, then patches applied) */
function langsmith() {
  const batches: Batch[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    batches.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response("{}");
  };
  const runs = (url?: string) => {
    const byId = new Map<string, Run>();
    for (const b of batches.filter((b) => !url || b.url === url)) {
      for (const p of b.body.post) byId.set(p.id, p);
      for (const p of b.body.patch) Object.assign(byId.get(p.id as string) ?? {}, p);
    }
    return [...byId.values()];
  };
  return { batches, fetch, runs };
}

function withEnv(t: { after: (fn: () => void) => void }, env: Record<string, string>) {
  Object.assign(process.env, env);
  t.after(() => {
    for (const k of Object.keys(env)) delete process.env[k];
  });
}

const plugin = { langsmith: fileURLToPath(new URL("..", import.meta.url)) };

test("langsmith posts each run's tree (turns, LLM and tool runs) in batches, threaded by session", async (t) => {
  t.after(
    await tempHome({
      secrets: {
        scripted: { type: "scripted", apiKey: "k" },
        ls: { type: "langsmith", apiKey: "ls-key", endpoint: "http://ls.test/" },
      },
      plugins: plugin,
    }),
  );
  withEnv(t, { TRACE_TO_LANGSMITH: "true", LANGSMITH_HORTUS_PROJECT: "proj", LANGSMITH_METADATA: '{"team":"infra"}' });
  const ls = langsmith();
  // a tool that asks the model itself and reports progress, and one that fails
  const ask = tool({
    name: "ask",
    description: "",
    inputSchema: z.object({ q: z.string() }),
    execute: async (_, ctx) => {
      ctx.update({ step: 1 });
      // past the 250 ms batch delay: the runs open so far are posted, their ends patched in a later batch
      await new Promise((resolve) => setTimeout(resolve, 300));
      return (await ctx.complete({ messages: [{ role: "user", content: "inner" }] })).text;
    },
  });
  const boom = tool({
    name: "boom",
    description: "",
    inputSchema: z.object({}),
    execute: async () => {
      throw new Error("kaboom");
    },
  });
  const provider = scripted([
    {
      toolCalls: [
        { id: "c1", name: "ask", input: { q: "?" } },
        { id: "c2", name: "boom", input: {} },
      ],
    },
    { text: "inner reply" },
    { text: "done", usage: { input: 10, output: 5, cacheRead: 2, cost: 0.01 } },
    { text: "again" },
  ]);
  const agent = await createAgent({
    fetch: ls.fetch,
    provided: { "@hortus/cli": version },
    extra: [
      {
        name: "scripted",
        plugin: {
          // a context window, for the root's context_usage
          providers: {
            scripted: { create: (e, o) => ({ ...provider.create(e, o), info: async () => ({ contextWindow: 100 }) }) },
          },
          tools: [ask, boom],
        },
      },
    ],
  });
  const session = await openSession(null);
  await agent.setSession(session);
  await agent.run("hi");
  await agent.run("more");
  await agent.close();

  assert.ok(ls.batches.length >= 2);
  assert.ok(ls.batches[0]?.body.post.some((r) => r.name === "hortus agent run" && !r.end_time));
  assert.ok(ls.batches.some((b) => b.body.patch.some((r) => r.id === ls.batches[0]?.body.post[0]?.id)));
  for (const b of ls.batches) {
    assert.equal(b.url, "http://ls.test/runs/batch");
    assert.equal(b.headers.get("x-api-key"), "ls-key");
  }
  const runs = ls.runs();
  const named = (name: string) => runs.filter((r) => r.name === name);
  const [root, root2] = named("hortus agent run");
  assert.equal(runs.length, 11);
  assert.ok(runs.every((r) => r.session_name === "proj" && r.end_time));
  // threads: both roots carry the session id, numbered by user turn
  assert.equal(root?.extra.metadata.thread_id, session.id);
  assert.equal(root2?.extra.metadata.thread_id, session.id);
  assert.deepEqual([root?.extra.metadata.turn_number, root2?.extra.metadata.turn_number], [1, 2]);
  assert.equal(root?.extra.metadata.team, "infra");
  assert.equal(root?.extra.metadata.ls_integration, "hortus");
  assert.deepEqual(root?.inputs, { prompt: "hi", imageCount: 0 });
  assert.deepEqual(root?.tags, ["hortus", "coding-agent"]);
  const outMessages = root?.outputs?.messages as { role: string; content: unknown }[];
  assert.deepEqual(
    outMessages.map((m) => m.role),
    ["assistant", "tool", "tool", "assistant"],
  );
  assert.equal(root?.error, undefined);
  assert.deepEqual(root?.outputs?.context_usage, { tokens: 15, contextWindow: 100, percent: 15 });

  const inTrace = runs.filter((r) => r.trace_id === root?.id);
  assert.equal(inTrace.length, 8);
  const turn0 = inTrace.find((r) => r.name === "turn 0");
  const turn1 = inTrace.find((r) => r.name === "turn 1");
  const llms = inTrace.filter((r) => r.run_type === "llm");
  const [askRun] = named("ask");
  const [boomRun] = named("boom");
  for (const r of [turn0, turn1]) assert.equal(r?.parent_run_id, root?.id);
  // the model's tools and its first request are in turn 0; the tool's own request nests under it
  for (const r of [llms[0], askRun, boomRun]) assert.equal(r?.parent_run_id, turn0?.id);
  assert.equal(llms[1]?.parent_run_id, askRun?.id);
  assert.equal(llms[2]?.parent_run_id, turn1?.id);
  for (const r of inTrace) {
    const parent = runs.find((p) => p.id === r.parent_run_id);
    if (parent) assert.ok(r.dotted_order.startsWith(`${parent.dotted_order}.`), r.name);
    // the root's metadata is copied down
    assert.equal(r.extra.metadata.thread_id, session.id);
  }
  // LLM runs: what was sent, the reply and its usage
  const final = llms[2];
  assert.equal(final?.extra.metadata.ls_provider, "scripted");
  assert.equal(final?.extra.metadata.ls_model_name, "scripted");
  const sent = final?.inputs.messages as { role: string; tool_call_id?: string }[];
  assert.deepEqual(
    sent.map((m) => m.role),
    ["system", "user", "assistant", "tool", "tool"],
  );
  assert.equal(sent[3]?.tool_call_id, "c1");
  assert.deepEqual(final?.outputs, { messages: [{ role: "assistant", content: "done" }] });
  assert.deepEqual(final?.extra.metadata.usage_metadata, {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    input_token_details: { cache_read: 2 },
    total_cost: 0.01,
  });
  const tools = llms[0]?.inputs.tools as { function: { name: string } }[];
  assert.ok(tools.some((t) => t.function.name === "ask"));
  // tool runs: input, output, progress events, errors
  assert.deepEqual(askRun?.inputs, { toolCallId: "c1", args: { q: "?" } });
  assert.deepEqual(askRun?.outputs?.output, {
    role: "tool",
    tool_call_id: "c1",
    content: "inner reply",
    details: { step: 1 },
  });
  assert.deepEqual(askRun?.events[0]?.kwargs, { partialResult: { step: 1 } });
  assert.equal(boomRun?.error, "Tool execution failed");
  assert.match(JSON.stringify(boomRun?.outputs?.output), /kaboom/);

  assert.equal(openRuns(), 0);
  const cmd = agent.commands().find((c) => c.name === "langsmith-tracing");
  assert.match(String(await cmd?.run("")), /enabled \(project proj\)/);
});

test("langsmith ends a run cut off by exit in close, and sends to replicas with remapped ids", async (t) => {
  t.after(await tempHome({ plugins: plugin }));
  withEnv(t, {
    TRACE_TO_LANGSMITH: "1",
    LANGSMITH_HORTUS_API_KEY: "primary",
    LANGSMITH_HORTUS_PROJECT: "main",
    LANGSMITH_HORTUS_RUNS_ENDPOINTS: JSON.stringify([
      { apiUrl: "http://a.test", projectName: "main" },
      { api_url: "http://b.test", api_key: "bk", project: "copy", updates: { metadata: { replica: true } } },
    ]),
  });
  const ls = langsmith();
  // ignores the abort, so the run never reaches its run_end
  const stuck = tool({
    name: "stuck",
    description: "",
    inputSchema: z.object({}),
    execute: () => new Promise(() => {}),
  });
  const provider = scripted([{ toolCalls: [{ id: "c1", name: "stuck", input: {} }] }]);
  const agent = await createAgent({
    fetch: ls.fetch,
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [stuck] } }],
  });
  void agent.run("hi");
  await until(() => openRuns() === 1);
  await agent.close({ timeout: 50 });
  assert.equal(openRuns(), 0);

  const a = ls.runs("http://a.test/runs/batch");
  const b = ls.runs("http://b.test/runs/batch");
  assert.equal(a.length, 4);
  assert.equal(b.length, 4);
  assert.ok(ls.batches.every((x) => x.url !== "http://ls.test/runs/batch"));
  assert.equal(ls.batches.find((x) => x.url.startsWith("http://a."))?.headers.get("x-api-key"), "primary");
  assert.equal(ls.batches.find((x) => x.url.startsWith("http://b."))?.headers.get("x-api-key"), "bk");
  const rootA = a.find((r) => !r.parent_run_id);
  const rootB = b.find((r) => !r.parent_run_id);
  assert.equal(rootA?.error, "hortus shut down before run completed");
  assert.deepEqual(rootA?.outputs, { shutdown: true });
  assert.equal(a.find((r) => r.name === "stuck")?.error, "hortus shut down before the tool result");
  assert.ok(a.every((r) => r.end_time));
  // same project: same ids; another project: remapped, consistently, with the replica's updates
  assert.ok(a.some((r) => r.id === rootA?.id) && rootA?.id !== rootB?.id);
  assert.ok(b.every((r) => r.trace_id === rootB?.id && r.session_name === "copy"));
  assert.ok(b.every((r) => r.parent_run_id === undefined || b.some((p) => p.id === r.parent_run_id)));
  assert.equal(rootB?.extra.metadata.replica, true);
  assert.equal(rootA?.extra.metadata.replica, undefined);
});

test("langsmith reports the first failed batch (ctx.notify) and drops later failures quietly", async (t) => {
  t.after(
    await tempHome({
      secrets: {
        scripted: { type: "scripted", apiKey: "k" },
        ls: { type: "langsmith", apiKey: "ls-key", endpoint: "http://ls.test/" },
      },
      plugins: plugin,
    }),
  );
  withEnv(t, { TRACE_TO_LANGSMITH: "true" });
  const rec = record();
  const agent = await createAgent({
    fetch: async () => new Response("no", { status: 500 }),
    extra: [
      { name: "scripted", plugin: { providers: { scripted: scripted([{ text: "a" }, { text: "b" }]) } } },
      { name: "rec", plugin: rec },
    ],
  });
  await agent.run("one");
  await agent.close();
  await agent.run("two").catch(() => {});
  const notes = rec.events.filter((e) => e.name === "notify").map((e) => e.payload as { text: string; level: string });
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.level, "warn");
  assert.match(notes[0]?.text ?? "", /langsmith: sending runs to http:\/\/ls\.test.* failed \(HTTP 500\)/);
});

test("langsmith nests a subrun's tree under the tool call that started it", async (t) => {
  t.after(
    await tempHome({
      secrets: {
        scripted: { type: "scripted", apiKey: "k" },
        ls: { type: "langsmith", apiKey: "ls-key", endpoint: "http://ls.test/" },
      },
      plugins: plugin,
    }),
  );
  withEnv(t, { TRACE_TO_LANGSMITH: "true" });
  const ls = langsmith();
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
    fetch: ls.fetch,
    provided: { "@hortus/cli": version },
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [spawn] } }],
  });
  await agent.run("hi");
  await agent.close();
  const runs = ls.runs();
  const roots = runs.filter((r) => r.name === "hortus agent run");
  const tool_ = runs.find((r) => r.name === "spawn");
  assert.equal(roots.length, 2);
  assert.equal(roots.find((r) => r.parent_run_id)?.parent_run_id, tool_?.id);
  assert.ok(runs.every((r) => r.trace_id === tool_?.trace_id));
});

test("langsmith traces a compaction during a run as a chain under its turn", async (t) => {
  t.after(
    await tempHome({
      secrets: {
        scripted: { type: "scripted", apiKey: "k" },
        ls: { type: "langsmith", apiKey: "ls-key", endpoint: "http://ls.test/" },
      },
      plugins: plugin,
    }),
  );
  withEnv(t, { TRACE_TO_LANGSMITH: "true" });
  const ls = langsmith();
  const compactor = tool({
    name: "compactor",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      await ctx.emit("compact_request", {});
      return "compacted";
    },
  });
  const provider = scripted([
    { toolCalls: [{ id: "c", name: "compactor", input: {} }] },
    { text: "SUMMARY" },
    { text: "done" },
  ]);
  const agent = await createAgent({
    fetch: ls.fetch,
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [compactor] } }],
  });
  await agent.setSession(await openSession(null));
  await agent.run("go");
  await agent.close();
  const runs = ls.runs();
  const chain = runs.find((r) => r.name === "Context Compaction (manual)");
  const turn = runs.find((r) => r.name === "turn 0");
  assert.equal(chain?.parent_run_id, turn?.id);
  assert.deepEqual(chain?.outputs, { summary: "SUMMARY", tokensBefore: chain?.outputs?.tokensBefore });
  // the root's outputs: what the run added, the summary that replaced "go" included
  const root = runs.find((r) => r.name === "hortus agent run");
  const out = (root?.outputs as { messages: { content?: unknown }[] } | undefined)?.messages ?? [];
  assert.equal(out.length, 4);
  assert.match(JSON.stringify(out[0]), /SUMMARY/);
});

test("langsmith nests a top-level run under its embedder's (LANGSMITH_HORTUS_TRACE) and passes its tool run to bash", async (t) => {
  t.after(
    await tempHome({
      secrets: {
        scripted: { type: "scripted", apiKey: "k" },
        ls: { type: "langsmith", apiKey: "ls-key", endpoint: "http://ls.test/" },
      },
      plugins: plugin,
    }),
  );
  const trace = "11111111-1111-4111-8111-111111111111";
  const outer = "22222222-2222-4222-8222-222222222222";
  const embedder = `20260101T000000000000Z${trace}.20260101T000001000000Z${outer}`;
  withEnv(t, { TRACE_TO_LANGSMITH: "true", LANGSMITH_HORTUS_TRACE: embedder });
  const ls = langsmith();
  const provider = scripted([
    { toolCalls: [{ id: "b", name: "bash", input: { command: "echo $LANGSMITH_HORTUS_TRACE" } }] },
    { text: "done" },
  ]);
  const agent = await createAgent({
    fetch: ls.fetch,
    provided: { "@hortus/cli": version },
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }],
  });
  await agent.run("hi");
  await agent.close();
  const runs = ls.runs();
  const root = runs.find((r) => r.name === "hortus agent run");
  assert.equal(root?.parent_run_id, outer);
  assert.ok(runs.every((r) => r.trace_id === trace && r.dotted_order.startsWith(`${embedder}.`)));
  const bash = runs.find((r) => r.name === "bash");
  const echoed = provider.requests[1]?.messages.at(-1);
  assert.equal(echoed?.role === "tool" && echoed.results[0]?.output.trim(), bash?.dotted_order);
});
