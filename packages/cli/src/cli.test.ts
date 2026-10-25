import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Agent, openSession, type Plugin } from "@hortus/core";
import { createCli, runEffort, type UiState } from "./cli.ts";

test("status follows the session's model and provider, and a stale resolve doesn't overwrite a newer one", async () => {
  const session = await openSession(null, await mkdtemp(join(tmpdir(), "hortus-")));
  const resolve = async ({ model = "m0", provider = "p0" }: { model?: string; provider?: string }) => {
    // resolving "slow" finishes after a later change to "fast"
    if (model === "slow") await sleep(50);
    // m1 reports its efforts, the others don't
    const efforts = async (m: string) => (m === "m1" ? ["off", "high"] : undefined);
    return { name: provider, model, provider: { contextWindow: async () => 1000, efforts } };
  };
  const agent = { plugins: [], resolve, run: async () => {} } as unknown as Agent;
  const cli = await createCli(session, async () => agent);
  const status = async () => {
    await sleep(10);
    return cli.ui.getState().status;
  };
  assert.deepEqual(await status(), { name: "p0", model: "m0", window: 1000, efforts: undefined });
  await session.setModel("m1");
  assert.deepEqual(await status(), { name: "p0", model: "m1", window: 1000, efforts: ["off", "high"] });
  await session.setProvider("p1");
  assert.deepEqual(await status(), { name: "p1", model: "m1", window: 1000, efforts: ["off", "high"] });
  await session.setModel("slow");
  await session.setModel("fast");
  await sleep(80);
  assert.deepEqual(cli.ui.getState().status, { name: "p1", model: "fast", window: 1000, efforts: undefined });
});

test("streamed deltas reach the store once a frame, and none are lost when the reply ends", async () => {
  const session = await openSession(null, await mkdtemp(join(tmpdir(), "hortus-")));
  let observer: Plugin | undefined;
  const run = async () => {
    for (const d of ["a", "b", "c"]) await observer?.on?.text?.(d);
    await sleep(60);
    await observer?.on?.text?.("d");
    // ends the reply before the "d" frame fires
    await observer?.on?.message?.({ role: "assistant", text: "abcd", toolCalls: [] });
  };
  const resolve = async () => ({ name: "p", model: "m", provider: {} });
  const cli = await createCli(session, async (o) => {
    observer = o;
    return { plugins: [], resolve, run } as unknown as Agent;
  });
  const lives: string[] = [];
  cli.ui.subscribe((s, prev) => {
    if (s.live !== prev.live) lives.push(s.live.text);
  });
  assert.equal(cli.submit("hi"), true);
  await sleep(100);
  assert.deepEqual(lives, ["abc", ""]);
  assert.equal(cli.ui.getState().entries.at(-1)?.text, "abcd");
});

test("a run that fails keeps its completed messages in the session", async () => {
  const session = await openSession(null, await mkdtemp(join(tmpdir(), "hortus-")));
  let observer: Plugin | undefined;
  const run = async () => {
    await observer?.on?.message?.({ role: "assistant", text: "", toolCalls: [{ id: "1", name: "bash", input: {} }] });
    await observer?.on?.message?.({ role: "tool", results: [{ id: "1", output: "ok" }] });
    throw new Error("429");
  };
  const resolve = async () => ({ name: "p", model: "m", provider: {} });
  const cli = await createCli(session, async (o) => {
    observer = o;
    return { plugins: [], resolve, run } as unknown as Agent;
  });
  cli.submit("hi");
  await sleep(20);
  assert.deepEqual(
    session.getState().messages.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
  assert.deepEqual(cli.ui.getState().turn, []);
  assert.equal(cli.ui.getState().entries.at(-1)?.text, "429");
});

test("runs use the set effort only if the model takes it, or while its efforts are unknown", () => {
  const state = (effort: UiState["effort"], efforts?: UiState["effort"][]) =>
    ({ effort, status: { name: "p", model: "m", efforts } }) as UiState;
  assert.equal(runEffort(state("max")), "max");
  assert.equal(runEffort(state("max", ["off", "high"])), undefined);
  assert.equal(runEffort(state("high", ["off", "high"])), "high");
  assert.equal(runEffort(state(undefined, ["off", "high"])), undefined);
});
