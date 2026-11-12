import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { createAgent } from "./agent.ts";
import type { Ctx, Message, Plugin, ProviderDef, RunEnd, SubRun, SubrunOptions, Usage } from "./llm.ts";
import { tool } from "./llm.ts";
import type { Named } from "./plugins.ts";
import { childDir, listSessions, memorySession, openSession } from "./session.ts";
import { scripted, type Turn, tempHome, until } from "./testing.ts";

const text = (messages: readonly Message[] = []) => {
  const m = messages.at(-1);
  return m?.role === "assistant" ? m.text : undefined;
};

/** A `spawn` tool starting a subrun with `opts` (and the input's `task`), returning its final text. */
const spawner = (opts: () => SubrunOptions = () => ({}), seen?: (h: SubRun) => void): Plugin => ({
  tools: [
    tool({
      name: "spawn",
      description: "Delegates a task",
      inputSchema: z.object({ task: z.string() }),
      execute: async ({ task }, ctx) => {
        const h = ctx.subrun(task, opts());
        seen?.(h);
        return text((await h.done)?.messages) ?? "";
      },
    }),
  ],
});

async function setup(t: { after: (fn: () => Promise<void>) => void }, turns: Turn[], plugins: Named[] = []) {
  t.after(await tempHome());
  const provider = scripted(turns);
  const agent = await createAgent({
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }, ...plugins],
  });
  const session = await openSession(null);
  await agent.setSession(session);
  return { agent, provider, session };
}

/** What each run's handlers saw: `ctx.run` at `run_start` and `run_end` payloads, by run id. */
function watcher() {
  const starts: NonNullable<Ctx["run"]>[] = [];
  const ends = new Map<string, RunEnd>();
  const plugin: Plugin = {
    on: {
      run_start: (_, ctx) => {
        if (ctx.run) starts.push(ctx.run);
      },
      run_end: (p, ctx) => {
        if (ctx.run) ends.set(ctx.run.id, p);
      },
    },
  };
  return { starts, ends, plugin };
}

test("no built-in piece reads process.cwd()", async () => {
  const dir = new URL("../src/builtin/", import.meta.url);
  for (const name of await readdir(dir))
    assert.doesNotMatch(await readFile(new URL(name, dir), "utf8"), /process\.cwd\(\)/, name);
});

test("a subrun's cwd: files and AGENTS.md relative to it; a session's cwd entry does the same and is resumed", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "hortus-cwd-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await writeFile(join(tmp, "AGENTS.md"), "TMP-AGENTS");
  await writeFile(join(tmp, "f.txt"), "in tmp");
  const read = { toolCalls: [{ id: "r", name: "read", input: { path: "f.txt" } }] };
  const { agent, provider, session } = await setup(
    t,
    [{ toolCalls: [{ id: "s", name: "spawn", input: { task: "look" } }] }, read, { text: "child" }, { text: "parent" }],
    [{ name: "spawner", plugin: spawner(() => ({ cwd: tmp })) }],
  );
  await agent.run("go");
  const [, child, childAfter, parentAfter] = provider.requests;
  assert.match(child?.system ?? "", /TMP-AGENTS/);
  assert.match(child?.system ?? "", new RegExp(`Working directory: ${tmp}\\.`));
  const res = childAfter?.messages.at(-1);
  assert.equal(res?.role === "tool" && res.results[0]?.output, "in tmp");
  assert.equal(parentAfter?.messages.at(-1)?.role, "tool");
  // the parent's own session recorded the process's cwd at its first run
  assert.equal(session.getState().cwd, process.cwd());

  // a top-level run on a session whose cwd is tmp
  const s2 = await openSession(null);
  await s2.setCwd(tmp);
  const p2 = scripted([read, { text: "a" }, read, { text: "b" }]);
  const a2 = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: p2 } } }] });
  await a2.run("go", { session: s2 });
  assert.match(p2.requests[0]?.system ?? "", /TMP-AGENTS/);
  const r1 = p2.requests[1]?.messages.at(-1);
  assert.equal(r1?.role === "tool" && r1.results[0]?.output, "in tmp");
  const resumed = await openSession(s2.leafId);
  assert.equal(resumed.getState().cwd, tmp);
  await a2.run("again", { session: resumed });
  const r2 = p2.requests[3]?.messages.at(-1);
  assert.equal(r2?.role === "tool" && r2.results[0]?.output, "in tmp");
});

