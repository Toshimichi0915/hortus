import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderApp, startCli } from "@hortus/cli/testing";
import { type Agent, createAgent, type Message, openSession } from "@hortus/core";
import { record, scripted, scriptedPlugin, tempDir, tempHome, until } from "@hortus/core/testing";
import { parseBgArgs } from "./index.tsx";

const dir = fileURLToPath(new URL("..", import.meta.url));
const run = async (agent: Agent, name: string, arg = "") => {
  const cmd = agent.commands().find((c) => c.name === name);
  assert.ok(cmd, name);
  return (await cmd.run(arg)) ?? "";
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const notifications = (messages: Message[]) =>
  messages
    .filter((m) => m.role === "user" && m.meta?.plugin === "background-tasks")
    .map((m) => (m.role === "user" ? m.content : ""));

test("bg_run returns at once, writes the output to a file, and its notification starts a follow-up turn", async (t) => {
  t.after(await tempHome({ plugins: { "background-tasks": dir } }));
  const provider = scripted([
    {
      toolCalls: [
        {
          id: "r",
          name: "bg_run",
          input: { name: "Echo", command: "sleep 0.2; echo hi; echo oops >&2", isAgent: false },
        },
      ],
    },
    { text: "started" },
    { text: "noted" },
  ]);
  const rec = record();
  const agent = await createAgent({
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider } } },
      { name: "rec", plugin: rec },
    ],
  });
  t.after(() => agent.close());
  const session = await openSession(null);
  await agent.setSession(session);
  await agent.run("go");

  const started = provider.requests[1]?.messages.at(-1);
  const receipt = started?.role === "tool" ? started.results[0]?.output : "";
  assert.match(receipt ?? "", /^Started background task Echo \(b[0-9a-f]{8}\)\nStatus: running\n/);
  assert.match(receipt ?? "", /Automatic follow-up turn: enabled/);
  assert.match(provider.requests[0]?.system ?? "", /Background shell \(bg_run, \/bg\): \S+ -c <command>/);
  const id = /\((b[0-9a-f]{8})\)/.exec(receipt ?? "")?.[1] ?? "";

  // the notification is a turn of its own, after the run
  await until(() => provider.requests.length === 3, 5000);
  const [note] = notifications(session.getState().messages);
  assert.match(note ?? "", new RegExp(`<task-id>${id}</task-id>[\\s\\S]*<status>completed</status>`));
  assert.match(note ?? "", /<exit-code>0<\/exit-code>/);
  assert.equal(provider.requests[2]?.messages.at(-1)?.role, "user");
  await until(() => session.getState().messages.at(-1)?.role === "assistant");

  assert.match(await run(agent, "logs", id.slice(0, 5)), /hi\noops\n\[Full output: .*background-tasks.*\.output\]$/);
  assert.match(await run(agent, "jobs"), new RegExp(`✓ ${id} completed .* exit=0 .*— Echo\\n    output: `));
  const statuses = rec.events.filter((e) => e.name === "status").map((e) => (e.payload as { text?: string }).text);
  assert.ok(statuses.includes("bg 1 running · /tasks"));
  assert.equal(statuses.at(-1), "bg 1 done · /tasks · /bg-clear");
  assert.equal(await run(agent, "bg-clear"), "Cleared 1 finished background task notice.");
  assert.equal(statuses.length + 1, rec.events.filter((e) => e.name === "status").length);
});

