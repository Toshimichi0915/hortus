import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startCli } from "@hortus/cli/testing";
import { listSessions } from "@hortus/core";
import { scriptedPlugin, tempDir, tempHome, until } from "@hortus/core/testing";
import { type ChatMessage, type Gateway, startHub } from "./hub.ts";

const home = () =>
  tempHome({
    plugins: {
      "session-hub": fileURLToPath(new URL("..", import.meta.url)),
      // every process (workers, the in-process TUIs) echoes the last message
      scripted: scriptedPlugin(
        `Array.from({ length: 50 }, () => (req) => ({ text: "echo: " + req.messages.at(-1).content }))`,
      ),
    },
  });

/** A gateway that is only this test: `say` is a chat message in, `sent` what the hub sent out. */
function fakeGateway() {
  let handler: (m: ChatMessage) => void = () => {};
  const sent: ChatMessage[] = [];
  const gw: Gateway = {
    onMessage: (h) => {
      handler = h;
    },
    send: async (route, text) => void sent.push({ route, text }),
  };
  /** sends `text` from chat `route` and resolves with the hub's reply */
  const ask = async (route: string, text: string) => {
    const n = sent.length;
    handler({ route, text });
    await until(() => sent.length > n, 20000);
    return sent[n]?.text ?? "";
  };
  return { gw, ask };
}

test("chat commands drive background `hortus --rpc` sessions", async (t) => {
  t.after(await home());
  const dir = await tempDir(t);
  const { gw, ask } = fakeGateway();
  const hub = await startHub(gw, { cwd: dir });
  t.after(hub.close);
  await assert.rejects(startHub(fakeGateway().gw), /already running/);

  assert.equal(await ask("bob", "/last"), "Error: This chat has no session yet: send a message or /new");
  assert.equal(await ask("alice", "hi"), "echo: hi"); // a chat with no session gets one
  assert.match(await ask("alice", "/new --name Bugfix"), /^New session #2 Bugfix/);
  assert.equal(await ask("alice", "fix it"), "echo: fix it");
  assert.ok(
    (await listSessions()).some((s) => s.title === "Bugfix"),
    "--name titles the session",
  );
  assert.equal(
    await ask("alice", "/sessions"),
    "| # | Title | Mode | State |\n|---|---|---|---|\n| 1 | hi | background | idle |\n| 2 | Bugfix (current) | background | idle |",
  );
  assert.equal(
    await ask("alice", "/last 1"),
    "Session #1 hi · background\n\nYou:\nhi\nAI:\necho: hi\n\nSend /resume 1 to switch to it.",
  );
  assert.equal(await ask("alice", '/resume "Bugfix"'), "Switched to session #2 Bugfix.\nLast reply:\necho: fix it");
  assert.equal(await ask("alice", "/stop 1"), "Stopped session #1.");
  assert.match(await ask("alice", "/sessions"), /\| 1 \| hi \| saved \| idle \|/);
  // a stopped session comes back in a new worker, on the same session file
  await ask("alice", "/resume 1");
  assert.equal(await ask("alice", "again"), "echo: again");
  assert.match(await ask("alice", "/last"), /You:\nagain\nAI:\necho: again\n\nSend anything to go on\.$/);
  assert.equal((await listSessions()).length, 2);
  assert.equal(await ask("alice", "/bash rm -rf /"), "Unknown command: /bash. Send /help for the list.");
  assert.match(await ask("alice", "/status"), /2 sessions · 2 background, 0 in a TUI\nThis chat: #1 hi · background/);
});

test("a TUI that resumes a hub session takes it over, and hands it back when it leaves; a second TUI can't resume it", async (t) => {
  t.after(await home());
  const { gw, ask } = fakeGateway();
  const hub = await startHub(gw, { cwd: await tempDir(t) });
  t.after(hub.close);
  assert.equal(await ask("alice", "hi"), "echo: hi");
  const id = (await listSessions())[0]?.id ?? "";

  const cli = await startCli();
  t.after(() => cli.close());
  assert.ok(cli.submit(`/resume ${id}`));
  await until(() => cli.session.id === id, 5000);
  assert.equal(cli.ui.getState().statuses["session-hub"]?.text, "chat: attached");
  assert.match(await ask("alice", "/sessions"), /\| 1 \| hi \(current\) \| TUI \| idle \|/);

  // the chat's messages now run in the TUI, and its replies go back to the chat
  assert.equal(await ask("alice", "from phone"), "echo: from phone");
  assert.deepEqual(
    cli.session.getState().messages.map((m) => (m.role === "user" ? m.content : m.role === "assistant" && m.text)),
    ["hi", "echo: hi", "from phone", "echo: from phone"],
  );

  // a second TUI resuming it is cancelled (session_close.cancel): one writer per session
  const other = await startCli();
  t.after(() => other.close());
  const before = other.session.id;
  assert.ok(other.submit(`/resume ${id}`));
  const texts = () => other.ui.getState().entries.map((e) => ("text" in e ? e.text : ""));
  await until(() => texts().includes("A plugin kept the current session"), 5000);
  assert.ok(texts().some((t) => t.includes("open in another TUI")));
  assert.equal(other.session.id, before);

  // leaving it hands it back to a background worker
  assert.ok(cli.submit("/new"));
  await until(() => cli.session.id !== id, 5000);
  assert.equal(await ask("alice", "back"), "echo: back");
  assert.match(await ask("alice", "/sessions"), /\| 1 \| hi \(current\) \| background \| idle \|/);
});
