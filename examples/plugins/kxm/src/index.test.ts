import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgent, listSessions, openSession } from "@hortus/core";
import { record, scripted, scriptedPlugin, tempHome, until } from "@hortus/core/testing";

const dir = fileURLToPath(new URL("..", import.meta.url));
const RUN = `run_${"a".repeat(32)}`;

/** Sets env vars for one test (restored after). */
function env(vars: Record<string, string>) {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return () => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// biome-ignore lint/suspicious/noExplicitAny: the fake hub's records
type Rec = any;

/** An in-memory KXM hub behind a `fetch` (project token "tok"): agents, messages, SSE events, journals. */
function fakeHub() {
  const enc = new TextEncoder();
  const agents = new Map<string, Rec>();
  const messages = new Map<string, Rec>();
  const journal: Rec[] = [];
  let n = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const push = (agentId: string, event: unknown) =>
    agents.get(agentId)?.stream?.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
  const register = (name: string) => {
    const a = { id: `agent_${++n}`, name, key: `key_${n}`, project: "proj", online: true } as Rec;
    agents.set(a.id, a);
    return a;
  };
  const post = (from: Rec, o: Rec) => {
    const to = [...agents.values()].find((a) => a.name === o.target || a.id === o.target);
    const m: Rec = {
      id: `msg_${++n}`,
      project: "proj",
      from: from.id,
      fromName: from.name,
      to: to.id,
      toName: to.name,
      content: o.content,
      delivery: o.delivery ?? "followUp",
      hops: o.hops ?? 0,
      maxHops: o.maxHops ?? 4,
      ...(o.workflowContext && { workflowRunId: o.workflowContext.runId, workflowContext: o.workflowContext }),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      status: "queued",
    };
    messages.set(m.id, m);
    push(to.id, { type: "message", message: m });
    return m;
  };
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const { pathname: path } = new URL(String(input));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const h = (init.headers ?? {}) as Record<string, string>;
    if (path === "/health") return json({ ok: true });
    if (h.authorization !== "Bearer tok") return json({ error: "invalid auth", code: "invalid_auth" }, 401);
    if (path === "/v1/agents/register") {
      const a = register(body.name);
      Object.assign(a, { purpose: body.purpose, model: body.model });
      return json({ agent: { ...a, stream: undefined }, agentKey: a.key });
    }
    const me = agents.get(h["x-kxm-agent-id"] ?? "");
    if (!me || h["x-kxm-agent-key"] !== me.key) return json({ error: "bad identity" }, 401);
    if (path === "/v1/events") {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          me.stream = c;
          init.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
          // the hub is the durable queue: open requests are delivered again on connect
          for (const m of messages.values())
            if (m.to === me.id && (m.status === "queued" || m.status === "delivered"))
              push(me.id, { type: "message", message: m });
        },
      });
      return new Response(stream);
    }
    if (path === "/v1/agents" && method === "GET")
      return json({ agents: [...agents.values()].map((a) => ({ id: a.id, name: a.name, online: true })) });
    if (path === "/v1/messages" && method === "POST") return json({ message: post(me, body) });
    const mm = path.match(/^\/v1\/messages\/([^/]+)(?:\/(ack|reply))?$/);
    if (mm) {
      const m = messages.get(mm[1] ?? "");
      if (!m) return json({ error: "not found", code: "message_not_found" }, 404);
      if (mm[2] === "ack") m.status = "delivered";
      else if (mm[2] === "reply") {
        if (m.status !== "delivered") return json({ error: "settled" }, 409);
        m.status = "replied";
        m.reply = { content: body.content };
        push(m.from, { type: "reply", message: m });
      } else if (method === "DELETE") {
        m.status = "cancelled";
        push(m.to, { type: "cancelled", message: m });
      }
      return json({ message: m });
    }
    const jm = path.match(/^\/v1\/workflows\/([^/]+)\/journal$/);
    if (jm) {
      journal.push({ runId: jm[1], ...body });
      return json({});
    }
    if (path === `/v1/agents/${me.id}` && method === "DELETE") agents.delete(me.id);
    return json({});
  }) as typeof globalThis.fetch;
  const named = (name: string) => [...agents.values()].find((a) => a.name === name);
  return { fetch, agents, messages, journal, register, post, named };
}

const HUB = { KXM_PROJECT: "proj", KXM_AUTH_TOKEN: "tok", KXM_SERVER_URL: "http://kxm.test" };

