import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgent, listSessions, openSession, type ProviderDef } from "@hortus/core";
import { spawnHortus } from "@hortus/cli/testing";
import { record, scripted, scriptedPlugin, tempHome, until } from "@hortus/core/testing";

const dir = fileURLToPath(new URL("..", import.meta.url));

interface Hit {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

const sse = (...events: object[]) =>
  events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** A model reply in Anthropic's stream format: text, or one tool call. */
function reply(content: { text: string } | { tool: string; id: string; input: object }) {
  const usage = { input_tokens: 5, output_tokens: 1 };
  const block =
    "text" in content
      ? [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content.text } },
        ]
      : [
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: content.id, name: content.tool, input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(content.input) },
          },
        ];
  return sse(
    {
      type: "message_start",
      message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage },
    },
    ...block,
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "text" in content ? "end_turn" : "tool_use" },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  );
}

const MANIFEST = {
  ok: true,
  version: "0.1.213",
  tools: {
    anthropic: [
      {
        name: "compress",
        description: "Fold a message range into a summary.",
        input_schema: { type: "object", properties: { from: { type: "string" } }, required: ["from"] },
      },
      { name: "acp_status", description: "Context usage overview.", input_schema: { type: "object", properties: {} } },
    ],
  },
};

/**
 * A fake bili proxy on localhost: its plugin endpoints, and `/bili/<upstream url>` answering model calls with `models`
 * (in order). `/upstream/...` is the provider's own endpoint, reached only by calls not routed through the proxy.
 */
