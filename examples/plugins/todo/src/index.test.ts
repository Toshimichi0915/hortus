import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgent, openSession } from "@hortus/core";
import { createCli, renderApp } from "@hortus/cli/testing";
import { scripted, tempHome, until } from "@hortus/core/testing";
import { items } from "./index.tsx";

test("todo saves the list as entries; resuming rebuilds it, and branching from earlier gets that branch's list", async (t) => {
  t.after(await tempHome({ plugins: { todo: fileURLToPath(new URL("..", import.meta.url)) } }));
  const call = (id: string, list: { text: string; done: boolean }[]) => ({
    toolCalls: [{ id, name: "todo", input: { items: list } }],
  });
  const provider = scripted([
    call("1", [{ text: "write it", done: false }]),
    {},
    call("2", [{ text: "write it", done: true }]),
    {},
  ]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  const session = await openSession(null);
  await agent.setSession(session);
  await agent.run("plan");
  const firstLeaf = session.leafId;
  assert.deepEqual(items(session.getState()), [{ text: "write it", done: false }]);
  await agent.run("do it");
  assert.deepEqual(items(session.getState()), [{ text: "write it", done: true }]);
  assert.match(provider.requests[0]?.system ?? "", /todo tool/);

  const resumed = await openSession(session.leafId);
  await agent.setSession(resumed, "resume");
  assert.deepEqual(items(resumed.getState()), [{ text: "write it", done: true }]);
  const branched = await openSession(firstLeaf);
  await agent.setSession(branched, "resume");
  assert.deepEqual(items(branched.getState()), [{ text: "write it", done: false }]);
});

test("todo's aboveInput panel shows the shown session's list from useSession, and follows each todo call", async (t) => {
  t.after(await tempHome({ plugins: { todo: fileURLToPath(new URL("..", import.meta.url)) } }));
  const provider = scripted([
    { toolCalls: [{ id: "1", name: "todo", input: { items: [{ text: "write tests", done: false }] } }] },
    { text: "planned" },
    {
      toolCalls: [
        {
          id: "2",
          name: "todo",
          input: {
            items: [
              { text: "write tests", done: true },
              { text: "ship it", done: false },
            ],
          },
        },
      ],
    },
    { text: "progress" },
  ]);
  const cli = await createCli(await openSession(null), (o) =>
    createAgent({
      ...o,
      extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }, ...(o.extra ?? [])],
    }),
  );
  const ui = renderApp(cli);
  t.after(() => ui.app.unmount());
  await until(() => ui.screen().includes("╭"));
  assert.doesNotMatch(ui.screen(), /○|✔/);
  cli.submit("plan");
  await until(() => /○ write tests\n(.*\n)*.*╭/.test(ui.screen()) && !cli.ui.getState().busy, 5000);
  cli.submit("go on");
  await until(() => /✔ write tests\n.*○ ship it/.test(ui.screen()), 5000);
});