test("disabling builtin:prompt leaves AGENTS.md out of the child's prompt", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "hortus-cwd-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await writeFile(join(tmp, "AGENTS.md"), "TMP-AGENTS");
  const { agent, provider } = await setup(t, [{ text: "with" }, { text: "without" }]);
  const ctx = agent.ctxOf("tester");
  await ctx.subrun("a", { cwd: tmp }).done;
  await ctx.subrun("b", { cwd: tmp, plugins: { disable: ["builtin:prompt"] } }).done;
  assert.match(provider.requests[0]?.system ?? "", /TMP-AGENTS/);
  assert.doesNotMatch(provider.requests[1]?.system ?? "", /TMP-AGENTS|Working directory/);
});

test("plugins.disable drops a plugin's tool from the child; extra adds a child-only plugin", async (t) => {
  const kidSaw: string[] = [];
  const kid: Named = {
    name: "kid",
    plugin: {
      tools: [tool({ name: "kidtool", description: "", inputSchema: z.object({}), execute: async () => "" })],
      on: { run_start: (_, ctx) => void kidSaw.push(String(ctx.run?.depth)) },
    },
  };
  const { agent, provider } = await setup(
    t,
    [{ toolCalls: [{ id: "s", name: "spawn", input: { task: "x" } }] }, { text: "child" }, { text: "parent" }],
    [{ name: "subagent", plugin: spawner(() => ({ plugins: { disable: ["subagent"], extra: [kid] } })) }],
  );
  await agent.run("go");
  const names = provider.requests.map((r) => r.tools.map((x) => x.name));
  assert.ok(names[0]?.includes("spawn") && !names[0]?.includes("kidtool"));
  assert.ok(!names[1]?.includes("spawn") && names[1]?.includes("kidtool") && names[1]?.includes("read"));
  assert.deepEqual(kidSaw, ["1"]);
});

test("a subrun reloads nothing: init, ready and mcp_servers fire once", async (t) => {
  const counts: Record<string, number> = {};
  const count = (name: string) => () => {
    counts[name] = (counts[name] ?? 0) + 1;
  };
  const { agent } = await setup(
    t,
    [{ text: "a" }, { text: "b" }],
    [{ name: "counter", plugin: { on: { init: count("init"), ready: count("ready"), mcp_servers: count("mcp") } } }],
  );
  await agent.ctxOf("tester").subrun("a").done;
  await agent.ctxOf("tester").subrun("b", { plugins: { disable: ["builtin:edit"] } }).done;
  assert.deepEqual(counts, { init: 1, ready: 1, mcp: 1 });
});

test("the handle: id before run_start, steer reaches the running child, abort names the caller, done is run_end", async (t) => {
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const w = watcher();
  let handle: SubRun | undefined;
  const idAtStart: (string | undefined)[] = [];
  const { agent, provider } = await setup(
    t,
    [
      async () => {
        await held;
        return { text: "first" };
      },
      { text: "steered" },
      (req) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    ],
    [
      { name: "w", plugin: w.plugin },
      {
        name: "starter",
        plugin: {
          on: { run_start: (_, ctx) => void idAtStart.push(handle?.id === ctx.run?.id ? "same" : handle?.id) },
          commands: [
            {
              name: "kid",
              description: "",
              run: (_, ctx) => {
                handle = ctx.subrun("hi");
              },
            },
          ],
        },
      },
    ],
  );
  await agent
    .commands()
    .find((c) => c.name === "kid")
    ?.run("");
  const h = handle as SubRun;
  await until(() => provider.requests.length === 1);
  const steered = h.send("more", { deliver: "steer" });
  release();
  const end = await h.done;
  assert.deepEqual(idAtStart, ["same"]);
  assert.equal(text(end?.messages), "steered");
  assert.deepEqual(provider.requests[1]?.messages.map((m) => m.role === "user" && m.content).filter(Boolean), [
    "hi",
    "more",
  ]);
  assert.equal(await steered, end);
  assert.equal(w.ends.get(h.id), end);
  // a command started it: a parent (the session) but no run or tool call
  const [start] = w.starts;
  assert.equal(start?.depth, 1);
  assert.deepEqual(start?.parent, { session: agent.session()?.id });

  // abort, from the caller: after it ended, a steer starts it again (as a child), which is then aborted
  const again = h.send("go on", { deliver: "steer" });
  await until(() => provider.requests.length === 3);
  h.abort("enough");
  const aborted = await again;
  assert.deepEqual(aborted?.aborted, { by: "starter", reason: "enough" });
  assert.equal(w.starts[1]?.depth, 1);
});

