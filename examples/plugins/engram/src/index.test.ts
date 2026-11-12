import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { CliPlugin, ToolView } from "@hortus/cli";
import { createAgent, openSession, type Plugin, tool } from "@hortus/core";
import { scripted, tempDir, tempHome } from "@hortus/core/testing";
import { z } from "zod";
import plugin, { type BridgeClaim } from "./index.ts";

const dir = fileURLToPath(new URL("..", import.meta.url));

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** a fake Engram server behind `fetch`, refusing connections until the fake `engram serve` has run */
function fakeEngram(started: string) {
  const calls: Call[] = [];
  const ended = new Set<string>();
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "http://127.0.0.1:7437");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const { pathname } = url;
    if (!existsSync(started)) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    calls.push({ method, path: pathname + url.search, body });
    if (pathname === "/health") return json({ status: "ok", capabilities: { isolated_session_registration: true } });
    if (pathname === "/project/current")
      return json({ project: "proj", project_source: "git_remote", raw_project: "Proj" });
    if (method === "POST" && pathname === "/sessions")
      return json({ id: ended.has(body.id) && body.resume ? `${body.id}:resume:1` : body.id, status: "created" });
    const end = /^\/sessions\/(.+)\/end$/.exec(pathname);
    if (end?.[1]) {
      ended.add(decodeURIComponent(end[1]));
      return json({ status: "ended" });
    }
    if (pathname === "/prompts") return json({ id: 7, status: "saved" });
    if (pathname === "/observations") return json({ id: 42, status: "saved" });
    if (pathname === "/observations/passive") return json({ saved: 1 });
    if (pathname === "/search") return json([{ id: 42, title: "Deploy on Fridays" }]);
    if (pathname === "/context/compaction") return json({ context: "## Recent\n- Deploy on Fridays" });
    return json({ error: "not found" }, 404);
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

const PROMPT = "Remember: we deploy on Fridays <private>sk-123</private>";
const LEARNING = "## Key Learnings:\n- the workspace builds with pnpm, never npm <private>x</private>";

