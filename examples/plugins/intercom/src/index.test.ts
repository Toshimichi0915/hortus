import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "@hortus/cli";
import { renderApp, spawnHortus, startCli } from "@hortus/cli/testing";
import { type Agent, createAgent, hortusDir, memorySession, type Plugin, type ToolResult } from "@hortus/core";
import { scriptedPlugin, tempHome, until } from "@hortus/core/testing";
import { type FromBroker, lines, type Reply, type SessionInfo, write } from "./protocol.ts";

// every hortus (spawned or in-process) answers by the last message: the scripted "model" of each peer
const RULE = `(req) => {
  const last = req.messages.at(-1);
  const said = last.role === "user" ? last.content : "";
  const call = (input) => ({ toolCalls: [{ id: "c" + Math.random().toString(36).slice(2), name: "intercom", input }] });
  if (said === "delegate") return call({ action: "ask", to: "worker", message: "Which API?" });
  if (said.includes("Which API?")) return call({ action: "reply", message: "Stable API" });
  if (said.includes("ping")) return call({ action: "send", to: "alpha", message: "pong" });
  if (said.includes("Which version?")) return call({ action: "send", to: "alpha", message: "v2" });
  if (last.role === "tool") return { text: "done: " + last.results[0].output };
  return { text: "noted" };
}`;

const home = () =>
  tempHome({
    plugins: {
      intercom: fileURLToPath(new URL("..", import.meta.url)),
      scripted: scriptedPlugin(`Array.from({ length: 100 }, () => ${RULE})`),
    },
  });

/** the broker's roster, through a client of our own (registered as "observer") */
async function observer(t: { after(fn: () => unknown): void }) {
  const sock = connect(join(hortusDir(), "intercom", "broker.sock"));
  await new Promise((ok, fail) => sock.once("connect", ok).once("error", fail));
  t.after(() => sock.destroy());
  const replies = new Map<number, (r: Reply) => void>();
  const messages: FromBroker[] = [];
  lines(sock, (m) => {
    const msg = m as FromBroker;
    if (msg.type === "reply") replies.get(msg.reqId)?.(msg);
    else messages.push(msg);
  });
  let n = 0;
  const call = (m: object) =>
    new Promise<Reply>((r) => {
      replies.set(++n, r);
      write(sock, { ...m, reqId: n });
    });
  const me: SessionInfo = { id: "observer", name: "observer", cwd: "/", model: "", pid: process.pid, startedAt: 0 };
  await call({ type: "register", session: me });
  return {
    messages,
    send: (to: string, text: string) =>
      call({ type: "send", to, message: { id: `m${Math.random()}`, timestamp: Date.now(), text } }),
    names: async () =>
      ((await call({ type: "list" })).sessions ?? []).map((s) => s.name).filter((x) => x !== "observer"),
  };
}

async function waitFor(fn: () => Promise<boolean>, ms = 15000) {
  for (const end = Date.now() + ms; !(await fn()); await new Promise((r) => setTimeout(r, 50)))
    if (Date.now() > end) throw new Error("waitFor: timed out");
}

/** stops the broker the first session spawned (it would linger for its idle timeout) */
async function stopBroker() {
  const pid = Number(await readFile(join(hortusDir(), "intercom", "broker.pid"), "utf8").catch(() => "0"));
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5000);
  } catch {}
}

const runTool = async (agent: Agent, input: object) =>
  (await agent.ctx.runTool({ id: `t${Math.random()}`, name: "intercom", input })) as ToolResult;
const command = (agent: Agent, name: string, arg = "") => {
  const c = agent.commands().find((c) => c.name === name);
  assert.ok(c, `no /${name}`);
  return c.run(arg);
};