test("a file-backed child resumes its history, records its parent and cwd, and only lists under it", async (t) => {
  const { agent, provider, session } = await setup(t, [{ text: "one" }, { text: "two" }]);
  const ctx = agent.ctxOf("tester");
  const first = ctx.subrun("first", { session: "file" });
  await first.done;
  const kid = first.session;
  assert.ok(kid.path?.includes(session.id));
  const second = ctx.subrun("second", { session: kid });
  await second.done;
  assert.deepEqual(
    provider.requests[1]?.messages.map((m) => (m.role === "user" ? m.content : m.role === "assistant" && m.text)),
    ["first", "one", "second"],
  );
  const reopened = await openSession(kid.leafId, childDir(session.id));
  assert.equal(reopened.getState().messages.length, 4);
  assert.equal(reopened.getState().cwd, process.cwd());
  assert.ok(!(await listSessions()).some((s) => s.id === kid.id));
  assert.deepEqual(
    (await listSessions({ parent: session.id })).map((s) => s.id),
    [kid.id],
  );
  // never the caller's own session, nor one with a run in progress
  assert.throws(() => ctx.subrun("x", { session }), /new session or a child.s/);
});

test("child events carry depth 1 and the parent's ids; aborting the parent aborts the child", async (t) => {
  const w = watcher();
  let handle: SubRun | undefined;
  const { agent, session } = await setup(
    t,
    [
      { toolCalls: [{ id: "s", name: "spawn", input: { task: "x" } }] },
      (req) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    ],
    [
      { name: "spawner", plugin: spawner(undefined, (h) => (handle = h)) },
      { name: "w", plugin: w.plugin },
    ],
  );
  const abort = new AbortController();
  const run = agent.run("go", { signal: abort.signal });
  await until(() => w.starts.length === 2);
  abort.abort();
  const end = await run;
  const [parent, child] = w.starts;
  assert.equal(parent?.depth, 0);
  assert.equal(child?.depth, 1);
  assert.equal(child?.id, handle?.id);
  assert.deepEqual(child?.parent, { session: session.id, runId: parent?.id, toolCallId: "s" });
  assert.deepEqual(end?.aborted, { by: "user" });
  assert.deepEqual(w.ends.get(child?.id ?? "")?.aborted, { by: "user" });
});

test("two concurrent subruns send their own session ids through a provider wrapper", async (t) => {
  const own: Turn = (req, ctx) => ({ text: String(req.headers?.["x-session"] === ctx?.session?.id) });
  const wrap: Plugin = {
    providers: {
      scripted: {
        wrap: (D): ProviderDef => ({
          ...D,
          create: (entry, opts) => {
            const p = D.create(entry, opts);
            return {
              ...p,
              complete: (req, cb, ctx) =>
                p.complete({ ...req, headers: { ...req.headers, "x-session": ctx?.session?.id ?? "" } }, cb, ctx),
            };
          },
        }),
      },
    },
  };
  const { agent, provider } = await setup(t, [own, own], [{ name: "wrap", plugin: wrap }]);
  const ctx = agent.ctxOf("tester");
  const [a, b] = [ctx.subrun("a"), ctx.subrun("b")];
  const ends = await Promise.all([a.done, b.done]);
  assert.notEqual(a.session.id, b.session.id);
  assert.deepEqual(provider.requests.map((r) => r.headers?.["x-session"]).sort(), [a.session.id, b.session.id].sort());
  for (const end of ends) assert.equal(text(end?.messages), "true");
});

test("a child's usage is in the parent's totals once: on the calling tool's result, else the session's usage", async (t) => {
  const u = (n: number): Usage => ({ input: n, output: n, cacheRead: 0 });
  const { agent, session } = await setup(
    t,
    [
      { toolCalls: [{ id: "s", name: "spawn", input: { task: "x" } }], usage: u(1) },
      { text: "child", usage: u(10) },
      { text: "parent", usage: u(100) },
      { text: "side", usage: u(1000) },
    ],
    [{ name: "spawner", plugin: spawner() }],
  );
  await agent.run("go");
  const results = session.getState().messages.flatMap((m) => (m.role === "tool" ? m.results : []));
  assert.deepEqual(
    results.map((r) => r.usage),
    [u(10)],
  );
  assert.equal(session.getState().usage, undefined);
  await agent.ctxOf("tester").subrun("side").done;
  assert.deepEqual(session.getState().usage, u(1000));
  assert.deepEqual((await openSession(session.leafId)).getState().usage, u(1000));
});

