import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { listSessions, openSession, type RunEnd } from "@hortus/core";
import { scripted, scriptedPlugin, tempDir, tempHome, until } from "@hortus/core/testing";
import { applyFlags, flaggedSession, flagOptions, parseFlags } from "./flags.ts";
import { spawnHortus, startCli } from "./testing.ts";

/** A turn answering with the request's tool names, then its system prompt's last part. */
const echo = `[(req) => ({ text: req.tools.map((t) => t.name).join(",") + "|" + req.system.split("\\n\\n").at(-1) + "|" + req.messages.length })]`;

test("-p prints the answer and exits 0; the session is saved", async (t) => {
  t.after(await tempHome({ plugins: { scripted: scriptedPlugin(`[{ text: "hello there" }]`) } }));
  const h = spawnHortus(t, ["-p", "hi"]);
  assert.equal(await h.exit, 0, h.stderr());
  assert.equal(h.stdout(), "hello there\n");
  assert.equal((await listSessions())[0]?.title, "hi");
});

test("--json emits the run's events in order as JSON lines, each in the run with its run.id", async (t) => {
  t.after(await tempHome({ plugins: { scripted: scriptedPlugin(`[{ text: "a" }]`) } }));
  const h = spawnHortus(t, ["-p", "--json", "hi"]);
  assert.equal(await h.exit, 0, h.stderr());
  const names = h.lines.map((l) => l.event);
  const run = names.slice(names.indexOf("input"), names.indexOf("run_end") + 1);
  assert.deepEqual(run, [
    "input",
    "message",
    "skills",
    "run_start",
    "prompt",
    "turn_start",
    "request",
    "text",
    "response",
    "message",
    "turn_end",
    "run_end",
  ]);
  const ids = new Set(h.lines.filter((l) => run.includes(l.event)).map((l) => l.run?.id));
  assert.equal(ids.size, 1);
  assert.ok([...ids][0]);
  assert.deepEqual(names.slice(-3), ["session_close", "session_closed", "close"]);
  const last = h.lines.filter((l) => l.event === "message").at(-1);
  assert.equal(last.payload.text, "a");
});

test("--session continues a session or keeps it in memory; --disable, --tools, --plugin, --append-system and --name apply", async (t) => {
  t.after(await tempHome({ plugins: { scripted: scriptedPlugin(`[...Array(5)].map(() => ${echo}[0])`) } }));
  const dir = await tempDir(t);
  const plugin = join(dir, "last.mjs");
  await writeFile(plugin, `export default { on: { prompt: (p) => { p.system.push("from --plugin"); } } };\n`);

  let h = spawnHortus(t, ["-p", "--name", "titled", "--disable", "builtin:bash", "one"]);
  assert.equal(await h.exit, 0, h.stderr());
  assert.match(h.stdout(), /\|1\n$/);
  assert.ok(h.stdout().split("|")[0]?.split(",").includes("read"));
  assert.ok(!h.stdout().split("|")[0]?.split(",").includes("bash"));
  const [s] = await listSessions();
  assert.equal(s?.title, "titled");

  h = spawnHortus(t, [
    "-p",
    "--session",
    s?.id ?? "",
    "--tools",
    "read",
    "--append-system",
    "appended",
    "--plugin",
    plugin,
    "two",
  ]);
  assert.equal(await h.exit, 0, h.stderr());
  // the earlier user message and answer, then this one; the --plugin's prompt part after --append-system's
  assert.equal(h.stdout(), "read|from --plugin|3\n");
  const [after] = await listSessions();
  assert.equal((await openSession(after?.leafId ?? null)).getState().messages.length, 4);

  h = spawnHortus(t, ["-p", "--session", "memory", "--only", "builtin:read", "three"]);
  assert.equal(await h.exit, 0, h.stderr());
  // only builtin:read takes part (the scripted provider kept as a provider), and nothing new is saved
  assert.match(h.stdout(), /^read\|/);
  assert.equal((await listSessions()).length, 1);
});

