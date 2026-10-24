import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Agent, openSession } from "@phi/core";
import { createCli } from "./cli.ts";

test("status follows the session's model and provider, and a stale resolve doesn't overwrite a newer one", async () => {
  const session = await openSession(null, await mkdtemp(join(tmpdir(), "phi-")));
  const resolve = async ({ model = "m0", provider = "p0" }: { model?: string; provider?: string }) => {
    // resolving "slow" finishes after a later change to "fast"
    if (model === "slow") await sleep(50);
    return { name: provider, model, provider: { contextWindow: async () => 1000 } };
  };
  const agent = { plugins: [], resolve, run: async () => {} } as unknown as Agent;
  const cli = await createCli(session, [], async () => agent);
  const status = async () => {
    await sleep(10);
    return cli.ui.getState().status;
  };
  assert.deepEqual(await status(), { name: "p0", model: "m0", window: 1000 });
  await session.setModel("m1");
  assert.deepEqual(await status(), { name: "p0", model: "m1", window: 1000 });
  await session.setProvider("p1");
  assert.deepEqual(await status(), { name: "p1", model: "m1", window: 1000 });
  await session.setModel("slow");
  await session.setModel("fast");
  await sleep(80);
  assert.deepEqual(cli.ui.getState().status, { name: "p1", model: "fast", window: 1000 });
});
