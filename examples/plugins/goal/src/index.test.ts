import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { version } from "@hortus/cli";
import { App, createCli, terminal } from "@hortus/cli/testing";
import { render } from "ink";
import { createElement } from "react";
import { type CompletionRequest, createAgent, hortusDir, openSession, type Plugin } from "@hortus/core";
import { scripted, type Turn, tempHome } from "@hortus/core/testing";
import { type GoalRunEvent, goalOf, tokens } from "./index.tsx";

const dir = fileURLToPath(new URL("..", import.meta.url));
const until = async (f: () => boolean) => {
  for (let i = 0; i < 300 && !f(); i++) await sleep(10);
  assert.ok(f(), "timed out");
};
/** the goal_id the latest goal prompt in the request names */
const idIn = (req: CompletionRequest) =>
  req.messages
    .flatMap((m) => (m.role === "user" ? [...m.content.matchAll(/<goal_id>\n(.+)\n<\/goal_id>/g)] : []))
    .at(-1)?.[1] ?? "";
/** a reply that never comes: rejects once the request is aborted */
const hang = (req: CompletionRequest) =>
  new Promise<never>((_, reject) => {
    const fail = () => reject(new Error("aborted"));
    if (req.signal?.aborted) fail();
    req.signal?.addEventListener("abort", fail);
  });
const userTexts = (req?: CompletionRequest) =>
  req?.messages.flatMap((m) => (m.role === "user" ? [m.content] : [])) ?? [];

async function setup(turns: Turn[], listener: Plugin = {}) {
  const provider = scripted(turns);
  const agent = await createAgent({
    provided: { "@hortus/cli": version },
    extra: [{ name: "scripted", plugin: { ...listener, providers: { scripted: provider } } }],
  });
  const session = await openSession(null);
  await agent.setSession(session);
  const command = agent.commands().find((c) => c.name === "goal");
  const goal = (arg: string) => command?.run(arg);
  return { provider, agent, session, goal };
}

