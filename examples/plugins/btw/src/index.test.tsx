import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderApp, startCli } from "@hortus/cli/testing";
import { type CompletionRequest, createAgent, type Message, openSession } from "@hortus/core";
import { scripted, type Turn, tempHome, until } from "@hortus/core/testing";
import { SYSTEM_PROMPT, thread, uiOf } from "./index.tsx";

const dir = fileURLToPath(new URL("..", import.meta.url));
const texts = (req?: CompletionRequest) =>
  (req?.messages ?? []).map((m: Message) => (m.role === "user" ? m.content : m.role === "assistant" ? m.text : "tool"));

/** A gate a scripted turn waits on, so the main run stays busy until the test opens it. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return {
    open,
    wait:
      (text: string): Turn =>
      async () => {
        await opened;
        return { text };
      },
  };
}

async function headless(t: { after: (fn: () => Promise<void>) => void }, turns: Turn[]) {
  t.after(await tempHome({ plugins: { btw: dir } }));
  const provider = scripted(turns);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  const session = await openSession(null);
  await agent.setSession(session);
  const cmd = (name: string, arg = "") => {
    const c = agent.commands().find((c) => c.name === name);
    if (!c) throw new Error(`no /${name}`);
    return c.run(arg);
  };
  return { agent, provider, session, cmd };
}

test("headless: /btw answers aside while the main run goes on, from the main context; follow-ups continue the thread", async (t) => {
  const g = gate();
  const { agent, provider, session, cmd } = await headless(t, [
    { text: "main answer" },
    g.wait("main done"), // the second main run, held
    { text: "side answer" },
    { text: "follow-up answer" },
    { text: "next main" },
  ]);
  await agent.run("main question");
  const main = agent.run("keep working");
  await until(() => provider.requests.length === 2);

  // while the main run is busy, /btw runs its own (child) run, seeded with the main conversation
  assert.equal(
    await cmd("btw", "--save what file?"),
    "BTW response queued to display after the current turn finishes.",
  );
  assert.equal(agent.ctx.busy(), true);
  const child = provider.requests[2];
  assert.ok(child?.system.endsWith(SYSTEM_PROMPT));
  assert.deepEqual(texts(child), ["main question", "main answer", "keep working", "what file?"]);
  assert.deepEqual(
    child?.tools.map((x) => x.name),
    ["read", "write", "edit", "bash"],
  );
  assert.deepEqual(
    thread(session.getState()).exchanges.map((e) => [e.question, e.answer]),
    [["what file?", "side answer"]],
  );

  // a follow-up continues the same child session
  assert.equal(await cmd("btw", "and why?"), "BTW response queued to display after the current turn finishes.");
  assert.deepEqual(texts(provider.requests[3]).slice(3), ["what file?", "side answer", "and why?"]);

  g.open();
  await main;
  // the thread is hidden entries; the --save note (and the headless display notes) are in the session, not the context
  const notes = session.getState().messages.filter((m) => m.role === "user" && m.meta?.type === "note");
  assert.equal(notes.length, 2);
  assert.match(notes[0]?.role === "user" ? notes[0].content : "", /\*\*Answer\*\*\n\nside answer/);
  await agent.run("go on");
  assert.deepEqual(texts(provider.requests[4]), ["main question", "main answer", "keep working", "main done", "go on"]);
  assert.equal(thread(session.getState()).exchanges.length, 2);
});

test("headless: tangent has no main context, ask is read-only, and switching mode clears the thread", async (t) => {
  const { agent, provider, session, cmd } = await headless(t, [
    { text: "main answer" },
    { text: "tangent answer" },
    { text: "ro answer" },
  ]);
  await agent.run("main question");
  await cmd("btw:tangent", "brainstorm");
  assert.deepEqual(texts(provider.requests[1]), ["brainstorm"]);
  assert.equal(thread(session.getState()).mode, "tangent");

  await cmd("btw:ask", "what does it do?");
  assert.deepEqual(texts(provider.requests[2]), ["main question", "main answer", "what does it do?"]);
  assert.deepEqual(
    provider.requests[2]?.tools.map((x) => x.name),
    ["read"],
  );
  assert.deepEqual(
    thread(session.getState()).exchanges.map((e) => e.question),
    ["what does it do?"],
  );
  await assert.rejects(cmd("btw"), /Pass the question inline/);
});

test("headless: /btw:inject hands the thread to the main agent; /btw:summarize sends a summary made with effort off", async (t) => {
  const { provider, session, cmd } = await headless(t, [
    { text: "side 1" },
    { text: "main reply" },
    { text: "side 2" },
    { text: "the summary" },
    { text: "main reply 2" },
  ]);
  await cmd("btw", "q1");
  assert.equal(await cmd("btw:inject", "do it"), "Injected BTW thread (1 exchange).");
  await until(() => provider.requests.length === 2);
  assert.equal(
    texts(provider.requests[1]).at(-1),
    "Here is a side conversation I had. do it\n\nUser: q1\nAssistant: side 1",
  );
  assert.equal(thread(session.getState()).exchanges.length, 0);
  await until(() => session.getState().messages.at(-1)?.role === "assistant");

  await cmd("btw", "q2");
  // the thread was cleared: the new child doesn't continue the old one
  assert.deepEqual(texts(provider.requests[2]).slice(1), ["main reply", "q2"]);
  assert.equal(await cmd("btw:summarize"), "Injected BTW summary (1 exchange).");
  assert.equal(provider.requests[3]?.effort, "off");
  assert.match(provider.requests[3]?.system ?? "", /^Summarize the side conversation/);
  await until(() => provider.requests.length === 5);
  assert.equal(texts(provider.requests[4]).at(-1), "Here is a summary of a side conversation I had:\n\nthe summary");
  assert.equal(await cmd("btw:inject"), undefined); // nothing left: a warning, no send
});

test("headless: /btw:model and /btw:thinking set per-thread overrides the child uses", async (t) => {
  const { provider, session, cmd } = await headless(t, [{ text: "a" }]);
  assert.equal(await cmd("btw:model"), "BTW model: scripted/scripted (inherits main thread).");
  assert.equal(await cmd("btw:model", "scripted/other"), "BTW model override set to scripted/other.");
  await assert.rejects(cmd("btw:thinking", "loud"), /Usage/);
  assert.equal(await cmd("btw:thinking", "high"), "BTW thinking override set to high.");
  await cmd("btw", "q");
  assert.equal(provider.requests[0]?.model, "other");
  assert.equal(provider.requests[0]?.effort, "high");
  assert.deepEqual(thread(session.getState()).model, { provider: "scripted", model: "other" });
  await cmd("btw:model", "clear");
  await cmd("btw:thinking", "clear");
  assert.equal(thread(session.getState()).model, undefined);
  assert.equal(thread(session.getState()).effort, undefined);
});

test("TUI: /btw while the main turn runs shows the answer in the panel; the focused prompt asks follow-ups; Esc dismisses", async (t) => {
  t.after(await tempHome({ plugins: { btw: dir } }));
  const g = gate();
  const provider = scripted([g.wait("main done"), { text: "side answer" }, { text: "second answer" }]);
  const cli = await startCli({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  const ui = renderApp(cli, { columns: 80, rows: 30 });
  const getUi = () => uiOf(cli.agent.ctxOf?.("btw") ?? cli.agent.ctx).getState();
  t.after(() => ui.app.unmount());

  cli.submit("work");
  await until(() => provider.requests.length === 1);
  assert.equal(cli.ui.getState().busy, true);
  cli.submit("/btw --save what file?");
  await until(() => ui.screen().includes("note queued"));
  assert.match(ui.screen(), /BTW[\s\S]*› what file\?[\s\S]*side answer[\s\S]*Esc dismiss/);
  assert.equal(cli.ui.getState().busy, true); // the main turn still runs

  // the focused panel takes plain prompts: a follow-up in the thread, not a main turn
  assert.equal(cli.submit("and then?"), true);
  await until(() => ui.screen().includes("second answer"));
  assert.match(texts(provider.requests[2]).join("|"), /what file\?\|side answer\|and then\?$/);

  // Alt+/ gives the prompt back to the main thread
  ui.keys("\x1b/");
  await until(() => !getUi().focused);
  assert.match(ui.screen(), /Alt\+\/ focus BTW/);

  g.open();
  await until(() => !cli.ui.getState().busy);
  // the --save note shows in the transcript after the turn
  await until(() => ui.screen().includes("[BTW]"));

  ui.keys("\x1b/");
  await until(() => getUi().focused);
  ui.keys("\x1b");
  await until(() => !getUi().open);
  await until(() => !/Esc dismiss/.test(ui.screen()), 5000);
  await cli.close();
});