test("kxm: an inbound peer request is a turn whose answer is the reply; a failed one is retained until a turn settles", async (t) => {
  t.after(await tempHome({ plugins: { kxm: dir } }));
  t.after(env({ ...HUB, KXM_AGENT_NAME: "planner" }));
  const hub = fakeHub();
  const peer = hub.register("peer");
  const provider = scripted([
    { toolCalls: [{ id: "s", name: "kxm_send", input: { target: "peer", content: "check the tests" } }] },
    { text: "Plan: ship it." },
    () => {
      throw new Error("429 rate limit");
    },
    { text: "recovered answer" },
  ]);
  const rec = record();
  const agent = await createAgent({
    fetch: hub.fetch,
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider } } },
      { name: "rec", plugin: rec },
    ],
  });
  t.after(() => agent.close());
  const session = await openSession(null);
  await agent.setSession(session);
  await until(() => hub.named("planner")?.stream !== undefined);
  assert.equal(hub.named("planner").model, "scripted/scripted");

  const m = hub.post(peer, { target: "planner", content: "make a plan", hops: 1, maxHops: 4 });
  await until(() => m.status === "replied");
  assert.equal(m.reply.content, "Plan: ship it.");
  const prompt = provider.requests[0]?.messages[0];
  assert.match(
    prompt?.role === "user" ? prompt.content : "",
    /^Peer request from peer \(message msg_\d+\):\n\nmake a plan\n/,
  );
  // saved as a kxm:inbound message; the tool's request continued the inbound's hop chain
  const first = session.getState().messages[0];
  assert.deepEqual(first?.role === "user" && first.meta, {
    plugin: "kxm",
    type: "inbound",
    details: { messageId: m.id, from: "peer" },
    display: true,
  });
  const sent = [...hub.messages.values()].find((x) => x.toName === "peer");
  assert.deepEqual([sent.fromName, sent.content, sent.hops, sent.maxHops], ["planner", "check the tests", 2, 4]);

  const w = hub.post(peer, {
    target: "planner",
    content: "review it",
    workflowContext: { runId: RUN, stageId: "s1", requirementKey: "review", attempt: 1 },
  });
  const notes = () => rec.events.filter((e) => e.name === "notify").map((e) => (e.payload as { text: string }).text);
  await until(() => notes().some((x) => x.startsWith(`kxm retained ${w.id} after provider_quota`)));
  assert.equal(w.status, "delivered");
  assert.deepEqual(hub.journal, [
    {
      runId: RUN,
      category: "error",
      area: "harness",
      severity: "error",
      summary: "Tool provider failed: provider_quota",
      evidence: ["tool:provider", "class:provider_quota"],
    },
  ]);
  // the next turn that settles on the session answers it
  await agent.run("try again");
  await until(() => w.status === "replied");
  assert.equal(w.reply.content, "recovered answer");

  await agent.close();
  assert.equal(hub.named("planner"), undefined);
});

test("kxm worker: each request runs in a `hortus -p --session` child (one session per workflow run), restarting on failure", async (t) => {
  // the child reports how much history it saw, its request line and its tools
  const turn = `(req) => ({ text: "saw " + req.messages.length + ": " + req.messages.at(-1).content.split("\\n")[2] + " | " + req.tools.map((x) => x.name).join(",") })`;
  t.after(await tempHome({ plugins: { kxm: dir, scripted: scriptedPlugin(`[...Array(3)].map(() => ${turn})`) } }));
  t.after(
    env({
      ...HUB,
      KXM_AGENT_NAME: "lead",
      KXM_WORKER_TOOLS: "read,kxm_send",
      // the primary fails (no such provider), so the worker restarts the request on the fallback, which stays
      KXM_WORKER_MODEL: "missing/model",
      KXM_WORKER_FALLBACK_MODELS: "scripted/scripted",
      KXM_WORKER_MIN_BACKOFF_MS: "10",
    }),
  );
  const hub = fakeHub();
  const peer = hub.register("peer");
  const rec = record();
  const agent = await createAgent({ fetch: hub.fetch, extra: [{ name: "rec", plugin: rec }] });
  t.after(() => agent.close());
  const kxm = agent.commands().find((c) => c.name === "kxm");
  assert.ok(kxm);
  assert.match((await kxm.run("worker writer Writes docs")) ?? "", /^kxm worker writer connected as agent_\d+$/);
  assert.equal(hub.named("writer").purpose, "Writes docs");

  const a = hub.post(peer, { target: "writer", content: "draft the intro" });
  const b = hub.post(peer, { target: "writer", content: "now the outro" });
  const c = hub.post(peer, {
    target: "writer",
    content: "review",
    workflowContext: { runId: RUN, stageId: "s1", requirementKey: "review", attempt: 1 },
  });
  await until(() => [a, b, c].every((m) => m.status === "replied"), 60_000);
  // the failed attempt saved the request; the restart runs on it (`-p` without a prompt), not sending it again
  assert.equal(a.reply.content, "saw 1: draft the intro | read,kxm_send");
  // the same session continued (user, assistant, user), on the fallback that worked
  assert.equal(b.reply.content, "saw 3: now the outro | read,kxm_send");
  // a workflow run gets a session of its own
  assert.equal(c.reply.content, "saw 1: review | read,kxm_send");
  const notes = rec.events.filter((e) => e.name === "notify").map((e) => (e.payload as { text: string }).text);
  assert.equal(notes.filter((x) => x.startsWith("kxm worker writer:")).length, 1);
  assert.deepEqual((await listSessions()).map((s) => s.title).sort(), [
    "kxm:proj:writer:default",
    `kxm:proj:writer:workflow:${RUN}`,
  ]);

  assert.equal(await kxm.run("workers"), "writer: idle, 0 queued");
  assert.equal(await kxm.run("stop writer"), "kxm worker writer stopped");
  assert.equal(hub.named("writer"), undefined);
});
