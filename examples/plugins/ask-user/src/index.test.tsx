import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAgent, openSession } from "@hortus/core";
import { scripted, tempHome, until } from "@hortus/core/testing";
import { createCli, renderApp } from "@hortus/cli/testing";

const dir = fileURLToPath(new URL("..", import.meta.url));
const call = {
  id: "1",
  name: "ask_user",
  input: { question: "Which color?", options: [{ label: "red" }, { label: "blue" }] },
};

/** The output of the tool result the model got in its `i`th request. */
const sent = (provider: ReturnType<typeof scripted>, i: number) => {
  const m = provider.requests[i]?.messages.at(-1);
  return m?.role === "tool" ? m.results[0]?.output : undefined;
};

test("ask_user: the TUI's prompt slot shows the question, and the picked option reaches the model", async (t) => {
  t.after(await tempHome({ plugins: { "ask-user": dir } }));
  const provider = scripted([{ toolCalls: [call] }, { text: "blue it is" }]);
  const cli = await createCli(await openSession(null), (o) =>
    createAgent({
      ...o,
      extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }, ...(o.extra ?? [])],
    }),
  );
  const ui = renderApp(cli);
  t.after(() => ui.app.unmount());
  cli.submit("pick a color");
  await until(() => /Which color\?[\s\S]*red[\s\S]*blue/.test(ui.screen()), 5000);
  ui.keys("\x1b[B");
  await sleep(20); // separate key chunks, not a wait for state
  ui.keys("\r");
  await until(() => provider.requests.length > 1 && !cli.ui.getState().busy, 5000);
  assert.equal(sent(provider, 1), "The user answered: blue");
  assert.doesNotMatch(ui.screen(), /Which color\?/);
});

test("ask_user without anyone to answer tells the model so", async (t) => {
  t.after(await tempHome({ plugins: { "ask-user": dir } }));
  const provider = scripted([{ toolCalls: [call] }, { text: "ok" }]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  await agent.run("pick");
  assert.match(sent(provider, 1) ?? "", /^The user didn't answer/);
});