test("the same flags apply in interactive mode: session, model, name and the initial prompt", async (t) => {
  t.after(
    await tempHome({
      secrets: { scripted: { type: "scripted", apiKey: "x" }, other: { type: "scripted", apiKey: "x" } },
    }),
  );
  const provider = scripted([{ text: "answered" }]);
  const first = await openSession(null);
  await first.setName("before");
  const flags = parseFlags([
    "--session",
    first.id,
    "--model",
    "other/m2",
    "--effort",
    "low",
    "--name",
    "renamed",
    "--tools",
    "read",
    "the",
    "prompt",
  ]);
  // a session listed once it has entries
  await first.append([{ role: "user", content: "earlier" }]);
  const session = await flaggedSession(flags.session);
  await applyFlags(session, flags);
  const opts = await flagOptions(flags);
  const cli = await startCli({
    session,
    ...opts,
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }, ...(opts.extra ?? [])],
  });
  t.after(() => cli.close());
  assert.equal(cli.ui.getState().session.id, first.id);
  assert.ok(cli.submit(flags.prompt ?? ""));
  await until(() => provider.requests.length === 1 && !cli.ui.getState().busy);
  const req = provider.requests[0];
  assert.equal(req?.model, "m2");
  assert.deepEqual(
    req?.tools.map((x) => x.name),
    ["read"],
  );
  assert.deepEqual(
    req?.messages.map((m) => m.role === "user" && m.content),
    ["earlier", "the prompt"],
  );
  assert.equal(session.getState().effort, "low");
  assert.equal((await listSessions())[0]?.title, "renamed");
});

test("-p: an ask resolves undefined (no one to ask), so the run goes on", async (t) => {
  const dir = await tempDir(t);
  const zod = import.meta.resolve("zod");
  await writeFile(
    join(dir, "asker.mjs"),
    `import { tool } from "@hortus/core";
import { z } from ${JSON.stringify(zod)};
export default { tools: [tool({ name: "ask_me", description: "asks", inputSchema: z.object({}),
  execute: async (_, ctx) => "answer: " + String(await ctx.ask({ question: "ok?", options: [{ label: "yes" }] })) })] };
`,
  );
  t.after(
    await tempHome({
      plugins: {
        scripted: scriptedPlugin(
          `[{ toolCalls: [{ id: "a", name: "ask_me", input: {} }] }, (req) => ({ text: req.messages.at(-1).results[0].output })]`,
        ),
      },
    }),
  );
  const h = spawnHortus(t, ["-p", "--plugin", join(dir, "asker.mjs"), "go"]);
  assert.equal(await h.exit, 0, h.stderr());
  assert.equal(h.stdout(), "answer: undefined\n");
});

