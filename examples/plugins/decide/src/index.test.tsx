import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type AskEvent, createAgent, openSession } from "@hortus/core";
import { scripted, tempHome, until } from "@hortus/core/testing";
import { renderApp, startCli } from "@hortus/cli/testing";
import { configPath } from "./index.tsx";

const dir = fileURLToPath(new URL("..", import.meta.url));

const cache = {
  question: "Which cache eviction policy should the session store use?",
  header: "Cache",
  options: [
    { label: "LRU", description: "Evict the least recently used entry." },
    { label: "TTL 5m", description: "Expire entries after five minutes." },
  ],
  recommended: "TTL 5m",
  recommendedBecause: "sessions are short",
};
const scope = {
  question: "Which stores should get the cache?",
  header: "Scope",
  multiSelect: true,
  options: [
    { label: "Session store", description: "Only the session store." },
    { label: "User store", description: "The user store as well." },
  ],
};
const call = (input: unknown) => ({ id: "1", name: "ask_user_question", input });

/** The output of the tool result the model got in its `i`th request. */
const sent = (provider: ReturnType<typeof scripted>, i: number) => {
  const m = provider.requests[i]?.messages.at(-1);
  return m?.role === "tool" ? (m.results[0]?.output ?? "") : "";
};

const setup = async (t: { after: (fn: () => unknown) => void }, config: object = {}) => {
  t.after(await tempHome({ plugins: { decide: dir } }));
  await writeFile(configPath(), JSON.stringify({ ui: { bell: false }, ...config }));
};

test("headless: the autopilot answers, the judge deciding only the question without a recommendation", async (t) => {
  await setup(t);
  const provider = scripted([
    { toolCalls: [call({ questions: [cache, scope], context: "adding a cache" })] },
    // the judge (ctx.complete) sees only Scope, as its question 1
    (req) => {
      const user = req.messages[0];
      assert.equal(user?.role === "user" && user.content.includes("Q1 [Scope]"), true);
      assert.doesNotMatch(user?.role === "user" ? user.content : "", /\[Cache\]/);
      return {
        text: '{"summary":"small cache","recommendations":[{"question":1,"selected":["user store","Session store"],"reason":"both"}]}',
      };
    },
    { text: "done" },
  ]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  await agent.run("add a cache");
  const out = sent(provider, 2);
  assert.match(out, /^These answers were chosen by the autopilot, not by the user: small cache\./);
  assert.match(out, /- Cache: "TTL 5m" \[autopilot\]/);
  assert.match(out, /- Scope: "Session store", "User store" \[autopilot\]/);
});

test("the safety rail steers an irreversible choice to the cautious option, and refuses when there is none", async (t) => {
  await setup(t);
  const drop = {
    question: "What should happen to the old table?",
    header: "Old table",
    options: [
      { label: "Drop it", description: "rm -rf the data directory." },
      { label: "Back up first", description: "Dump it, then decide." },
    ],
    recommended: "Drop it",
  };
  const push = {
    question: "How should the branch be updated?",
    header: "Push",
    options: [
      { label: "Force push", description: "Rewrite the remote." },
      { label: "Force push with lease", description: "Rewrite unless someone pushed." },
    ],
    recommended: "Force push",
  };
  const provider = scripted([
    { toolCalls: [call({ questions: [drop] })] },
    { toolCalls: [call({ questions: [push] })] },
    { text: "ok" },
  ]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  await agent.run("clean up");
  assert.match(sent(provider, 1), /- Old table: "Back up first" \[autopilot\]/);
  assert.match(sent(provider, 1), /Safety rail: Old table was steered to the cautious option "Back up first"/);
  assert.match(sent(provider, 2), /^The autopilot REFUSED to answer/);
  assert.match(sent(provider, 2), /Unanswered: Push/);
});

test("an invalid questionnaire is an error result and asks nothing", async (t) => {
  await setup(t, { limits: { maxQuestions: 1 } });
  const provider = scripted([{ toolCalls: [call({ questions: [cache, scope] })] }, { text: "ok" }]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  await agent.run("x");
  const m = provider.requests[1]?.messages.at(-1);
  assert.equal(m?.role === "tool" && m.results[0]?.isError, true);
  assert.match(sent(provider, 1), /At most 1 questions are allowed per invocation \(got 2\)/);
});

test("an interactive host without the dialog gets one generic ask per question, answered by whoever answers", async (t) => {
  await setup(t);
  const asked: AskEvent[] = [];
  const answerer = {
    on: {
      ask: (e: AskEvent) => {
        asked.push(e);
        e.resolve(e.multi ? ["User store"] : "LRU");
      },
    },
  };
  const provider = scripted([{ toolCalls: [call({ questions: [cache, scope] })] }, { text: "ok" }]);
  const agent = await createAgent({
    host: { kind: "rpc", interactive: true },
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider } } },
      { name: "answerer", plugin: answerer },
    ],
  });
  await agent.run("x");
  assert.deepEqual(
    asked.map((e) => [e.kind, e.question.split("\n")[0], e.options?.map((o) => o.label), e.multi]),
    [
      ["decide", cache.question, ["LRU", "TTL 5m"], undefined],
      ["decide", scope.question, ["Session store", "User store"], true],
    ],
  );
  assert.match(asked[0]?.options?.[1]?.description ?? "", /★ recommended/);
  assert.equal(sent(provider, 1), 'Answers:\n- Cache: "LRU"\n- Scope: "User store"');
});