test("two hortus processes: an ask waits for the other's reply, which comes back as its result", async (t) => {
  const restore = await home();
  const planner = spawnHortus(t, ["--rpc", "--name", "planner"]);
  const worker = spawnHortus(t, ["--rpc", "--name", "worker"]);
  t.after(stopBroker);
  t.after(restore);
  await planner.next((l) => l.event === "session_open");
  await worker.next((l) => l.event === "session_open");
  // the first one spawned the broker; both registered under their names
  const roster = await observer(t);
  await waitFor(async () => (await roster.names()).sort().join() === "planner,worker");

  planner.send({ type: "prompt", text: "delegate", id: 1 });
  // the worker's run, started by the ask, replies through the tool...
  const replied = await worker.next((l) => l.event === "tool_result" && l.payload.call.input.action === "reply");
  assert.match(replied.payload.result.output, /^Reply sent to planner \(/);
  // ...and the planner's ask resolves with it, in the same turn
  const done = await planner.next((l) => l.response === "prompt" && l.id === 1, 20000);
  const last = done.messages.at(-1);
  assert.equal(last.text, "done: Reply from worker: Stable API");
  // the worker's transcript holds the ask as an intercom message, with the reply hint
  const asked = (await worker.next((l) => l.event === "run_end")).payload.messages.find(
    (m: { meta?: { plugin: string } }) => m.meta?.plugin === "intercom",
  );
  assert.match(
    asked.content,
    /^\*\*From planner\*\* \(.*\)\n\nTo reply, use the intercom tool: intercom\(\{ action: "reply"/,
  );
  assert.match(asked.content, /Which API\?$/);
  assert.equal(asked.meta.details.message.expectsReply, true);
});

test("an in-process agent and a hortus process: send, inferred replies, mailbox, cancel, pools, outbox", async (t) => {
  const restore = await home();
  const agent = await createAgent({ provided: { "@hortus/cli": version } });
  t.after(() => agent.close());
  const session = memorySession();
  await agent.setSession(session);
  assert.equal(await command(agent, "alias", "alpha"), "Alias: alpha");
  let beta = spawnHortus(t, ["--rpc", "--session", "key:beta", "--name", "beta"]);
  t.after(stopBroker);
  t.after(restore);
  const roster = await observer(t);
  await waitFor(async () => (await roster.names()).sort().join() === "alpha,beta");

  const listed = (await runTool(agent, { action: "list" })).output;
  assert.match(listed, /\*\*Current session:\*\*\n• alpha \(\w{8}\) — .* \[self, tool:intercom\]/);
  assert.match(listed, /\*\*Other sessions:\*\*\n[\s\S]*• beta \(\w{8}\) — .* \(scripted\) \[same cwd, idle\]/);
  assert.match(
    (await runTool(agent, { action: "status" })).output,
    /^Connected: Yes, .*Name: alpha, Pool: default, Active sessions: 3$/,
  );

  // a user's /intercom send starts a run there; its answer starts one here
  assert.match((await command(agent, "intercom", "beta ping")) ?? "", /^Message sent to beta \(/);
  await until(() => session.getState().messages.some((m) => m.role === "assistant" && m.text === "noted"), 15000);
  const pong = session.getState().messages.find((m) => m.role === "user" && m.meta?.type === "message");
  assert.match(pong?.role === "user" ? pong.content : "", /^\*\*From beta\*\*[\s\S]*\n\npong$/);

  // an ask here; beta answers with a plain send, which is inferred as the reply to its single pending ask
  assert.equal(
    (await runTool(agent, { action: "ask", to: "beta", message: "Which version?" })).output,
    "Reply from beta: v2",
  );
  const inferred = await beta.next((l) => l.event === "tool_result" && l.payload.call.input.message === "v2");
  assert.equal(inferred.payload.result.output, "Reply sent to alpha (inferred from pending ask)");

  // an ask needs a connected target; reply needs something to reply to
  assert.match(
    (await runTool(agent, { action: "ask", to: "nobody", message: "?" })).output,
    /Session not found: nobody/,
  );
  assert.match((await runTool(agent, { action: "reply", message: "?" })).output, /Nothing to reply to/);

  // pools: in another one, beta is out of sight
  assert.equal(await command(agent, "intercom-pool", "red"), "Intercom pool: red");
  assert.doesNotMatch((await runTool(agent, { action: "list" })).output, /beta/);
  assert.equal(await command(agent, "intercom-pool", "default"), "Intercom pool: default");

  // the outbox: another plugin sends through this session
  const out: { plugin: string; to: string; message: string; result?: { ok: boolean } } = {
    plugin: "test",
    to: "beta",
    message: "from a plugin",
  };
  await agent.ctx.emit("intercom_send", out);
  assert.equal(out.result?.ok, true);
  await beta.next((l) => l.event === "message" && l.payload.content?.endsWith("from a plugin"));

  // a handover: this session summarized by its model (the scripted one says "noted"), under a header
  assert.match(
    (await runTool(agent, { action: "handover", to: "beta", message: "port the fix" })).output,
    /^Handover sent to beta/,
  );
  const handed = await beta.next((l) => l.event === "message" && l.payload.content?.includes("# Handover from alpha"));
  assert.match(handed.payload.content, /Treat this as a peer's report[\s\S]*\n\nnoted$/);

  // beta leaves: mail for it waits in the broker; a queued message can still be cancelled
  beta.send({ type: "exit" });
  assert.equal(await beta.exit, 0);
  await waitFor(async () => !(await roster.names()).includes("beta"));
  const queued = (await runTool(agent, { action: "send", to: "beta", message: "cancel me" })).output;
  assert.match(queued, /^beta is not connected: the message \((.+)\) waits for it to reconnect$/);
  const id = queued.match(/\((.+)\)/)?.[1];
  assert.equal(
    (await runTool(agent, { action: "cancel", messageId: id })).output,
    `Message ${id} was still queued: cancelled`,
  );
  await runTool(agent, { action: "send", to: "beta", message: "while you were away" });

  // back on the same session, it gets what waited (and not the cancelled one)
  beta = spawnHortus(t, ["--rpc", "--session", "key:beta"]);
  const got = await beta.next((l) => l.event === "message" && l.payload.meta?.plugin === "intercom", 20000);
  assert.match(got.payload.content, /while you were away$/);
  await beta.next((l) => l.event === "run_end");
  assert.ok(!beta.stdout().includes("cancel me"));

  // what was sent is recorded in the session
  assert.ok(session.entries().some((e) => "type" in e && e.type === "intercom:sent"));
});

test("the TUI: Alt+M picks a peer and sends what's typed; an incoming message shows as its own block", async (t) => {
  const restore = await home();
  const cli = await startCli();
  t.after(stopBroker);
  t.after(restore);
  t.after(() => cli.close());
  const ui = renderApp(cli, { columns: 80, rows: 24 });
  t.after(() => ui.app.unmount());
  cli.submit("/alias tui");
  const peer = await observer(t);
  await waitFor(async () => (await peer.names()).includes("tui"));

  ui.keys("\x1bm");
  await until(() => /Send to which session\?[\s\S]*observer \(observer\)/.test(ui.screen()), 5000);
  ui.keys("\r");
  await until(() => /Message to the session/.test(ui.screen()), 5000);
  ui.keys("hello there");
  await new Promise((r) => setTimeout(r, 20)); // separate key chunks
  ui.keys("\r");
  await until(() => peer.messages.length > 0, 5000);
  const got = peer.messages[0];
  assert.equal(got?.type === "message" && got.message.text, "hello there");
  assert.equal(got?.type === "message" && got.from.name, "tui");

  // the reply starts a run in the TUI; its message is drawn by the plugin's renderer
  await peer.send("tui", "thanks, on it");
  await until(() => /✉ observer \/\n[\s\S]*thanks, on it/.test(ui.screen()), 5000);
  await until(() => /noted/.test(ui.screen()), 5000);
  assert.doesNotMatch(ui.screen(), /To reply, use the intercom tool/);
});

test("busyDelivery human-first: a message arriving mid-run waits while a person's input is pending, then comes once idle", async (t) => {
  const restore = await home();
  await mkdir(join(hortusDir(), "intercom"), { recursive: true });
  await writeFile(join(hortusDir(), "intercom", "config.json"), JSON.stringify({ busyDelivery: "human-first" }));
  // the first request waits until released, so the run is busy when the message arrives
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let first = true;
  const hold: Plugin = {
    on: {
      request: async () => {
        if (!first) return;
        first = false;
        await held;
      },
    },
  };
  const agent = await createAgent({
    provided: { "@hortus/cli": version },
    host: { kind: "test", interactive: true },
    extra: [{ name: "hold", plugin: hold }],
  });
  t.after(() => agent.close());
  t.after(stopBroker);
  t.after(restore);
  const session = memorySession();
  await agent.setSession(session);
  assert.equal(await command(agent, "alias", "alpha"), "Alias: alpha");
  const roster = await observer(t);
  await waitFor(async () => (await roster.names()).join() === "alpha");
  const run = agent.run("hello");
  await until(() => agent.ctx.busy());
  // a person's input waits for the run's end; the peer's message arrives meanwhile
  void agent.ctx.send("person first", { deliver: "after", source: "user" });
  await roster.send("alpha", "fyi");
  await new Promise((r) => setTimeout(r, 200));
  release();
  await run;
  const users = () =>
    session.getState().messages.flatMap((m) => (m.role === "user" ? [m.meta ? "intercom" : m.content] : []));
  await until(() => users().length === 3, 15000);
  // human-first: the person's turn, then the peer's message (steering would have put it in the first run)
  assert.deepEqual(users(), ["hello", "person first", "intercom"]);
});