test("SIGINT aborts the run (by the user), closes the agent, keeps completed messages and exits 130", async (t) => {
  t.after(
    await tempHome({
      plugins: {
        scripted: scriptedPlugin(`[
          { toolCalls: [{ id: "r", name: "read", input: { path: "missing.txt" } }] },
          // a timer keeps the process alive, as a real request's socket would
          (req) => new Promise((_, reject) => {
            const timer = setTimeout(() => {}, 60000);
            req.signal.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("aborted"))));
          }),
        ]`),
      },
    }),
  );
  const h = spawnHortus(t, ["-p", "--json", "go"]);
  await h.next((l) => l.event === "request" && l.payload.messages.length === 3);
  h.child.kill("SIGINT");
  assert.equal(await h.exit, 130);
  const end: RunEnd = h.lines.find((l) => l.event === "run_end")?.payload;
  assert.deepEqual(end.aborted, { by: "user" });
  assert.equal(h.lines.at(-1)?.event, "close");
  const [s] = await listSessions();
  const saved = (await readFile(s?.path ?? "", "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    saved.filter((e) => e.type === "message").map((e) => e.message.role),
    ["user", "assistant", "tool"],
  );
});

test("--rpc: prompts, asks answered and engaged over stdin, abort, commands and set_session", async (t) => {
  const dir = await tempDir(t);
  const zod = import.meta.resolve("zod");
  await writeFile(
    join(dir, "asker.mjs"),
    `import { tool } from "@hortus/core";
import { z } from ${JSON.stringify(zod)};
export default {
  tools: [tool({ name: "ask_me", description: "asks", inputSchema: z.object({}),
    execute: async (_, ctx) => "interactive " + ctx.host.interactive + ", answer: " + await ctx.ask({ question: "ok?", options: [{ label: "yes" }] }) })],
  commands: [{ name: "hello", description: "greets", run: (arg, ctx) => "hello " + arg + " from " + ctx.host.kind }],
  on: { ask: (p, ctx) => { p.shown.then(() => ctx.notify("shown")); p.engaged.then(() => ctx.notify("engaged")); } },
};
`,
  );
  t.after(
    await tempHome({
      plugins: {
        scripted: scriptedPlugin(`[
          { toolCalls: [{ id: "a", name: "ask_me", input: {} }] },
          (req) => ({ text: req.messages.at(-1).results[0].output }),
          (req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted")))),
        ]`),
      },
    }),
  );
  const h = spawnHortus(t, ["--rpc", "--plugin", join(dir, "asker.mjs")]);
  await h.next((l) => l.event === "interactive");
  h.send({ type: "prompt", text: "go" });
  const ask = await h.next((l) => l.event === "ask");
  assert.equal(ask.payload.question, "ok?");
  await h.next((l) => l.event === "notify" && l.payload.text === "shown");
  h.send({ type: "engage", askId: ask.payload.askId });
  await h.next((l) => l.event === "notify" && l.payload.text === "engaged");
  h.send({ type: "answer", askId: ask.payload.askId, answer: "yes" });
  const answered = await h.next((l) => l.event === "answered");
  assert.deepEqual(answered.payload, {
    askId: ask.payload.askId,
    by: "@hortus/cli",
    reason: "answered",
    answer: "yes",
  });
  const reply = await h.next((l) => l.event === "message" && l.payload.role === "assistant" && l.payload.text);
  assert.equal(reply.payload.text, "interactive true, answer: yes");

  h.send({ type: "prompt", text: "wait" });
  await h.next((l) => l.event === "request");
  h.send({ type: "abort" });
  const end = await h.next((l) => l.event === "run_end");
  assert.deepEqual(end.payload.aborted, { by: "user" });

  h.send({ type: "command", name: "hello", arg: "you" });
  assert.deepEqual(await h.next((l) => l.response === "command"), {
    response: "command",
    name: "hello",
    text: "hello you from rpc",
  });
  h.send({ type: "command", name: "nope", id: 3 });
  const failed = await h.next((l) => l.error);
  assert.deepEqual([failed.response, failed.id, failed.name], ["command", 3, "nope"]);
  assert.match(failed.error.message, /Unknown command/);

  const before = h.lines.find((l) => l.event === "session_open")?.payload.session.id;
  h.send({ type: "set_session", session: "new" });
  const close = await h.next((l) => l.event === "session_close");
  assert.deepEqual([close.payload.session.id, close.payload.reason], [before, "new"]);
  const open = await h.next((l) => l.event === "session_open");
  assert.equal(open.payload.reason, "new");
  assert.notEqual(open.payload.session.id, before);

  h.send({ type: "exit" });
  assert.equal(await h.exit, 0);
  assert.equal(h.lines.at(-1)?.event, "close");
});

test("--rpc: once stdin closes the host isn't interactive, a pending ask settles unanswered, and it exits", async (t) => {
  const dir = await tempDir(t);
  const zod = import.meta.resolve("zod");
  await writeFile(
    join(dir, "asker.mjs"),
    `import { tool } from "@hortus/core";
import { z } from ${JSON.stringify(zod)};
export default { tools: [tool({ name: "ask_me", description: "asks", inputSchema: z.object({}),
  execute: async (_, ctx) => { const a = await ctx.ask({ question: "ok?" }); return "answer " + a + ", interactive " + ctx.host.interactive; } })] };
`,
  );
  t.after(
    await tempHome({
      plugins: {
        scripted: scriptedPlugin(
          `[{ toolCalls: [{ id: "a", name: "ask_me", input: {} }] }, (req) => ({ text: req.messages.at(-1).results[0].output })]`,
        ),
      },
    }),
  );
  const h = spawnHortus(t, ["--rpc", "--plugin", join(dir, "asker.mjs")]);
  await h.next((l) => l.event === "interactive");
  h.send({ type: "prompt", text: "go" });
  await h.next((l) => l.event === "ask");
  h.child.stdin.end();
  assert.equal(await h.exit, 0, h.stderr());
  const reply = h.lines.filter((l) => l.event === "message" && l.payload.role === "assistant").at(-1);
  assert.equal(reply?.payload.text, "answer undefined, interactive false");
});

test("-p: a send queued after the run whose input a handler takes still lets it exit; console.log goes to stderr", async (t) => {
  const dir = await tempDir(t);
  const plugin = join(dir, "intercept.mjs");
  await writeFile(
    plugin,
    `export default { on: {
  init: () => { console.log("PLUGIN LOG"); },
  run_end: (p, ctx) => { if (!globalThis.sent) { globalThis.sent = 1; ctx.send("!intercept", { deliver: "after" }); } },
  input: (p) => { if (p.text === "!intercept") p.handled = true; },
} };
`,
  );
  t.after(await tempHome({ plugins: { scripted: scriptedPlugin(`[{ text: "a" }]`) } }));
  let h = spawnHortus(t, ["-p", "--plugin", plugin, "hi"]);
  assert.equal(await h.exit, 0, h.stderr());
  assert.equal(h.stdout(), "a\n");
  assert.match(h.stderr(), /PLUGIN LOG/);
  h = spawnHortus(t, ["-p", "--json", "--plugin", plugin, "hi"]);
  assert.equal(await h.exit, 0, h.stderr());
  // every stdout line is JSON
  assert.equal(h.lines.length, h.stdout().trim().split("\n").length);
  assert.equal(h.lines.at(-1)?.event, "close");
});

test("-p: SIGINT during a run a plugin queued after the first aborts it by the user", async (t) => {
  const dir = await tempDir(t);
  const plugin = join(dir, "again.mjs");
  await writeFile(
    plugin,
    `export default { on: { run_end: (p, ctx) => { if (!globalThis.sent) { globalThis.sent = 1; ctx.send("again", { deliver: "after" }); } } } };\n`,
  );
  t.after(
    await tempHome({
      plugins: {
        scripted: scriptedPlugin(`[
          { text: "first" },
          (req) => new Promise((_, reject) => {
            const timer = setTimeout(() => {}, 60000);
            req.signal.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("aborted"))));
          }),
        ]`),
      },
    }),
  );
  const h = spawnHortus(t, ["-p", "--json", "--plugin", plugin, "hi"]);
  await h.next((l) => l.event === "request" && l.payload.messages.length === 3);
  h.child.kill("SIGINT");
  assert.equal(await h.exit, 130);
  const ends = h.lines.filter((l) => l.event === "run_end").map((l) => l.payload.aborted);
  assert.deepEqual(ends, [undefined, { by: "user" }]);
  assert.equal(h.lines.at(-1)?.event, "close");
});

test("--rpc: a prompt's id comes back with its run_end; the `name` command renames the session", async (t) => {
  t.after(await tempHome({ plugins: { scripted: scriptedPlugin(`[{ text: "one" }, { text: "two" }]`) } }));
  const h = spawnHortus(t, ["--rpc"]);
  await h.next((l) => l.event === "interactive");
  h.send({ type: "prompt", text: "a", id: 1 });
  h.send({ type: "prompt", text: "b", id: "second" });
  const r1 = await h.next((l) => l.response === "prompt");
  const r2 = await h.next((l) => l.response === "prompt");
  assert.deepEqual([r1.id, r1.source, r1.messages.at(-1).text], [1, "run", "one"]);
  assert.deepEqual([r2.id, r2.messages.at(-1).text], ["second", "two"]);
  h.send({ type: "command", name: "name", arg: "Renamed" });
  assert.equal((await h.next((l) => l.response === "command")).text, "Session named Renamed");
  h.send({ type: "exit" });
  assert.equal(await h.exit, 0, h.stderr());
  assert.equal((await listSessions())[0]?.title, "Renamed");
});

test("-p: --seed seeds the session, --session key:<key> opens (else creates) one by key, no prompt runs on a pending user message", async (t) => {
  const turn = `(req) => ({ text: req.messages.length + ":" + req.messages.at(-1).content })`;
  t.after(await tempHome({ plugins: { scripted: scriptedPlugin(`[${turn}, ${turn}]`) } }));
  const dir = await tempDir(t);
  const seed = join(dir, "seed.json");
  await writeFile(
    seed,
    JSON.stringify([
      { role: "user", content: "s1" },
      { role: "assistant", text: "s2", toolCalls: [] },
    ]),
  );
  let h = spawnHortus(t, ["-p", "--session", "key:job", "--seed", seed, "q"]);
  assert.equal(await h.exit, 0, h.stderr());
  assert.equal(h.stdout(), "3:q\n");
  // renaming doesn't lose it; nothing pending: no prompt is an error
  const [info] = await listSessions();
  const session = await openSession(info?.leafId ?? null);
  await session.setName("renamed");
  h = spawnHortus(t, ["-p", "--session", "key:job"]);
  assert.equal(await h.exit, 1);
  assert.match(h.stderr(), /-p needs a prompt, or a session with something to answer/);
  // nor is a seed appended to a session that has messages
  h = spawnHortus(t, ["-p", "--session", "key:job", "--seed", seed, "again"]);
  assert.equal(await h.exit, 1);
  assert.match(h.stderr(), /--seed needs a new or empty session/);
  // a request saved but not answered (a failed run's) is run without sending it again
  await session.append([{ role: "user", content: "pending" }]);
  h = spawnHortus(t, ["-p", "--session", "key:job"]);
  assert.equal(await h.exit, 0, h.stderr());
  assert.equal(h.stdout(), "5:pending\n");
  assert.deepEqual(
    (await listSessions()).map((s) => s.id),
    [info?.id],
  );
});

test("-p without a prompt retries after a tool round; refused before the flags write anything", async (t) => {
  t.after(
    await tempHome({
      plugins: {
        // each process starts at the first turn: the first one calls a tool, then fails; the retry answers
        scripted: scriptedPlugin(`[
          (req) => req.messages.at(-1).role === "user"
            ? { toolCalls: [{ id: "1", name: "nope", input: {} }] }
            : { text: "done after " + req.messages.at(-1).role },
          () => { throw new Error("rate limited") },
        ]`),
      },
    }),
  );
  let h = spawnHortus(t, ["-p", "--session", "key:k", "q"]);
  assert.equal(await h.exit, 1);
  const [info] = await listSessions();
  const roles = (await openSession(info?.leafId ?? null)).getState().messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool"]);
  h = spawnHortus(t, ["-p", "--session", "key:k"]);
  assert.equal(await h.exit, 0, h.stderr());
  assert.equal(h.stdout(), "done after tool\n");
  // nothing to answer: refused before --name writes (and so creates) a session
  h = spawnHortus(t, ["-p", "--session", "key:empty", "--name", "foo"]);
  assert.equal(await h.exit, 1);
  assert.deepEqual(
    (await listSessions()).map((s) => s.id),
    [info?.id],
  );
});

test("--rpc: a failed prompt or command gets one reply with its id; set_session key:<new> opens as new", async (t) => {
  t.after(await tempHome({ plugins: { scripted: scriptedPlugin(`[() => { throw new Error("boom") }]`) } }));
  const h = spawnHortus(t, ["--rpc"]);
  await h.next((l) => l.event === "interactive");
  h.send({ type: "prompt", text: "a", id: 7 });
  const failed = await h.next((l) => l.response === "prompt");
  assert.deepEqual([failed.id, failed.error.message], [7, "boom"]);
  h.send({ type: "prompt", text: "b", id: 8, deliver: "bogus" });
  const bogus = await h.next((l) => l.response === "prompt" && l.id === 8);
  assert.match(bogus.error.message, /deliver needs one of/);
  h.send({ type: "set_session", session: "key:fresh", id: 9 });
  const open = await h.next((l) => l.event === "session_open");
  assert.equal(open.payload.reason, "new");
  const switched = await h.next((l) => l.response === "set_session");
  assert.deepEqual([switched.id, switched.session, switched.ok], [9, open.payload.session.id, true]);
  h.send({ type: "exit" });
  assert.equal(await h.exit, 0, h.stderr());
  // replies only: no bare error line besides them
  assert.deepEqual(
    h.lines.filter((l) => !l.event).map((l) => [l.response, l.id]),
    [
      ["prompt", 7],
      ["prompt", 8],
      ["set_session", 9],
    ],
  );
});

test("--rpc: bad lines are reported without echoing them; a positional prompt runs", async (t) => {
  t.after(await tempHome({ plugins: { scripted: scriptedPlugin(`[{ text: "ran" }]`) } }));
  const h = spawnHortus(t, ["--rpc", "the prompt"]);
  const reply = await h.next((l) => l.event === "message" && l.payload.role === "assistant");
  assert.equal(reply.payload.text, "ran");
  h.child.stdin.write("null\n");
  assert.deepEqual(await h.next((l) => l.error), { error: "Not a command object" });
  h.child.stdin.write("{hunter2-not-json\n");
  assert.deepEqual(await h.next((l) => l.error), { error: "Not JSON" });
  assert.doesNotMatch(h.stdout(), /hunter2/);
  h.send({ type: "exit" });
  assert.equal(await h.exit, 0, h.stderr());
});

test("flags: -r excludes -p and --rpc; --effort auto clears the session's effort", async (t) => {
  t.after(await tempHome());
  assert.throws(() => parseFlags(["-r", "-p", "x"]), /-r is for the TUI/);
  assert.throws(() => parseFlags(["-r", "id", "--rpc"]), /-r is for the TUI/);
  const session = await openSession(null);
  await session.setEffort("high");
  await applyFlags(session, parseFlags(["--effort", "auto"]));
  assert.equal(session.getState().effort, undefined);
  // flags that change nothing write nothing
  const flags = parseFlags(["--model", "p/m", "--effort", "low", "--name", "n"]);
  await applyFlags(session, flags);
  const entries = (await session.allEntries()).length;
  await applyFlags(session, flags);
  assert.equal((await session.allEntries()).length, entries);
});

test("-p --parent: the session is among the parent's children, keyed ones too, and its runs carry the lineage", async (t) => {
  t.after(await tempHome({ plugins: { scripted: scriptedPlugin(`[{ text: "a" }, { text: "b" }]`) } }));
  let h = spawnHortus(t, ["-p", "top"]);
  assert.equal(await h.exit, 0, h.stderr());
  const [top] = await listSessions();
  assert.ok(top);
  h = spawnHortus(t, ["-p", "--json", "--parent", top.id, "--session", "key:job", "child"]);
  assert.equal(await h.exit, 0, h.stderr());
  const start = h.lines.find((l) => l.event === "run_start");
  assert.deepEqual([start?.run.depth, start?.run.parent, start?.run.root], [1, { session: top.id }, top.id]);
  const children = await listSessions({ parent: top.id });
  assert.deepEqual(
    children.map((c) => c.title),
    ["child"],
  );
  assert.deepEqual(
    (await listSessions()).map((s) => s.id),
    [top.id],
  );
  // key: resolves under the parent: the same key again continues that child
  assert.equal((await flaggedSession("key:job", top.id)).id, children[0]?.id);
  assert.throws(() => parseFlags(["--parent", "x"]), /--parent needs -p or --rpc/);
});
