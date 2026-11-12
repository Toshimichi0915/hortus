import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "@hortus/cli";
import { createAgent, openSession, tool } from "@hortus/core";
import { scripted, tempHome } from "@hortus/core/testing";
import { z } from "zod";

test("plan-mode: with the mode on, write/edit/bash are gone (from codemode too) and runs use the plan model and effort", async (t) => {
  t.after(
    await tempHome({
      secrets: { scripted: { type: "scripted", apiKey: "k" }, planner: { type: "scripted", apiKey: "k" } },
      plugins: { "plan-mode": fileURLToPath(new URL("..", import.meta.url)) },
    }),
  );
  // a script in plan mode reaches read, not write
  const code = "return [typeof tools.read, typeof tools.write].join();";
  const provider = scripted([{ toolCalls: [{ id: "1", name: "codemode", input: { code } }] }, {}, {}, {}]);
  // codemode-only, like an MCP tool, so codemode is declared
  const lookup = tool({
    name: "lookup",
    description: "",
    inputSchema: z.object({}),
    exposure: "codemode",
    execute: async () => "",
  });
  const agent = await createAgent({
    provided: { "@hortus/cli": version },
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [lookup] } }],
  });
  const plan = agent.commands().find((c) => c.name === "plan");
  const session = await openSession(null);
  await agent.setSession(session);
  const user = "add a flag";

  assert.equal(await plan?.run("planner/big high"), "Plan mode on with planner/big (high)");
  await agent.run(user);
  // kept in the session: a resumed one is still in plan mode
  const resumed = await openSession(session.leafId);
  await agent.setSession(resumed, "resume");
  await agent.run(user);
  assert.equal(provider.requests[2]?.model, "big");
  assert.equal(await plan?.run(""), "Plan mode off");
  await agent.run(user);

  const [planned, answered, , normal] = provider.requests;
  const names = (r = planned) => r?.tools.map((t) => t.name) ?? [];
  assert.deepEqual(
    names().filter((n) => ["write", "edit", "bash"].includes(n)),
    [],
  );
  assert.ok(names().includes("codemode"));
  const results = answered?.messages.at(-1);
  assert.equal(results?.role === "tool" && results.results[0]?.output, "function,undefined");
  assert.ok(names().includes("read"));
  assert.deepEqual([planned?.model, planned?.effort], ["big", "high"]);
  assert.match(planned?.system ?? "", /Plan mode is on/);
  // off again: the full tool set and the configured model
  assert.ok(["write", "edit", "bash", "codemode"].every((n) => names(normal).includes(n)));
  assert.equal(normal?.model, "scripted");
  assert.doesNotMatch(normal?.system ?? "", /Plan mode/);
  await assert.rejects(async () => plan?.run("nope"), /Usage/);
});
