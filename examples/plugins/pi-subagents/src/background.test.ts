import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgent, hortusDir, listSessions, type Message, openSession, type Plugin } from "@hortus/core";
import { scriptedPlugin, tempDir, tempHome, until } from "@hortus/core/testing";
import type { RpcRequest, RunRecord } from "./index.tsx";

const dir = fileURLToPath(new URL("..", import.meta.url));
const tui = { kind: "tui", interactive: true };

/** The turns of both processes: the parent's, and its background child's (an `echo` agent's). */
const turns = (flag: string) => `[...Array(30)].map(() => async (req) => {
  const last = req.messages.at(-1);
  const lastUser = req.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
  if (req.system.includes("You echo.")) {
    if (lastUser === "again") return { text: "resumed with " + req.messages.length + " messages" };
    if (lastUser === "slow") {
      const fs = await import("node:fs");
      while (!fs.existsSync(${JSON.stringify(flag)})) await new Promise((r) => setTimeout(r, 50));
      return { text: "child done" };
    }
    if (last.role === "tool") return { text: "child decided: " + last.results[0].output + " tools=" + req.tools.map((t) => t.name).join(","), usage: { input: 5, output: 2, cacheRead: 0 } };
    return { toolCalls: [{ id: "c", name: "contact_supervisor", input: { reason: "need_decision", message: "A or B?" } }] };
  }
  if (last.role === "tool") return { text: "parent ok" };
  if (lastUser.includes("asks its supervisor")) {
    const replyTo = /replyTo: "([^"]+)"/.exec(lastUser)[1];
    return { toolCalls: [{ id: "r", name: "subagent_supervisor", input: { action: "reply", replyTo, message: "B" } }] };
  }
  if (lastUser.startsWith("Background subagent")) return { text: "noted" };
  return { toolCalls: [{ id: "s", name: "subagent", input: { agent: "echo", task: lastUser === "go" ? "pick" : "slow" } }] };
})`;

async function home(t: { after(fn: () => unknown): void }) {
  const flag = join(await tempDir(t, "pi-subagents-flag-"), "go");
  t.after(await tempHome({ plugins: { "pi-subagents": dir, scripted: scriptedPlugin(turns(flag)) } }));
  await mkdir(join(hortusDir(), "agents"), { recursive: true });
  await writeFile(
    join(hortusDir(), "agents", "echo.md"),
    "---\nname: echo\ndescription: Echoes\ntools: read\n---\n\nYou echo.\n",
  );
  return flag;
}

const notices = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "user" && m.meta?.type === "notify" ? [m.content] : []));

test("a background child in its own hortus --rpc: its supervisor question is relayed to the parent model and answered, its result wakes the parent, resume continues its session", async (t) => {
  await home(t);
  const events: string[] = [];
  const bus: Plugin = {
    on: {
      "subagent:async-started": ({ run }) => void events.push(`started ${run.agent}`),
      "subagent:async-complete": ({ run }) => void events.push(`complete ${run.agent} ${run.status}`),
    },
  };
  const agent = await createAgent({ host: tui, extra: [{ name: "bus", plugin: bus }] });
  t.after(() => agent.close());
  const session = await openSession(null);
  await agent.setSession(session);
  await agent.run("go");
  const messages = () => session.getState().messages;
  const started = messages().find((m) => m.role === "tool");
  const out = started?.role === "tool" ? (started.results[0]?.output ?? "") : "";
  const id = /as (\w+)\./.exec(out)?.[1] ?? "";
  assert.match(out, /^Started echo in the background as \w+\. Its result arrives as a message/);

  await until(() => notices(messages()).length === 1, 30000);
  const relay = messages().find((m) => m.role === "user" && m.meta?.type === "supervisor");
  assert.match(
    relay?.role === "user" ? relay.content : "",
    /^Subagent echo \(\w+\) asks its supervisor \(need_decision\):\n\necho asks: A or B\?/,
  );
  assert.match(
    notices(messages())[0] ?? "",
    new RegExp(
      `^Background subagent echo \\(${id}\\) completed\\.\\n\\nchild decided: Supervisor reply: B tools=read,contact_supervisor\\n\\nParent action:`,
    ),
  );
  assert.deepEqual(events, ["started echo", "complete echo completed"]);
  // its tokens count toward the parent session, as a foreground child's do
  assert.deepEqual(session.getState().usage, { input: 5, output: 2, cacheRead: 0 });

  // over the bus: status (with the child's transcript, from its own session file), then resume
  const rpc = async (method: string, params = {}) => {
    const req: RpcRequest = { version: 1, requestId: method, method, params };
    await agent.ctx.emit("subagents:rpc:v1:request", req);
    assert.ok(req.reply?.success, JSON.stringify(req.reply));
    return req.reply.data as { run: RunRecord; text: string };
  };
  const status = await rpc("status", { id });
  assert.equal(status.run.status, "completed");
  assert.match(
    status.text,
    /transcript:\nuser: pick\ntool: contact_supervisor\nresult: Supervisor reply: B\nassistant: child decided/,
  );
  // a session of its own (`--parent`: among this session's children, not listed at the top), titled after its agent and task
  assert.equal(
    (await listSessions({ parent: session.id })).find((s) => s.id === status.run.session?.id)?.title,
    "echo: pick",
  );
  assert.ok(!(await listSessions()).some((s) => s.id === status.run.session?.id));
  await rpc("resume", { id, message: "again" });
  await until(() => notices(messages()).length === 2, 30000);
  assert.match(
    notices(messages())[1] ?? "",
    /^Background subagent echo \(\w+\) completed\.\n\nresumed with 5 messages/,
  );
  // before the temp home goes (the after hooks run in order): nothing still writes into it
  await agent.close();
});

test("a background child outlives its parent's exit, and its result reaches the session when it is opened again", async (t) => {
  const flag = await home(t);
  const a = await createAgent({ host: tui });
  const session = await openSession(null);
  await a.setSession(session);
  await a.run("go slow");
  const runs = () => (session.getState().data["pi-subagents"] as { runs: Record<string, RunRecord> }).runs;
  const run = Object.values(runs())[0];
  assert.equal(run?.status, "running");
  // exit while it runs: it keeps going (its stdin closes, so it ends after this run)
  await a.close();
  const alive = () => {
    try {
      return process.kill(run?.pid ?? 0, 0);
    } catch {
      return false;
    }
  };
  assert.ok(alive());
  await writeFile(flag, "");
  await until(() => !alive(), 20000);

  const b = await createAgent({ host: tui });
  t.after(() => b.close());
  const info = (await listSessions()).find((s) => s.id === session.id);
  const reopened = await openSession(info?.leafId ?? "");
  await b.setSession(reopened);
  await until(() => notices(reopened.getState().messages).length === 1, 20000);
  assert.match(
    notices(reopened.getState().messages)[0] ?? "",
    /^Background subagent echo \(\w+\) completed\.\n\nchild done/,
  );
  await until(() => reopened.getState().messages.at(-1)?.role === "assistant");
  const saved = (reopened.getState().data["pi-subagents"] as { runs: Record<string, RunRecord> }).runs[run?.id ?? ""];
  assert.equal(saved?.delivered, true);
});
