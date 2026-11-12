import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderApp, startCli } from "@hortus/cli/testing";
import type { CompletionRequest } from "@hortus/core";
import { scripted, tempHome, until } from "@hortus/core/testing";

test("the TUI shows a foreground child in the fleet and in its subagent block while it runs, then its answer", async (t) => {
  t.after(await tempHome({ plugins: { "pi-subagents": fileURLToPath(new URL("..", import.meta.url)) } }));
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const provider = scripted(
    [...Array(6)].map(() => async (req: CompletionRequest) => {
      if (req.system.includes("delegated agent")) {
        await gate;
        return { text: "the answer is 42" };
      }
      if (req.messages.at(-1)?.role === "tool") return { text: "relayed" };
      return {
        toolCalls: [{ id: "s", name: "subagent", input: { agent: "delegate", task: "find the answer", async: false } }],
      };
    }),
  );
  const cli = await startCli({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  const ui = renderApp(cli, { columns: 100, rows: 30 });
  t.after(() => ui.app.unmount());
  cli.submit("go");
  await until(() => /◆ delegate \w+ fg/.test(ui.screen()), 3000);
  assert.match(ui.screen(), /subagent delegate find the answer\n\s*◆ delegate \w+ running · 0 turns · 0 tools/);
  release();
  await until(() => ui.screen().includes("relayed"), 3000);
  assert.match(ui.screen(), /✓ delegate \w+ completed · 1 turns · 0 tools · \d+s\n\s*the answer is 42/);
  assert.doesNotMatch(ui.screen(), /◆ delegate \w+ fg/);
  await cli.close();
});