test("/bg notifies without a turn; /kill stops the whole process group; a timeout fails the task", async (t) => {
  t.after(await tempHome({ plugins: { "background-tasks": dir } }));
  const tmp = await tempDir(t, "hortus-bg-");
  const pidFile = join(tmp, "pid");
  const provider = scripted([]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  t.after(() => agent.close());
  const session = await openSession(null);
  await agent.setSession(session);

  const out = await run(agent, "bg", `--name "Two sleepers" -- sleep 30 & echo $! > ${pidFile}; wait`);
  assert.match(out, /^Started Two sleepers \((b[0-9a-f]{8})\)\nOutput: .*\nCommand: sleep 30 &/);
  const id = /\((b\w+)\)/.exec(out)?.[1] ?? "";
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  assert.ok(alive(grandchild));
  await assert.rejects(run(agent, "kill", "zzz"), /Unknown background task ID: zzz/);
  assert.match(await run(agent, "kill", id), new RegExp(`^Killed Two sleepers \\(${id}\\)`));
  // reaped asynchronously
  await until(() => !alive(grandchild));
  await assert.rejects(run(agent, "kill", id), /is killed, not running/);
  await until(() => notifications(session.getState().messages).length === 1);
  assert.match(notifications(session.getState().messages)[0] ?? "", /<status>killed<\/status>/);
  // display-only: no turn
  assert.equal(provider.requests.length, 0);

  await run(agent, "bg", "--name Slow sleep 5");
  const res = await agent.ctx.runTool({
    id: "x",
    name: "bg_run",
    input: { name: "Too slow", command: "sleep 30", isAgent: false, timeoutSeconds: 1, triggerOnCompletion: false },
  });
  assert.ok(!res.isError, res.output);
  await until(() => notifications(session.getState().messages).length === 2, 5000);
  assert.match(
    notifications(session.getState().messages)[1] ?? "",
    /<status>failed<\/status>[\s\S]*Timed out after 1s/,
  );
  assert.match(await run(agent, "jobs"), /◆ b\w+ running .*— Slow/);
  await agent.close(); // before tempHome's cleanup: closing kills Slow, whose metadata goes to that home
});

test("closing the session kills its tasks without a notification; closing the agent kills the rest", async (t) => {
  t.after(await tempHome({ plugins: { "background-tasks": dir } }));
  const agent = await createAgent({
    extra: [{ name: "scripted", plugin: { providers: { scripted: scripted([]) } } }],
  });
  const first = await openSession(null);
  await agent.setSession(first);
  await run(agent, "bg", "sleep 30");
  const pidA = Number(/pid=(\d+)/.exec(await run(agent, "jobs"))?.[1]);
  await agent.setSession(await openSession(null), "new");
  assert.match(await run(agent, "jobs"), /■ b\w+ killed .*Killed during session shutdown \(new\)/);
  assert.ok(!alive(pidA));
  assert.deepEqual(notifications(first.getState().messages), []);

  await run(agent, "bg", "sleep 31");
  const pidB = Number(/◆ b\w+ running \d+s pid=(\d+)/.exec(await run(agent, "jobs"))?.[1]);
  assert.ok(alive(pidB));
  await agent.close();
  assert.ok(!alive(pidB));
});

test("bg_delegate runs a read-only `hortus -p --json` child seeded with the conversation; bg_result returns its answer", async (t) => {
  // one scripted provider for both processes: the parent's turns (it has bg_delegate), and the child's answer
  const turn = `(req) => {
    const last = req.messages.at(-1);
    if (!req.tools.some((t) => t.name === "bg_delegate"))
      return { text: "child: " + req.tools.map((t) => t.name).join(",") + " | " + req.messages.map((m) => m.role + ": " + (m.content ?? m.text)).join(" / ") };
    if (last.role === "user" && last.content === "the secret is 7") return { text: "ok, noted" };
    if (last.role === "user" && last.content === "go")
      return { toolCalls: [{ id: "d", name: "bg_delegate", input: { name: "Find the secret", prompt: "What is the secret?" } }] };
    if (last.role === "user" && last.meta) {
      const id = /<task-id>(\\w+)<\\/task-id>/.exec(last.content)[1];
      return { toolCalls: [{ id: "r", name: "bg_result", input: { taskId: id } }] };
    }
    const out = last.results[0].output;
    return { text: out.startsWith("Started delegate") ? "waiting" : "parent got: " + out };
  }`;
  t.after(
    await tempHome({
      plugins: { "background-tasks": dir, scripted: scriptedPlugin(`[...Array(10)].map(() => ${turn})`) },
    }),
  );
  const agent = await createAgent();
  t.after(() => agent.close());
  const session = await openSession(null);
  await agent.setSession(session);
  await agent.run("the secret is 7");
  const end = await agent.run("go");
  const receipt = end?.messages.at(-2);
  assert.match(
    receipt?.role === "tool" ? (receipt.results[0]?.output ?? "") : "",
    /^Started delegate Find the secret \(b\w+\) on scripted\/\S+\n/,
  );
  const text = () => session.getState().messages.flatMap((m) => (m.role === "assistant" ? [m.text] : []));
  await until(() => text().some((x) => x.startsWith("parent got:")), 20000);
  const answer = text().find((x) => x.startsWith("parent got:")) ?? "";
  // read-only, a fresh session seeded (`--seed`) with the projection (no tool output, not the delegating message), then
  // the directive
  assert.match(
    answer,
    /^parent got: child: read \| user: the secret is 7 \/ assistant: ok, noted \/ user: go \/ user: The conversation so far .*\n\n<directive>\nWhat is the secret\?\n<\/directive>$/s,
  );
  assert.match(await run(agent, "jobs"), /✓ b\w+ completed .* turns=1 tools=0 — Find the secret/);
});

test("/tasks opens the manager in the TUI: list, detail with the output tail, k stops a task", async (t) => {
  t.after(await tempHome({ plugins: { "background-tasks": dir } }));
  const cli = await startCli({ extra: [{ name: "scripted", plugin: { providers: { scripted: scripted([]) } } }] });
  t.after(() => cli.close());
  const ui = renderApp(cli, { columns: 100, rows: 24 });
  t.after(() => ui.app.unmount());
  cli.submit('/bg --name "Ticker" echo tick; sleep 30');
  await until(() => ui.screen().includes("bg 1 running · /tasks"));
  cli.submit("/tasks");
  await until(() => ui.screen().includes("Background tasks"));
  assert.match(ui.screen(), /◆ running +Ticker \(b\w+\)/);
  ui.keys("\r");
  await until(() => ui.screen().includes("command: echo tick; sleep 30"));
  await until(() => ui.screen().includes("tick"));
  ui.keys("k");
  await until(() => ui.screen().includes("stopped"), 5000);
  ui.keys("\x1b");
  await until(() => !ui.screen().includes("Background tasks"));
  await until(() => ui.screen().includes("[bg killed] Ticker"));
});

test("/bg parses its flags as Pi does", () => {
  assert.deepEqual(parseBgArgs('--agent --name "Docs build" npm run docs'), {
    name: "Docs build",
    isAgent: true,
    command: "npm run docs",
  });
  assert.deepEqual(parseBgArgs("-n=srv -- --x"), { name: "srv", isAgent: false, command: "--x" });
  assert.throws(() => parseBgArgs('--name "unterminated'), /requires a task name/);
});