test("goal: /goal kicks off, continues at idle until goal_complete, and resuming the session keeps the result", async (t) => {
  t.after(await tempHome({ plugins: { goal: dir } }));
  const { provider, agent, session, goal } = await setup([
    { text: "Looked around." },
    { toolCalls: [{ id: "c1", name: "goal_complete", input: { goal_id: "stale", summary: "done" } }] },
    (req) => ({
      toolCalls: [{ id: "c2", name: "goal_complete", input: { goal_id: idIn(req), summary: "All tests pass." } }],
    }),
    {},
  ]);

  assert.equal(await goal("--tokens 10k ship the feature"), "Goal started");
  await until(() => goalOf(session.getState())?.status === "complete" && !agent.ctx.busy());
  await sleep(50); // a further (wrong) run would start by now
  // kickoff run, one continuation whose stale call was rejected and the model retried, then done: no more runs
  assert.equal(provider.requests.length, 3);
  const [kickoff, cont, retry] = provider.requests;
  assert.match(userTexts(kickoff)[0] ?? "", /Goal mode is active[\s\S]*ship the feature[\s\S]*Token budget: 10k/);
  // the hidden contract joined the first request, after the kickoff prompt
  assert.match(userTexts(kickoff)[1] ?? "", /^This Goal contract supersedes/);
  assert.match(userTexts(cont).at(-1) ?? "", /automatic continuation #1/);
  const rejected = retry?.messages.at(-1);
  assert.ok(rejected?.role === "tool" && rejected.results[0]?.isError);
  assert.match(rejected.results[0]?.output ?? "", /goal_id does not match/);

  const g = goalOf(session.getState());
  assert.equal(g?.summary, "All tests pass.");
  assert.equal(g?.iteration, 1);
  assert.equal(g?.automaticTurns, 1);
  assert.match(String(await goal("status")), /Status: complete/);

  const resumed = await openSession(session.leafId);
  await agent.setSession(resumed, "resume");
  assert.equal(goalOf(resumed.getState())?.status, "complete");
  // the next run is told goal mode is off
  await agent.run("thanks");
  assert.match(userTexts(provider.requests[3]).at(-1) ?? "", /^Goal mode is inactive/);
  await agent.close();
});

test("goal: repeated tool-free output pauses it; resume starts a fresh epoch; an aborted goal run pauses it", async (t) => {
  t.after(await tempHome({ plugins: { goal: dir } }));
  const { provider, agent, session, goal } = await setup([
    { text: "Thinking." },
    { text: "Still thinking." },
    { text: "Still thinking." },
    { text: "Still thinking." },
    { text: "Resumed." },
    (req, ctx) => {
      ctx?.abort("stop");
      return hang(req);
    },
  ]);
  await goal("make it faster");
  await until(() => goalOf(session.getState())?.status === "paused" && !agent.ctx.busy());
  assert.equal(provider.requests.length, 4);
  const g = goalOf(session.getState());
  assert.equal(g?.safetyPause, "no_progress");
  assert.equal(g?.toolFreeRepeats, 3);

  // the session's goal pauses a resumed session too; resuming it starts a new epoch
  assert.match(String(await goal("resume")), /Goal resumed/);
  await until(() => provider.requests.length === 6);
  assert.match(userTexts(provider.requests[4]).at(-1) ?? "", /explicitly resumed the paused \/goal/);
  // the continuation after the resumed run is aborted from outside: Pi pauses an interrupted goal
  await until(() => goalOf(session.getState())?.status === "paused" && !agent.ctx.busy());
  assert.match(goalOf(session.getState())?.reason ?? "", /interrupted/);
  await agent.close();
});

test("goal: other plugins start, observe and cancel a managed goal over the bus", async (t) => {
  t.after(await tempHome({ plugins: { goal: dir } }));
  await writeFile(join(hortusDir(), "goal.json"), JSON.stringify({ rpc: { enabled: true } }));
  const events: GoalRunEvent[] = [];
  const { provider, agent, session } = await setup(
    [{ toolCalls: [{ id: "w", name: "goal_wait", input: { goal_id: "x", reason: "CI" } }] }, hang],
    { on: { "goal:event": (e) => void events.push(e) } },
  );
  await agent.ctx.emit("goal:start", { runId: "r1", objective: "watch CI" });
  await agent.ctx.emit("goal:start", { runId: "r2", objective: "another" });
  await until(() => provider.requests.length === 2);
  await agent.ctx.emit("goal:cancel", { runId: "nope" });
  await agent.ctx.emit("goal:cancel", { runId: "r1", reason: "enough" });
  await until(() => !agent.ctx.busy());

  const id = goalOf(session.getState())?.id;
  assert.deepEqual(events, [
    { type: "state", runId: "r1", goalId: id, status: "active" },
    {
      type: "error",
      runId: "r2",
      operation: "start",
      error: { code: "GOAL_ALREADY_EXISTS", message: "A Goal already exists." },
    },
    {
      type: "error",
      runId: "nope",
      operation: "cancel",
      error: { code: "RUN_NOT_FOUND", message: "No active managed run matches runId." },
    },
    { type: "state", runId: "r1", goalId: id, status: "paused", reason: "enough" },
  ]);
  assert.equal(provider.requests.length, 2);
  await agent.close();
});

test("goal: goal_wait keeps it quiet until a user message; a spent token budget stops it", async (t) => {
  t.after(await tempHome({ plugins: { goal: dir } }));
  const { provider, agent, session, goal } = await setup([
    (req) => ({
      toolCalls: [{ id: "w", name: "goal_wait", input: { goal_id: idIn(req), reason: "CI", resume_after_ms: 5 } }],
    }),
    { text: "Fixed.", usage: { input: 900, output: 200, cacheRead: 0 } },
  ]);
  await goal("--tokens 1k fix CI");
  await until(() => !!goalOf(session.getState())?.waiting && !agent.ctx.busy());
  await sleep(50); // a (wrong) continuation would start by now
  assert.equal(provider.requests.length, 1);
  const waited = goalOf(session.getState());
  assert.equal(waited?.status, "active");
  assert.ok((waited?.waiting?.resumeAt ?? 0) >= Date.now() + 9_000, "clamped to 10s");

  await agent.run("CI is green now");
  await until(() => goalOf(session.getState())?.status === "budget_limited" && !agent.ctx.busy());
  assert.equal(provider.requests.length, 2);
  const g = goalOf(session.getState());
  assert.equal(g?.status, "budget_limited");
  assert.equal(g?.tokensUsed, 1100);
  await assert.rejects(Promise.resolve(goal("resume")), /token budget is spent/);
  await agent.close();
});

test("goal: a goal prompt sent during a user run waits for it and passes input", async (t) => {
  t.after(await tempHome({ plugins: { goal: dir } }));
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const inputs: [string | undefined, string][] = [];
  const { provider, agent, session, goal } = await setup(
    [
      async () => {
        await held;
        return { text: "User run done." };
      },
      (req) => ({ toolCalls: [{ id: "c1", name: "goal_complete", input: { goal_id: idIn(req), summary: "ok" } }] }),
      {},
    ],
    { on: { input: (p) => void inputs.push([p.meta?.type, p.source]) } },
  );
  const run = agent.run("hello");
  await until(() => provider.requests.length === 1);
  await goal("ship it");
  await sleep(50); // a (wrong) steered kickoff would request by now
  // the kickoff waits for the user run instead of steering it
  assert.equal(provider.requests.length, 1);
  release();
  await run;
  await until(() => goalOf(session.getState())?.status === "complete" && !agent.ctx.busy());
  assert.deepEqual(inputs, [
    [undefined, "user"],
    ["prompt", "goal"],
  ]);
  assert.match(userTexts(provider.requests[1]).at(-2) ?? "", /Goal mode is active[\s\S]*ship it/);
  await agent.close();
});

test("goal: replacing an unfinished goal asks first; no answer keeps it", async (t) => {
  t.after(await tempHome({ plugins: { goal: dir } }));
  let answer: string | undefined;
  const asked: string[] = [];
  const labels: (string[] | undefined)[] = [];
  const { agent, session, goal } = await setup([(req) => hang(req), (req) => hang(req)], {
    on: {
      ask: (p) => {
        asked.push(p.question);
        labels.push(p.options?.map((o) => o.label));
        if (answer) p.resolve(answer);
      },
    },
  });
  await goal("first goal");
  await assert.rejects(async () => goal("second goal"), /Kept the unfinished goal/);
  assert.match(asked[0] ?? "", /^Replace the unfinished goal \(active\): first goal/);
  assert.deepEqual(labels[0], ["Keep", "Replace"]);
  assert.equal(goalOf(session.getState())?.text, "first goal");
  answer = "Replace";
  assert.equal(await goal("second goal"), "Goal started");
  assert.equal(goalOf(session.getState())?.text, "second goal");
  await agent.close({ timeout: 50 });
});

test("goal: the TUI renders its prompts through cli.entries goal:prompt and goal:contract", async (t) => {
  t.after(await tempHome({ plugins: { goal: dir } }));
  const provider = scripted([
    (req) => ({
      toolCalls: [{ id: "c1", name: "goal_complete", input: { goal_id: idIn(req), summary: "done" } }],
    }),
    {},
  ]);
  const cli = await createCli(await openSession(null), (o) =>
    createAgent({
      ...o,
      provided: { "@hortus/cli": version },
      extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }, ...(o.extra ?? [])],
    }),
  );
  const term = terminal(80, 30);
  const app = render(createElement(App, { cli }), {
    stdin: term.stdin as never,
    stdout: term.stdout as never,
    debug: true,
    patchConsole: false,
  });
  t.after(() => app.unmount());
  assert.equal(cli.submit("/goal ship it"), true);
  await until(() => goalOf(cli.session.getState())?.status === "complete" && !cli.ui.getState().busy);
  await until(() => /◆ goal contract/.test(term.frame().join("\n")));
  const screen = term.frame().join("\n");
  assert.match(screen, /◆ goal Goal mode is active/);
  assert.match(screen, /◆ goal contract This Goal contract supersedes/);
  await cli.close();
});