test("engram: starts the server, mem_* tools, prompt and passive capture, bridge, compaction recovery, resume", async (t) => {
  t.after(await tempHome({ plugins: { engram: dir } }));
  // a fake `engram` binary: `engram serve` only leaves a mark (no network, nothing downloaded runs)
  const bin = await tempDir(t);
  const started = join(bin, "started");
  await writeFile(join(bin, "engram"), `#!/bin/sh\necho "$@" > "${started}"\n`);
  await chmod(join(bin, "engram"), 0o755);
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.ENGRAM_BIN = join(bin, "engram");
  delete process.env.ENGRAM_URL;
  delete process.env.ENGRAM_PORT;

  const engram = fakeEngram(started);
  const provider = scripted([
    {
      toolCalls: [
        { id: "s", name: "mem_save", input: { title: "Deploy on Fridays", content: "We deploy on Fridays" } },
        { id: "l", name: "learn", input: {} },
      ],
    },
    { text: "Saved." },
    { text: "On Fridays." },
  ]);
  const decisions: unknown[] = [];
  const extra: Plugin = {
    providers: { scripted: provider },
    tools: [tool({ name: "learn", description: "", inputSchema: z.object({}), execute: async () => LEARNING })],
    on: {
      "engram:bridge:decision:v1": (d) => void decisions.push(structuredClone(d)),
      // an algorithmic summary, so compacting needs no model call
      compact: (e) => {
        e.summary = "## Goal\nShip on Fridays";
      },
    },
  };
  const agent = await createAgent({ fetch: engram.fetch, extra: [{ name: "scripted", plugin: extra }] });
  const session = await openSession(null);
  await agent.setSession(session);

  await agent.run(PROMPT);
  assert.equal((await readFile(started, "utf8")).trim(), "serve");
  const posts = (path: string) => engram.calls.filter((c) => c.method === "POST" && c.path === path);

  // the session is registered as an Engram session of the detected project
  assert.deepEqual(posts("/sessions")[0]?.body, {
    id: session.id,
    project: "proj",
    directory: process.cwd(),
    ownership_mode: "project_owned",
    resume: true,
    project_provenance: { source: "git_remote", directory: process.cwd(), raw_project: "Proj" },
  });
  // the prompt, redacted
  assert.equal(posts("/prompts")[0]?.body?.content, "Remember: we deploy on Fridays [REDACTED]");
  // mem_save carries the turn's captured prompt
  const save = posts("/observations")[0]?.body;
  assert.equal(save?.session_id, session.id);
  assert.equal(save?.project, "proj");
  assert.equal(save?.type, "manual");
  assert.equal(save?.current_prompt, "Remember: we deploy on Fridays [REDACTED]");
  // another tool's output is captured passively, redacted; mem_* results aren't
  const passive = posts("/observations/passive");
  assert.equal(passive.length, 1);
  assert.equal(passive[0]?.body?.source, "learn");
  assert.match(String(passive[0]?.body?.content), /never npm \[REDACTED\]$/);

  const [first] = provider.requests;
  assert.match(first?.system ?? "", /## Engram Persistent Memory — Protocol/);
  assert.ok(first?.tools.some((x) => x.name === "mem_save"));
  const tools = session.getState().messages.find((m) => m.role === "tool");
  assert.equal(
    tools?.role === "tool" && tools.results[0]?.output,
    JSON.stringify({ id: 42, status: "saved" }, null, 2),
  );
  assert.deepEqual(tools?.role === "tool" && tools.results[0]?.details, { data: { id: 42, status: "saved" } });

  // the tool chrome
  const view = {
    call: { id: "s", name: "mem_save", input: { title: "Deploy on Fridays" } },
    result: tools?.role === "tool" ? tools.results[0] : undefined,
    details: { data: { id: 42 } },
    width: 80,
  } as ToolView;
  assert.equal(
    (plugin as CliPlugin).cli?.tools?.mem_save?.text?.(view, undefined as never),
    "🧠 save “Deploy on Fridays” …\n↳ ✓ saved #42",
  );

  // a read tool, called by a host
  const search = await agent.ctx.runTool({ id: "q", name: "mem_search", input: { query: "deploy" } });
  assert.match(search.output, /Deploy on Fridays/);
  assert.ok(engram.calls.some((c) => c.path === "/search?q=deploy&project=proj"));

  // the bridge: ownership of this session's registration and of the captured prompt; foreign claims get no reply
  const claim = (c: Partial<BridgeClaim>) =>
    agent.ctx.emit("engram:bridge:claim:v1", { runtimeSessionId: session.id, nonce: "n", ...c } as BridgeClaim);
  const digest = createHash("sha256").update(PROMPT.trim()).digest("hex");
  await claim({ operation: "prompt-capture", promptDigest: digest });
  await claim({ operation: "prompt-capture", promptDigest: "0".repeat(64) });
  await claim({ operation: "session-register" });
  await claim({ operation: "session-register", runtimeSessionId: "someone-else" });
  await claim({ operation: "session-register", nonce: " " });
  assert.deepEqual(
    decisions.map((d) => [(d as { operation: string }).operation, (d as { status: string }).status]),
    [
      ["prompt-capture", "owned"],
      ["prompt-capture", "unknown"],
      ["session-register", "owned"],
    ],
  );

  // compaction: the summary is archived, and the next run starts with the recovery notice (and recent context), hidden
  await agent.ctx.emit("compact_request", {});
  const archived = posts("/observations").at(-1)?.body;
  assert.equal(archived?.topic_key, "session/compaction-recovery");
  assert.equal(archived?.content, "## Goal\nShip on Fridays");
  await agent.run("What did we decide about deploys?");
  const notice = provider.requests[2]?.messages.find((m) => m.role === "user" && m.meta?.plugin === "engram");
  assert.ok(notice?.role === "user");
  assert.equal(notice.meta?.display, false);
  assert.match(
    notice.content,
    /^## Recent\n- Deploy on Fridays\n\nCompaction recovery summary was already saved to Engram \(proj\)/,
  );
  // only once
  assert.equal(
    session.getState().messages.filter((m) => m.role === "user" && m.meta?.type === "compaction-recovery").length,
    1,
  );

  // closing ends the Engram session
  await agent.close();
  assert.equal(posts(`/sessions/${session.id}/end`).length, 1);

  // resumed later: Engram continues the ended session under a new id, which the session keeps
  const again = await createAgent({ fetch: engram.fetch, extra: [{ name: "scripted", plugin: extra }] });
  t.after(() => again.close());
  const resumed = await openSession(session.entries().at(-1)?.id ?? "");
  await again.setSession(resumed, "resume");
  await again.ctx.runTool({ id: "r", name: "mem_save", input: { title: "Later", content: "later" } });
  assert.equal(posts("/observations").at(-1)?.body?.session_id, `${session.id}:resume:1`);
  assert.deepEqual(resumed.getState().data.engram, { effectiveID: `${session.id}:resume:1`, project: "proj" });
  await again.close();
  assert.equal(posts(`/sessions/${encodeURIComponent(`${session.id}:resume:1`)}/end`).length, 1);
});
