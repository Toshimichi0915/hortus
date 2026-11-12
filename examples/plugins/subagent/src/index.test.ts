import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type AskEvent, createAgent, listSessions, openSession } from "@hortus/core";
import { spawnHortus } from "@hortus/cli/testing";
import { scripted, scriptedPlugin, tempDir, tempHome, until } from "@hortus/core/testing";

test("subagent delegates a task in its own cwd with a read-only tool set and returns the child's final text", async (t) => {
  t.after(await tempHome({ plugins: { subagent: fileURLToPath(new URL("..", import.meta.url)) } }));
  const dir = await tempDir(t, "hortus-subagent-");
  await writeFile(join(dir, "notes.txt"), "the answer is 42");
  const usage = { input: 7, output: 3, cacheRead: 0 };
  const provider = scripted([
    { toolCalls: [{ id: "s", name: "subagent", input: { task: "find the answer", cwd: dir } }] },
    { toolCalls: [{ id: "r", name: "read", input: { path: "notes.txt" } }], usage },
    { text: "It is 42.", usage },
    { text: "The subagent says 42." },
  ]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  const session = await openSession(null);
  await agent.setSession(session);
  await agent.run("what's the answer?");

  const [parent, child, childAfter, parentAfter] = provider.requests;
  assert.ok(parent?.tools.some((x) => x.name === "subagent"));
  assert.deepEqual(
    child?.tools.map((x) => x.name),
    ["read"],
  );
  assert.match(child?.system ?? "", new RegExp(`Working directory: ${dir}\\.`));
  assert.deepEqual(child?.messages, [{ role: "user", content: "find the answer" }]);
  const read = childAfter?.messages.at(-1);
  assert.equal(read?.role === "tool" && read.results[0]?.output, "the answer is 42");
  const result = parentAfter?.messages.at(-1);
  assert.equal(result?.role === "tool" && result.results[0]?.output, "It is 42.");
  // the child's tokens are the call's own usage, in the parent's session
  const saved = session.getState().messages.flatMap((m) => (m.role === "tool" ? m.results : []));
  assert.deepEqual(saved[0]?.usage, { input: 14, output: 6, cacheRead: 0 });
});

/** A plugin recording the tools of each run before `--tools` narrows them (`cli:flags` runs last), for scripted turns. */
const probe = {
  "hortus.json": JSON.stringify({ name: "probe", version: "0.0.0", entrypoint: "index.js" }),
  // in a child (depth > 0: `--parent` sets it), it asks once: the parent's ask handlers answer
  "index.js": `export default { on: { run_start: async (p, ctx) => {
    globalThis.loaded = p.tools.map((t) => t.name).join(",");
    if (ctx.run.depth > 0 && ctx.run.parent?.session) globalThis.asked = await ctx.ask({ question: "Color?", options: [{ label: "blue" }] });
  } } };\n`,
};
const tui = { kind: "tui", interactive: true };

test("subagent --background: runs `hortus --rpc --parent <session> --session memory --disable subagent`, relays its asks and delivers its answer after the run", async (t) => {
  // one scripted provider for both processes: the parent's turns, and the child's answer (its tools and model)
  const turn = `(req) => {
    const last = req.messages.at(-1);
    if (last.role === "tool") return { text: "started" };
    if (last.content === "go") return { toolCalls: [{ id: "s", name: "subagent", input: { task: "look", background: true } }] };
    if (last.content.startsWith("Background subagent")) return { text: "got it" };
    return { text: "child: " + req.tools.map((t) => t.name).join(",") + " " + req.model + " " + req.messages.length + " loaded " + globalThis.loaded + " asked " + globalThis.asked };
  }`;
  t.after(
    await tempHome({
      plugins: {
        subagent: fileURLToPath(new URL("..", import.meta.url)),
        scripted: scriptedPlugin(`[...Array(5)].map(() => ${turn})`),
        probe,
      },
    }),
  );
  const questions: string[] = [];
  const answerer = {
    on: {
      ask: (p: AskEvent) => {
        questions.push(p.question);
        p.resolve("blue");
      },
    },
  };
  const agent = await createAgent({ host: tui, extra: [{ name: "answerer", plugin: answerer }] });
  t.after(() => agent.close());
  const session = await openSession(null);
  await agent.setSession(session);
  const end = await agent.run("go");
  const result = end?.messages.at(-2);
  assert.match(result?.role === "tool" ? (result.results[0]?.output ?? "") : "", /^Started background subagent \w+/);
  const text = () =>
    session.getState().messages.map((m) => (m.role === "assistant" ? m.text : m.role === "user" ? m.content : ""));
  await until(() => text().includes("got it"), 20000);
  const delivered = session.getState().messages.find((m) => m.role === "user" && m.meta?.plugin === "subagent");
  const content = delivered?.role === "user" ? delivered.content : "";
  // read-only, the caller's model, a fresh in-memory session with just the task
  assert.match(content, /^Background subagent \w+ finished:\n\nchild: read scripted 1 loaded .* asked blue$/);
  assert.deepEqual(questions, ["Color?"]);
  // before --tools narrowed them: the child loaded every other plugin's tools, but not subagent's (--disable)
  const loaded = content.split(" loaded ")[1]?.split(",");
  assert.ok(loaded?.includes("bash"));
  assert.ok(!loaded?.includes("subagent"));
  assert.equal((await listSessions()).length, 1);
});

test("subagent --background: an ask the child settles itself is withdrawn from the parent", async (t) => {
  const turn = `(req) => {
    const last = req.messages.at(-1);
    if (last.role === "tool") return { text: "started" };
    if (last.content === "go") return { toolCalls: [{ id: "s", name: "subagent", input: { task: "look", background: true } }] };
    if (last.content.startsWith("Background subagent")) return { text: "got it" };
    return { text: "asked " + globalThis.asked };
  }`;
  // in the child, an autopilot answers its own ask after a moment
  const autopilot = {
    "hortus.json": JSON.stringify({ name: "autopilot", version: "0.0.0", entrypoint: "index.js" }),
    "index.js": `export default { on: {
      ask: (p) => process.argv.includes("--rpc") && new Promise((r) => setTimeout(() => r(p.resolve("red")), 300)),
    } };\n`,
  };
  t.after(
    await tempHome({
      plugins: {
        subagent: fileURLToPath(new URL("..", import.meta.url)),
        scripted: scriptedPlugin(`[...Array(5)].map(() => ${turn})`),
        probe,
        autopilot,
      },
    }),
  );
  // the parent's UI holds the relayed ask open until it is withdrawn
  const withdrawn: unknown[] = [];
  const holder = {
    on: {
      ask: (p: AskEvent) =>
        new Promise<void>((done) =>
          p.signal.addEventListener("abort", () => {
            withdrawn.push(p.question);
            done();
          }),
        ),
    },
  };
  const agent = await createAgent({ host: tui, extra: [{ name: "holder", plugin: holder }] });
  t.after(() => agent.close());
  const session = await openSession(null);
  await agent.setSession(session);
  await agent.run("go");
  const texts = () => session.getState().messages.map((m) => (m.role === "user" ? m.content : ""));
  await until(() => texts().some((c) => c.endsWith("asked red")), 20000);
  assert.deepEqual(withdrawn, ["Color?"]);
});

test("subagent --background: closing the agent kills a child still running", async (t) => {
  const dir = await tempDir(t, "hortus-subagent-");
  const pidFile = join(dir, "pid");
  // the child writes its pid, then waits (a timer keeps it alive, as a request's socket would)
  const turn = `(req) => {
    const last = req.messages.at(-1);
    if (last.role === "tool") return { text: "started" };
    if (last.content === "go") return { toolCalls: [{ id: "s", name: "subagent", input: { task: "hang", background: true } }] };
    return import("node:fs").then((fs) => { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); return new Promise(() => setInterval(() => {}, 1000)); });
  }`;
  t.after(
    await tempHome({
      plugins: {
        subagent: fileURLToPath(new URL("..", import.meta.url)),
        scripted: scriptedPlugin(`[...Array(3)].map(() => ${turn})`),
      },
    }),
  );
  const agent = await createAgent({ host: tui });
  await agent.setSession(await openSession(null));
  await agent.run("go");
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", 20000);
  const pid = Number(readFileSync(pidFile, "utf8"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive());
  await agent.close();
  await until(() => !alive(), 5000);
});

test("subagent --background under `hortus -p` (not interactive) runs in the foreground, so its result isn't lost", async (t) => {
  const turn = `(req) => {
    const last = req.messages.at(-1);
    if (last.role === "tool") return { text: "parent saw: " + last.results[0].output };
    if (last.content === "go") return { toolCalls: [{ id: "s", name: "subagent", input: { task: "look", background: true } }] };
    return { text: "child done" };
  }`;
  t.after(
    await tempHome({
      plugins: {
        subagent: fileURLToPath(new URL("..", import.meta.url)),
        scripted: scriptedPlugin(`[...Array(3)].map(() => ${turn})`),
      },
    }),
  );
  const h = spawnHortus(t, ["-p", "go"]);
  assert.equal(await h.exit, 0, h.stderr());
  assert.equal(h.stdout(), "parent saw: child done\n");
});