test("goal: a compaction that summarizes the contract away sends it again", async (t) => {
  t.after(await tempHome({ plugins: { goal: dir } }));
  const { provider, agent, session, goal } = await setup([
    (req) => ({
      toolCalls: [{ id: "w", name: "goal_wait", input: { goal_id: idIn(req), reason: "CI", resume_after_ms: 5 } }],
    }),
    { text: "SUMMARY" },
  ]);
  await goal("fix CI");
  await until(() => !!goalOf(session.getState())?.waiting && !agent.ctx.busy());
  const compact = agent.commands().find((c) => c.name === "compact");
  assert.equal(await compact?.run(""), undefined);
  assert.equal(provider.requests.length, 2);
  const kinds = session.getState().messages.map((m) => (m.role === "user" ? (m.meta?.type ?? "user") : m.role));
  assert.deepEqual(kinds, ["summary", "assistant", "tool", "contract"]);
  await agent.close();
});

test("goal: its token count holds across a compaction, tool results' own usage (subruns') included", async (t) => {
  t.after(await tempHome({ plugins: { goal: dir } }));
  const { agent, session } = await setup([{ text: "SUMMARY" }]);
  const u = (input: number) => ({ input, output: 0, cacheRead: 0 });
  await session.append([
    { role: "user", content: "spawn" },
    { role: "assistant", text: "", toolCalls: [{ id: "s", name: "spawn", input: {} }], usage: u(10) },
    { role: "tool", results: [{ id: "s", output: "child done", usage: u(500) }] },
    { role: "assistant", text: "ok", toolCalls: [], usage: u(20) },
    { role: "user", content: "next" },
  ]);
  assert.equal(tokens(session), 530);
  assert.equal(
    await agent
      .commands()
      .find((c) => c.name === "compact")
      ?.run(""),
    undefined,
  );
  const [first] = session.getState().messages;
  assert.equal(first?.role === "user" && first.meta?.type, "summary");
  assert.equal(tokens(session), 530);
  await agent.close();
});