/** A turn that waits for its request's abort, then fails. */
const hang: Turn = (req) =>
  new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted"))));

test("opts.tools holds at every call and for grandchildren: pushed tools and an unrestricted grandchild get none", async (t) => {
  const pushed = tool({ name: "pushed", description: "", inputSchema: z.object({}), execute: async () => "ran" });
  const spawn = tool({
    name: "spawn",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      const h = ctx.subrun("task", ctx.run?.depth === 0 ? { tools: ["read", "spawn"] } : {});
      return text((await h.done)?.messages) ?? "";
    },
  });
  const { agent, provider } = await setup(
    t,
    [
      { toolCalls: [{ id: "s", name: "spawn", input: {} }] },
      { toolCalls: [{ id: "p", name: "pushed", input: {} }] },
      { toolCalls: [{ id: "s2", name: "spawn", input: {} }] },
      { text: "grandchild" },
      { text: "child" },
      { text: "parent" },
    ],
    [
      {
        name: "pusher",
        plugin: {
          tools: [spawn],
          // as mcp-extension does: into every running run's tools
          on: { turn_start: (_, ctx) => void (ctx.tools.some((x) => x.name === "pushed") || ctx.tools.push(pushed)) },
        },
      },
    ],
  );
  await agent.run("go");
  const names = provider.requests.map((r) => r.tools.map((x) => x.name).sort());
  assert.ok(names[0]?.includes("pushed"));
  assert.deepEqual(names[1], ["read", "spawn"]);
  assert.deepEqual(names[3], ["read", "spawn"]);
  const result = provider.requests[2]?.messages.at(-1);
  assert.equal(result?.role === "tool" && result.results[0]?.output, "Unknown tool: pushed");
});

test("subrun takes only new or child sessions, never the current one", async (t) => {
  const errors: string[] = [];
  const { agent, session } = await setup(t, [
    (_, ctx) => {
      for (const s of [session, memorySession()])
        try {
          ctx?.subrun("x", { session: s });
        } catch (e) {
          errors.push((e as Error).message);
        }
      return { text: "done" };
    },
    { text: "child" },
  ]);
  // a run on another session: the current one is still off limits
  await agent.run("go", { session: memorySession() });
  assert.deepEqual(errors, ["A subrun needs a new session or a child's, with no run in progress"]);
  // a used session that isn't a child: taking it would make all its later runs children
  const used = memorySession();
  await used.append([{ role: "user", content: "hi" }]);
  assert.throws(() => agent.ctxOf("tester").subrun("x", { session: used }), /new session or a child.s/);
});

test("aborting the caller aborts a child woken after its first run, while the caller runs", async (t) => {
  let again: Promise<RunEnd | undefined> | undefined;
  const spawn = tool({
    name: "spawn",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      const h = ctx.subrun("task");
      await h.done;
      again = h.send("again", { deliver: "steer" });
      return "ok";
    },
  });
  const { agent, provider } = await setup(
    t,
    [{ toolCalls: [{ id: "s", name: "spawn", input: {} }] }, { text: "one" }, hang, hang],
    [{ name: "spawner", plugin: { tools: [spawn] } }],
  );
  const abort = new AbortController();
  const run = agent.run("go", { signal: abort.signal });
  await until(() => provider.requests.length === 4);
  abort.abort();
  assert.deepEqual((await run)?.aborted, { by: "user" });
  assert.deepEqual((await again)?.aborted, { by: "user" });
});

test("aborting a child's first run at once ends it aborted by the caller", async (t) => {
  const { agent } = await setup(t, [hang]);
  const h = agent.ctxOf("tester").subrun("x");
  h.abort("stop");
  assert.deepEqual((await h.done)?.aborted, { by: "tester", reason: "stop" });
});