test("/decide sets this session's policy and its status badge", async (t) => {
  await setup(t);
  const statuses: (string | undefined)[] = [];
  const agent = await createAgent({
    host: { kind: "rpc", interactive: true },
    extra: [{ name: "watch", plugin: { on: { status: (e) => void (e.key === "decide" && statuses.push(e.text)) } } }],
  });
  await agent.setSession(await openSession(null), "new");
  const decide = agent.commands().find((c) => c.name === "decide");
  assert.ok(decide);
  assert.match((await decide.run("auto 30")) ?? "", /ask, then self-answer after 30s/);
  assert.match((await decide.run("status")) ?? "", /session mode: auto[\s\S]*session auto delay: 30s/);
  await decide.run("on");
  await decide.run("reset");
  // session_open paints the default (no badge) first
  assert.deepEqual(statuses, [undefined, "🤖 auto:30s*", "🤖 auto*", undefined]);
  await assert.rejects(decide.run("bogus"), /Usage: \/decide/);
});

/** The TUI on a real agent, in a fake terminal. */
async function tui(t: { after: (fn: () => unknown) => void }, provider: ReturnType<typeof scripted>) {
  const cli = await startCli({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  const ui = renderApp(cli, { columns: 100, rows: 40 });
  t.after(() => ui.app.unmount());
  // each key redraws the dialog: the next one is sent once this one took effect
  const key = async (k: string) => {
    const before = ui.screen();
    ui.keys(k);
    await until(() => ui.screen() !== before);
  };
  return { cli, screen: ui.screen, key };
}

const DOWN = "\x1b[B";
const ENTER = "\r";

test("TUI: the rich dialog takes every answer, a typed one and notes included, and the model sees the user's", async (t) => {
  await setup(t);
  const provider = scripted([{ toolCalls: [call({ questions: [cache, scope] })] }, { text: "ok" }]);
  const { cli, screen, key } = await tui(t, provider);
  cli.submit("add a cache");
  await until(() => screen().includes("Which cache eviction policy"));
  const first = screen();
  assert.match(first, /□ Cache\s+□ Scope\s+✔ Submit/);
  assert.match(first, /2\. TTL 5m ★/);
  assert.match(first, /3\. Type something\./);
  assert.match(first, /nobody answered — autopilot takes over in 900s/);
  await key(DOWN); // a key: the human is here, the countdown stops
  assert.doesNotMatch(screen(), /autopilot takes over/);
  await key(ENTER); // TTL 5m, then on to Scope
  assert.match(screen(), /Which stores should get the cache\?/);
  assert.match(screen(), /▢ Session store/);
  await key(" "); // tick Session store
  assert.match(screen(), /✓ Session store/);
  await key("n"); // a note on this answer
  await key("hot writes"); // typed as one chunk: a lone space would redraw nothing
  await key(ENTER);
  await key(ENTER); // submit the ticked one: on to the Submit tab
  assert.match(
    screen(),
    /Review before submitting[\s\S]*Cache TTL 5m[\s\S]*Scope Session store[\s\S]*note: hot writes/,
  );
  await key("n"); // a global note
  await key("ship it"); // typed as one chunk: a lone space would redraw nothing
  await key(ENTER);
  await key(ENTER);
  await until(() => provider.requests.length === 2);
  assert.equal(
    sent(provider, 1),
    'Answers:\n- Cache: "TTL 5m"\n- Scope: "Session store"\n      user note: hot writes\n\nGlobal note: ship it',
  );
  assert.doesNotMatch(screen(), /collapse \]/);
});

test("TUI: a typed answer replaces the options; c collapses the dialog to one line; Esc cancels", async (t) => {
  await setup(t);
  const provider = scripted([
    { toolCalls: [call({ questions: [cache] })] },
    { toolCalls: [call({ questions: [cache] })] },
    { text: "ok" },
  ]);
  const { cli, screen, key } = await tui(t, provider);
  cli.submit("x");
  await until(() => screen().includes("Which cache eviction policy"));
  await key("c");
  assert.match(
    screen(),
    /\[ \+ expand \] ask_user_question · Cache · 0\/1 answered · ⏱ 900s · ctrl\+\] or c to expand/,
  );
  assert.doesNotMatch(screen(), /2\. TTL 5m/);
  await key("c");
  await key(DOWN);
  await key(DOWN);
  await key(ENTER); // Type something.
  await key("ARC");
  await key(ENTER); // one question: submits
  await until(() => provider.requests.length === 2);
  assert.equal(sent(provider, 1), "Answers:\n- Cache: ARC");
  await until(() => screen().includes("Which cache eviction policy"));
  await key("\x1b");
  await until(() => provider.requests.length === 3);
  assert.match(sent(provider, 2), /^The user cancelled the questionnaire\. These questions were NOT answered/);
});