async function fakeProxy(t: TestContext, models: Parameters<typeof reply>[0][] = []) {
  const hits: Hit[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = req.url ?? "";
    hits.push({ method: req.method ?? "", url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url === "/__bili/plugin/manifest") return json(MANIFEST);
    if (url === "/__bili/plugin/tool")
      return json({ ok: true, result: "folded 1-4", outcome: "applied", blocksCreated: 1 });
    if (url.startsWith("/__bili/plugin/status"))
      return json({
        contextTokens: 1000,
        contextLimit: 200000,
        inputTokens: 900,
        requests: 2,
        blocks: [{ active: true }],
      });
    if (url.startsWith("/__bili/")) return json({ ok: true });
    if (url.startsWith("/bili/") && url.endsWith("/v1/messages")) {
      const next = models.shift();
      if (!next) return json({ error: "no reply left" }, 500);
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(reply(next));
    }
    // the provider's own model lookup (not routed: it carries no conversation)
    if (url === "/upstream/v1/models/m") return json({ id: "m", max_input_tokens: 200000, max_tokens: 32000 });
    json({ error: "not found" }, 404);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise((ok) => server.close(ok)));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

const writeConfig = (config: object) =>
  writeFile(join(homedir(), ".hortus", "billion-context.json"), JSON.stringify(config));

test("routes the real anthropic provider through the proxy, stamps the conversation, runs the proxy's tools there", async (t) => {
  const proxy = await fakeProxy(t, [{ tool: "compress", id: "t1", input: { from: "1" } }, { text: "done" }]);
  t.after(
    await tempHome({
      config: { provider: "claude", model: "m" },
      secrets: { claude: { type: "anthropic", apiKey: "k", endpoint: `${proxy.base}/upstream` } },
      plugins: { "billion-context": dir },
    }),
  );
  await writeConfig({ proxy: proxy.base });
  const agent = await createAgent();
  t.after(() => agent.close());
  const session = await openSession(null);
  await agent.setSession(session);
  const end = await agent.run("fold the old part");
  assert.equal(end?.error, undefined);

  const calls = proxy.hits.filter((h) => h.url.endsWith("/v1/messages"));
  assert.equal(calls.length, 2);
  for (const c of calls) {
    // routed by the "*" wrap (which reads the plugin's config through its ctx)
    assert.equal(c.url, `/bili/${proxy.base}/upstream/v1/messages`);
    assert.equal(c.headers["x-bili-plugin"], "hortus");
    assert.equal(c.headers["x-bili-plugin-conversation"], session.id);
    assert.equal(c.headers["x-bili-plugin-model"], "m");
    assert.equal(c.headers["x-bili-plugin-context-window"], "200000");
    assert.equal(c.headers["x-bili-plugin-max-output"], "32000");
  }
  // the served tools are declared with the served schema
  const declared = (calls[0]?.body as undefined | { tools: { name: string; input_schema: unknown }[] })?.tools ?? [];
  assert.deepEqual(
    declared.find((x) => x.name === "compress")?.input_schema,
    MANIFEST.tools.anthropic[0]?.input_schema,
  );
  assert.ok(declared.some((x) => x.name === "acp_delegate"));
  // the proxy ran the call on this conversation
  const ran = proxy.hits.find((h) => h.url === "/__bili/plugin/tool");
  assert.deepEqual(ran?.body, {
    conversationId: session.id,
    tool: "compress",
    args: { from: "1" },
    toolCallId: "t1",
    nativeCaller: true,
  });
  const result = session.getState().messages.find((m) => m.role === "tool");
  assert.equal(result?.role === "tool" && result.results[0]?.output, "folded 1-4");
  assert.deepEqual(result?.role === "tool" && result.results[0]?.details, { outcome: "applied", blocksCreated: 1 });
  const info = proxy.hits.find((h) => h.url === "/__bili/plugin/runtime-info");
  assert.equal((info?.body as { conversationId?: string } | undefined)?.conversationId, session.id);

  // /acp: the proxy's status for this conversation
  const acp = agent.commands().find((c) => c.name === "acp");
  assert.equal(
    await acp?.run(""),
    "ACP status\n  context: 1.0K / 200.0K (0.5%)\n  in/out/cached: 900 / 0 / 0\n  requests: 2\n  blocks: 1 (1 active)",
  );
  assert.ok(proxy.hits.some((h) => h.url === `/__bili/plugin/status?conversationId=${session.id}`));
  // a name set on the session reaches the proxy
  await session.setName("refactor");
  await until(() => proxy.hits.some((h) => h.url === "/__bili/plugin/session-name"));
  assert.deepEqual(proxy.hits.find((h) => h.url === "/__bili/plugin/session-name")?.body, {
    conversationId: session.id,
    name: "refactor",
  });
});

test("guardrails: caps output, explains a bash timeout, warns on and then refuses identical calls", async (t) => {
  t.after(await tempHome({ plugins: { "billion-context": dir } }));
  await writeConfig({ guardrails: { maxOutputBytes: 20, bashTimeout: 1 } });
  const same = (id: string) => ({ id, name: "bash", input: { command: "echo 0123456789012345678901234567890" } });
  const provider = scripted([
    { toolCalls: [1, 2, 3, 4, 5].map((n) => same(`c${n}`)) },
    { toolCalls: [{ id: "s", name: "bash", input: { command: "sleep 5" } }] },
    { text: "ok" },
  ]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  t.after(() => agent.close());
  await agent.setSession(await openSession(null));
  await agent.run("go");
  const results = agent
    .session()
    ?.getState()
    .messages.flatMap((m) => (m.role === "tool" ? m.results : []));
  const out = results?.map((r) => r.output) ?? [];
  assert.match(out[0] ?? "", /^01234567890123456789\n\n\[ACP guardrail: output capped at 20B \(~12B dropped\)/);
  assert.doesNotMatch(out[1] ?? "", /WARNING/);
  assert.match(out[2] ?? "", /capped[\s\S]*WARNING — you have issued 3 CONSECUTIVE identical `bash` calls/);
  assert.match(out[3] ?? "", /issued 4 CONSECUTIVE/);
  assert.match(out[4] ?? "", /^\[ACP guardrail: REFUSED — you issued 5 consecutive identical `bash` calls/);
  assert.equal(results?.[4]?.isError, true);
  // bashTimeout: the call named none, so it got 1s
  assert.match(out[5] ?? "", /^Command timed out af[\s\S]*command killed after 1s[\s\S]*"timeout": 120/);
});

test("stands builtin:compaction down for a conversation the proxy owns", async (t) => {
  const proxy = await fakeProxy(t);
  t.after(await tempHome({ plugins: { "billion-context": dir } }));
  await writeConfig({ proxy: proxy.base });
  const turns = scripted([
    { text: "hi" },
    { toolCalls: [{ id: "c", name: "read", input: { path: "x" } }] },
    { text: "ok" },
  ]);
  // a 1000-token window, and a reply that nearly fills it, so the next request would compact
  const provider: ProviderDef = {
    create: (e, o) => ({ ...turns.create(e, o), info: async () => ({ contextWindow: 1000 }) }),
  };
  const usage = { input: 900, output: 10, cacheRead: 0 };
  const rec = record();
  const agent = await createAgent({
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider } } },
      {
        name: "usage",
        plugin: {
          on: {
            response: (p) => {
              if (p.assistant?.toolCalls.length) p.assistant.usage = usage;
            },
          },
        },
      },
      { name: "record", plugin: rec },
    ],
  });
  t.after(() => agent.close());
  const session = await openSession(null);
  await agent.setSession(session);
  await agent.run("hello");
  await agent.run("x".repeat(2000));
  const compact = rec.events.find((e) => e.name === "compact");
  const payload = compact?.payload as { reason: string; cancel?: boolean } | undefined;
  assert.equal(payload?.reason, "threshold");
  assert.equal(payload?.cancel, true);
  assert.ok(!session.entries().some((e) => "type" in e && e.type === "builtin:compaction:compaction"));
  // the requests went out stamped (the scripted provider ignores the headers, but they were set)
  assert.equal(turns.requests.at(-1)?.headers?.["x-bili-plugin-conversation"], session.id);
});

const tui = { kind: "tui", interactive: true } as const;

test("acp_delegate runs a headless hortus child that registers its lineage; its result comes back as a steer", async (t) => {
  const proxy = await fakeProxy(t);
  const turn = `(req) => {
    const last = req.messages.at(-1);
    if (last.role === "tool") return { text: "started" };
    if (last.content === "go") return { toolCalls: [{ id: "d", name: "acp_delegate", input: { agent: "researcher", task: "look around" } }] };
    if (last.content.startsWith("[acp_delegate")) return { text: "got it" };
    return { text: "child saw: " + req.tools.map((t) => t.name).sort().join(",") };
  }`;
  t.after(
    await tempHome({
      plugins: { "billion-context": dir, scripted: scriptedPlugin(`[...Array(5)].map(() => ${turn})`) },
    }),
  );
  await writeConfig({ proxy: proxy.base });
  const agent = await createAgent({ host: tui });
  t.after(() => agent.close());
  const session = await openSession(null);
  await agent.setSession(session);
  const end = await agent.run("go");
  const started = end?.messages.at(-2);
  const runId = (started?.role === "tool" ? started.results[0]?.output : "")?.match(/runId `(del_\w+)`/)?.[1];
  assert.ok(runId);
  const texts = () => session.getState().messages.map((m) => (m.role === "assistant" ? m.text : ""));
  await until(() => texts().includes("got it"), 20000);

  const note = session.getState().messages.find((m) => m.role === "user" && m.meta?.type === "delegate");
  const content = note?.role === "user" ? note.content : "";
  assert.match(
    content,
    new RegExp(`^\\[acp_delegate completed\\] \\*\\*researcher\\*\\* \\(runId \`${runId}\`, exit 0\\)`),
  );
  const file = content.match(/Result file: `([^`]+)`/)?.[1] ?? "";
  // the child is read-only (`--tools`) plus the proxy's tools, which it loaded itself
  assert.equal((await readFile(file, "utf8")).trim(), "child saw: acp_status,bash,compress,read");
  // and told the proxy which conversation it derives from
  const reg = proxy.hits.find((h) => h.url === "/__bili/plugin/register")?.body as Record<string, unknown>;
  assert.equal(reg.parentConversationId, session.id);
  assert.notEqual(reg.conversationId, session.id);
  // its session (`--parent`) is among this one's children, not listed at the top level
  assert.deepEqual(
    (await listSessions({ parent: session.id })).map((x) => x.id),
    [reg.conversationId],
  );
  assert.ok(!(await listSessions()).some((x) => x.id === reg.conversationId));
  const fleet = await agent
    .commands()
    .find((c) => c.name === "acp-fleet")
    ?.run("");
  assert.match(fleet ?? "", /✓ researcher · completed exit 0/);
});

test("under `hortus -p` (nobody to notify later) acp_delegate blocks and returns the child's result", async (t) => {
  const turn = `(req) => {
    const last = req.messages.at(-1);
    if (last.role === "tool") return { text: "parent saw: " + last.results[0].output.split("\\n\\n")[1] };
    if (last.content === "go") return { toolCalls: [{ id: "d", name: "acp_delegate", input: { agent: "oracle", task: "answer" } }] };
    return { text: "42" };
  }`;
  t.after(
    await tempHome({
      plugins: { "billion-context": dir, scripted: scriptedPlugin(`[...Array(3)].map(() => ${turn})`) },
    }),
  );
  const h = spawnHortus(t, ["-p", "go"]);
  assert.equal(await h.exit, 0, h.stderr());
  assert.equal(h.stdout(), "parent saw: 42\n");
});