test("plugins.only keeps the host's extras' handlers and providers but not their tools", async (t) => {
  const w = watcher();
  const own = tool({ name: "own", description: "", inputSchema: z.object({}), execute: async () => "" });
  const { agent, provider } = await setup(t, [{ text: "a" }], [{ name: "w", plugin: { ...w.plugin, tools: [own] } }]);
  await agent.ctxOf("tester").subrun("x", { plugins: { only: ["builtin:read"] } }).done;
  assert.deepEqual(
    provider.requests[0]?.tools.map((x) => x.name),
    ["read"],
  );
  assert.equal(w.starts.length, 1);
});

test("a load conflict is reported once, not again by each filtered subrun", async (t) => {
  t.after(await tempHome());
  const errors: string[] = [];
  const dup = (name: string): Named => ({
    name,
    plugin: { tools: [tool({ name: "dup", description: "", inputSchema: z.object({}), execute: async () => "" })] },
  });
  const agent = await createAgent({
    extra: [
      { name: "scripted", plugin: { providers: { scripted: scripted([{ text: "a" }, { text: "b" }]) } } },
      dup("d1"),
      dup("d2"),
    ],
    onError: (_, e) => void errors.push(e.message),
  });
  const ctx = agent.ctxOf("tester");
  await ctx.subrun("x", { plugins: { disable: ["builtin:edit"] } }).done;
  await ctx.subrun("y", { plugins: { disable: ["builtin:edit"] } }).done;
  assert.equal(errors.filter((m) => m.includes("dup")).length, 1);
});

test("a restricted child's ctx.runTool can't reach a tool pushed into its tools", async (t) => {
  const pushed = tool({ name: "pushed", description: "", inputSchema: z.object({}), execute: async () => "ran" });
  const probe = tool({
    name: "probe",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      ctx.tools.push(pushed);
      return (await ctx.runTool({ id: "x", name: "pushed", input: {} })).output;
    },
  });
  const { agent, provider } = await setup(
    t,
    [
      { toolCalls: [{ id: "s", name: "spawn", input: { task: "t" } }] },
      { toolCalls: [{ id: "p", name: "probe", input: {} }] },
      { text: "child" },
      { text: "parent" },
    ],
    [
      {
        name: "spawner",
        plugin: { tools: [...(spawner(() => ({ tools: ["probe"] })).tools ?? []), probe] },
      },
    ],
  );
  await agent.run("go");
  const result = provider.requests[2]?.messages.at(-1);
  assert.equal(result?.role === "tool" && result.results[0]?.output, "Unknown tool: pushed");
});