test("TUI: when nobody touches the dialog, the countdown wins the race and the autopilot answers", async (t) => {
  await setup(t, { autopilot: { mode: "auto", timeoutSeconds: 1 } });
  const provider = scripted([{ toolCalls: [call({ questions: [cache] })] }, { text: "ok" }]);
  const { cli, screen } = await tui(t, provider);
  cli.submit("x");
  await until(() =>
    screen().includes("autopilot answers in 1s — press any key to keep answering (no one has answered)"),
  );
  await until(() => provider.requests.length === 2, 3000);
  assert.match(sent(provider, 1), /^Nobody answered the dialog/);
  assert.match(sent(provider, 1), /- Cache: "TTL 5m" \[timeout, after 1s\]/);
  await until(() => !screen().includes("collapse ]"));
  assert.match(screen(), /No response — the autopilot answered 1 question\./);
});

test("the countdown starts when the ask is shown, and someone engaging it stops the countdown", async (t) => {
  await setup(t, { autopilot: { mode: "auto", timeoutSeconds: 1 } });
  let engage = false;
  // a remote-ish host: shows the ask late; when `engage`, someone is answering (slowly)
  const answerer = {
    on: {
      ask: async (e: AskEvent) => {
        // real time on purpose: the 1s countdown must start at show(), not at the ask, and stop on engage()
        await sleep(400);
        e.show();
        if (!engage) return void (await e.answered);
        e.engage();
        await sleep(1300);
        e.resolve("LRU");
      },
    },
  };
  const provider = scripted([
    { toolCalls: [call({ questions: [cache] })] },
    { text: "ok" },
    { toolCalls: [call({ questions: [cache] })] },
    { text: "ok" },
  ]);
  const agent = await createAgent({
    host: { kind: "rpc", interactive: true },
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider } } },
      { name: "answerer", plugin: answerer },
    ],
  });
  const started = Date.now();
  await agent.run("x");
  assert.ok(Date.now() - started >= 1350, "1s from being shown, not from being asked");
  assert.match(sent(provider, 1), /- Cache: "TTL 5m" \[timeout, after 1s\]/);
  engage = true;
  await agent.run("y");
  assert.equal(sent(provider, 3), 'Answers:\n- Cache: "LRU"');
});