test("a restricted child's ctx.tools holds only its allowed tools (pushed ones pruned), so codemode declares only those", async (t) => {
  const only = (name: string) =>
    tool({ name, description: "", inputSchema: z.object({}), exposure: "codemode", execute: async () => name });
  const { agent, provider } = await setup(
    t,
    [{ toolCalls: [{ id: "s", name: "spawn", input: { task: "t" } }] }, { text: "child" }, { text: "parent" }],
    [
      {
        name: "spawner",
        plugin: {
          tools: [...(spawner(() => ({ tools: ["codemode", "aa"] })).tools ?? []), only("aa")],
          // pushed into every run's tools, as mcp-extension does
          on: { turn_start: (_, ctx) => void (ctx.tools.some((x) => x.name === "bb") || ctx.tools.push(only("bb"))) },
        },
      },
    ],
  );
  await agent.run("go");
  const desc = (i: number) => provider.requests[i]?.tools.find((x) => x.name === "codemode")?.description ?? "";
  assert.match(desc(0), /bb\(input/);
  assert.match(desc(1), /aa\(input/);
  assert.doesNotMatch(desc(1), /bb\(/);
  assert.deepEqual(
    provider.requests[1]?.tools.map((x) => x.name),
    ["codemode"],
  );
});

test("a child started from a codemode script's call isn't aborted when the script ends", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const handles: SubRun[] = [];
  const spawn = tool({
    name: "spawn",
    description: "",
    inputSchema: z.object({}),
    exposure: "codemode",
    execute: async (_, ctx) => {
      handles.push(ctx.subrun("task"));
      return "started";
    },
  });
  // the child's request (its last message the task) waits until released
  const reply: Turn = async (req) => {
    const last = req.messages.at(-1);
    if (last?.role === "user" && last.content === "task") await held;
    return { text: "done" };
  };
  const code = { code: "await tools.spawn({})" };
  const { agent } = await setup(
    t,
    [{ toolCalls: [{ id: "c", name: "codemode", input: code }] }, reply, reply],
    [{ name: "p", plugin: { tools: [spawn] } }],
  );
  await agent.run("go");
  release();
  const end = await handles[0]?.done;
  assert.equal(end?.aborted, undefined);
  assert.equal(text(end?.messages), "done");
});

test("seed and input together: the child starts from the seed, and its input fires for the input", async (t) => {
  const inputs: string[] = [];
  const { agent, provider } = await setup(
    t,
    [{ text: "answer" }],
    [{ name: "w", plugin: { on: { input: (p) => void inputs.push(p.text) } } }],
  );
  const seed: Message[] = [
    { role: "user", content: "earlier" },
    { role: "assistant", text: "reply", toolCalls: [] },
  ];
  const end = await agent.ctxOf("tester").subrun("question", { seed }).done;
  assert.deepEqual(inputs, ["question"]);
  assert.deepEqual(
    provider.requests[0]?.messages.map((m) => (m.role === "user" ? m.content : m.role)),
    ["earlier", "assistant", "question"],
  );
  assert.equal(text(end?.messages), "answer");
});

test("plugin filters never drop providers: an only/disable child still has a piece's provider and its wraps", async (t) => {
  t.after(await tempHome());
  const provider = scripted([{ text: "a" }, { text: "b" }]);
  const wrap: Plugin = {
    providers: {
      scripted: {
        wrap: (D): ProviderDef => ({
          ...D,
          create: (entry, opts) => {
            const p = D.create(entry, opts);
            return { ...p, complete: (req, cb, ctx) => p.complete({ ...req, headers: { "x-wrapped": "1" } }, cb, ctx) };
          },
        }),
      },
    },
  };
  const agent = await createAgent({
    pieces: [
      { name: "prov", version: "1.0.0", plugin: { providers: { scripted: provider } } },
      { name: "wrap", version: "1.0.0", plugin: wrap },
    ],
  });
  const ctx = agent.ctxOf("tester");
  const only = await ctx.subrun("x", { plugins: { only: ["builtin:read"] } }).done;
  const disabled = await ctx.subrun("y", { plugins: { disable: ["prov", "wrap"] } }).done;
  assert.equal(only?.error, undefined);
  assert.equal(disabled?.error, undefined);
  assert.deepEqual(
    provider.requests.map((r) => r.headers?.["x-wrapped"]),
    ["1", "1"],
  );
  assert.deepEqual(
    provider.requests[0]?.tools.map((x) => x.name),
    ["read"],
  );
});

test("session_close and close handlers at exit may subrun and send to their children; after them subrun throws", async (t) => {
  const ends: (RunEnd | undefined)[] = [];
  let left: SubRun | undefined;
  let host: Ctx | undefined;
  const plugin: Plugin = {
    on: {
      init: (_, ctx) => {
        host = ctx;
      },
      session_close: async ({ reason }, ctx) => {
        if (reason !== "exit") return;
        const h = ctx.subrun("flush");
        ends.push(await h.done);
        ends.push(await h.send("more", { deliver: "steer" }));
      },
      close: (_, ctx) => {
        left = ctx.subrun("left running");
      },
    },
  };
  const { agent } = await setup(t, [{ text: "flushed" }, { text: "more done" }, hang], [{ name: "p", plugin }]);
  await agent.close();
  assert.deepEqual(
    ends.map((e) => text(e?.messages)),
    ["flushed", "more done"],
  );
  assert.deepEqual((await left?.done)?.aborted, { by: "host", reason: "exit" });
  assert.throws(() => host?.subrun("late"), /closed/);
  await assert.rejects(agent.run("late"), /closed/);
});

test("a detached subrun outlives its caller's abort, keeps its parent, reports usage to the session; close aborts it", async (t) => {
  const u = (n: number): Usage => ({ input: n, output: n, cacheRead: 0 });
  const w = watcher();
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  const handles: SubRun[] = [];
  const spawn = tool({
    name: "spawn",
    description: "",
    inputSchema: z.object({ task: z.string() }),
    execute: async ({ task }, ctx) => {
      handles.push(ctx.subrun(task, { detached: true }));
      return "started";
    },
  });
  const turn: Turn = async (req, ctx) => {
    const last = req.messages.at(-1);
    if (ctx?.run?.depth) {
      if (last?.role === "user" && last.content === "bg") await released;
      else return hang(req);
      return { text: "bg done", usage: u(10) };
    }
    if (last?.role === "user") return { toolCalls: [{ id: "s", name: "spawn", input: { task: last.content } }] };
    // the first run's parent holds until aborted; the second's ends
    return req.messages.length > 3 ? { text: "ok" } : hang(req);
  };
  const { agent, provider, session } = await setup(
    t,
    [turn, turn, turn, turn, turn, turn],
    [
      { name: "spawner", plugin: { tools: [spawn] } },
      { name: "w", plugin: w.plugin },
    ],
  );
  const abort = new AbortController();
  const run = agent.run("bg", { signal: abort.signal });
  await until(() => provider.requests.length === 3);
  abort.abort();
  assert.deepEqual((await run)?.aborted, { by: "user" });
  release();
  const end = await handles[0]?.done;
  assert.equal(end?.aborted, undefined);
  assert.equal(text(end?.messages), "bg done");
  const [parent, child] = w.starts;
  assert.deepEqual(child?.parent, { session: session.id, runId: parent?.id, toolCallId: "s" });
  assert.deepEqual(session.getState().usage, u(10));
  const results = session.getState().messages.flatMap((m) => (m.role === "tool" ? m.results : []));
  assert.equal(results[0]?.usage, undefined);

  // a second one, still running at exit
  await agent.run("stays");
  await until(() => provider.requests.length === 6);
  // a child from before close starts nothing more: its queued send resolves with undefined
  const queued = handles[1]?.send("follow-up", { deliver: "after" });
  await agent.close();
  assert.deepEqual((await handles[1]?.done)?.aborted, { by: "host", reason: "exit" });
  assert.equal(await queued, undefined);
  assert.equal(provider.requests.length, 6);
});

test("input handlers see ctx.run: the run's id, depth and source", async (t) => {
  const seen: (Ctx["run"] | undefined)[] = [];
  const starts: string[] = [];
  const plugin: Plugin = {
    on: {
      input: (_, ctx) => void seen.push(ctx.run),
      run_start: (_, ctx) => void starts.push(ctx.run?.id ?? ""),
    },
  };
  const { agent } = await setup(t, [{ text: "a" }, { text: "b" }], [{ name: "p", plugin }]);
  await agent.run("hi", { source: "me" });
  await agent.ctxOf("tester").subrun("child").done;
  assert.deepEqual(
    seen.map((r) => [r?.id, r?.depth, r?.source, r?.model]),
    [
      [starts[0], 0, "me", "scripted"],
      [starts[1], 1, "tester", "scripted"],
    ],
  );
});

test("session_closed follows a session_close no handler cancelled, and the exit's; both name the target", async (t) => {
  const log: string[] = [];
  let cancel = true;
  const names = new Map<unknown, string>();
  const plugin: Plugin = {
    on: {
      session_close: (p) => {
        log.push(`close ${p.reason} ${names.get(p.target)}`);
        if (cancel) p.cancel = true;
      },
      session_closed: (p) => void log.push(`closed ${p.reason} ${names.get(p.target)}`),
    },
  };
  const { agent } = await setup(t, [], [{ name: "p", plugin }]);
  const [a, b] = [memorySession(), memorySession()];
  names.set(a, "a").set(b, "b");
  assert.equal(await agent.setSession(a), false);
  cancel = false;
  assert.equal(await agent.setSession(b, "resume"), true);
  await agent.close();
  assert.deepEqual(log, [
    "close new a",
    "close resume b",
    "closed resume b",
    "close exit undefined",
    "closed exit undefined",
  ]);
});

test("a child's session_closed(child) fires once, when its caller's run has ended and it runs no more; a detached one's at exit", async (t) => {
  const log: string[] = [];
  const ids = new Map<string, string>();
  const spawn = tool({
    name: "spawn",
    description: "",
    inputSchema: z.object({ task: z.string() }),
    execute: async ({ task }, ctx) => {
      const h = ctx.subrun(task, { detached: task === "bg" });
      ids.set(h.session.id, task);
      if (task === "bg") return "started";
      return text((await h.done)?.messages) ?? "";
    },
  });
  const plugin: Plugin = {
    tools: [spawn],
    on: {
      run_end: (_, ctx) => {
        if (ctx.run?.depth) log.push(`end ${ids.get(ctx.session?.id ?? "")}`);
      },
      session_closed: ({ session, reason }) => void log.push(`closed ${reason} ${ids.get(session.id) ?? "main"}`),
    },
  };
  const turn: Turn = (req, ctx) => {
    const last = req.messages.at(-1);
    if (ctx?.run?.depth) return { text: `${last?.role === "user" ? last.content : ""} done` };
    if (last?.role === "user")
      return {
        toolCalls: [
          { id: "1", name: "spawn", input: { task: "a" } },
          { id: "2", name: "spawn", input: { task: "bg" } },
        ],
      };
    return { text: "ok" };
  };
  const { agent } = await setup(t, [turn, turn, turn, turn], [{ name: "p", plugin }]);
  await agent.run("go");
  await until(() => log.includes("closed child a") && log.includes("end bg"));
  assert.ok(log.indexOf("end a") < log.indexOf("closed child a"));
  assert.ok(!log.includes("closed child bg"));
  await agent.close();
  assert.deepEqual(
    log.filter((l) => l.startsWith("closed")),
    ["closed child a", "closed exit main", "closed child bg"],
  );
});

test("a child woken by send after its session_closed(child) is closed again after that run", async (t) => {
  let handle: SubRun | undefined;
  let closed = 0;
  const plugin: Plugin = {
    on: { session_closed: ({ reason }) => void (reason === "child" && closed++) },
  };
  const turn: Turn = (req, ctx) => {
    if (ctx?.run?.depth) return { text: "child" };
    return req.messages.at(-1)?.role === "user"
      ? { toolCalls: [{ id: "1", name: "spawn", input: { task: "a" } }] }
      : { text: "ok" };
  };
  const { agent } = await setup(
    t,
    [turn, turn, turn, turn],
    [
      { name: "s", plugin: spawner(undefined, (h) => (handle = h)) },
      { name: "p", plugin },
    ],
  );
  await agent.run("go");
  await until(() => closed === 1);
  void handle?.send("again", { deliver: "steer" });
  await until(() => closed === 2);
  await agent.close();
  assert.equal(closed, 2);
});

test("close waits for a child's slow session_closed(child) already started", async (t) => {
  const log: string[] = [];
  let closing = false;
  let release = () => {};
  const slow = new Promise<void>((r) => (release = r));
  const plugin: Plugin = {
    on: {
      session_closed: async ({ reason }) => {
        // released a macrotask after close's own session_closed(exit): close must still be waiting on this one
        if (reason === "exit") setImmediate(release);
        if (reason !== "child") return;
        closing = true;
        await slow;
        log.push("child closed");
      },
      close: () => void log.push("close"),
    },
  };
  const turn: Turn = (req, ctx) => {
    if (ctx?.run?.depth) return { text: "child" };
    return req.messages.at(-1)?.role === "user"
      ? { toolCalls: [{ id: "1", name: "spawn", input: { task: "a" } }] }
      : { text: "ok" };
  };
  const { agent } = await setup(
    t,
    [turn, turn, turn],
    [
      { name: "s", plugin: spawner() },
      { name: "p", plugin },
    ],
  );
  await agent.run("go");
  await until(() => closing);
  await agent.close();
  assert.deepEqual(log, ["child closed", "close"]);
});

test("a child woken while its session_closed(child) handlers run is closed again after that run", async (t) => {
  let handle: SubRun | undefined;
  let closed = 0;
  let release = () => {};
  const plugin: Plugin = {
    on: {
      session_closed: async ({ reason }) => {
        if (reason !== "child") return;
        closed++;
        if (closed === 1) await new Promise<void>((r) => (release = r));
      },
    },
  };
  const turn: Turn = (req, ctx) => {
    if (ctx?.run?.depth) return { text: "child" };
    return req.messages.at(-1)?.role === "user"
      ? { toolCalls: [{ id: "1", name: "spawn", input: { task: "a" } }] }
      : { text: "ok" };
  };
  const { agent } = await setup(
    t,
    [turn, turn, turn, turn],
    [
      { name: "s", plugin: spawner(undefined, (h) => (handle = h)) },
      { name: "p", plugin },
    ],
  );
  await agent.run("go");
  await until(() => closed === 1);
  // woken while the first end's handlers still run
  const again = handle?.send("again", { deliver: "steer" });
  release();
  await again;
  await until(() => closed === 2);
  await agent.close();
  assert.equal(closed, 2);
});
