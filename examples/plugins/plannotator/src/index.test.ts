import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "@hortus/cli";
import { renderApp, startCli } from "@hortus/cli/testing";
import {
  type CompletionRequest,
  createAgent,
  type Events,
  hortusDir,
  type LoadOptions,
  openSession,
  type UserMessage,
} from "@hortus/core";
import { scripted, tempDir, tempHome, type Turn, until } from "@hortus/core/testing";

const dir = fileURLToPath(new URL("..", import.meta.url));

/** A home with the plugin, its config opening no browser (plus `config`), and a project dir as the session's cwd. */
async function setup(t: Parameters<typeof tempDir>[0], config: object = {}) {
  t.after(await tempHome({ plugins: { plannotator: dir } }));
  await writeFile(join(hortusDir(), "plannotator.json"), JSON.stringify({ browser: "none", ...config }));
  const cwd = await tempDir(t);
  const session = await openSession(null);
  await session.setCwd(cwd);
  return { cwd, session };
}

/** Records the bus events and idles, for waiting on runs a decision starts. */
function observer() {
  const opened: Events["plannotator:session-opened"][] = [];
  const closed: Events["plannotator:session-closed"][] = [];
  const statuses: (string | undefined)[] = [];
  const colors: (string | undefined)[] = [];
  let idles = 0;
  const plugin = {
    on: {
      "plannotator:session-opened": (p: Events["plannotator:session-opened"]) => void opened.push({ ...p }),
      "plannotator:session-closed": (p: Events["plannotator:session-closed"]) => void closed.push({ ...p }),
      status: (p: Events["status"]) => {
        if (p.key !== "plannotator") return;
        statuses.push(p.text);
        colors.push(p.color);
      },
      idle: () => void idles++,
    },
  };
  return { plugin, opened, closed, statuses, colors, idles: () => idles };
}

const api = async (url: string, path: string, body?: object) => {
  const u = new URL(url);
  u.pathname = path;
  const res = await fetch(u, body ? { method: "POST", body: JSON.stringify(body) } : {});
  return (await res.json()) as { content: string; answer?: string };
};

async function agentWith(turns: Turn[], opts: LoadOptions, obs = observer()) {
  const provider = scripted(turns);
  const agent = await createAgent({
    provided: { "@hortus/cli": version },
    ...opts,
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider } } },
      { name: "observer", plugin: obs.plugin },
      ...(opts.extra ?? []),
    ],
  });
  return { agent, provider, obs };
}

const users = (r: CompletionRequest | undefined) =>
  (r?.messages ?? []).filter((m): m is UserMessage => m.role === "user");
const hidden = (r: CompletionRequest | undefined, type: string) =>
  users(r).filter((m) => m.meta?.plugin === "plannotator" && m.meta.type === type && m.meta.display === false);
/** the last message a person (or a plugin's prompt) sent, not a hidden one */
const lastUser = (r: CompletionRequest | undefined) =>
  users(r)
    .filter((m) => !m.meta)
    .at(-1)?.content ?? "";
const tools = (r: CompletionRequest | undefined) => r?.tools.map((t) => t.name) ?? [];

test("plannotator: plan mode, a denied then approved browser review, checklist execution, plan mode off", async (t) => {
  const { cwd, session } = await setup(t, { phases: { executing: { thinking: "high" } } });
  const plan1 = "# Flag\n\n- [ ] Add the flag\n";
  const plan2 = "# Flag\n\n- [ ] Add the flag\n- [ ] Test it\n";
  const write = (path: string, content: string) => ({ name: "write", input: { path, content } });
  const { agent, provider, obs } = await agentWith(
    [
      // planning: a code write is blocked, the plan file is written, then submitted (which ends the run)
      {
        toolCalls: [
          { id: "w1", ...write("src.ts", "x") },
          { id: "w2", ...write("PLAN.md", plan1) },
        ],
      },
      { toolCalls: [{ id: "s1", name: "plannotator_submit_plan", input: { filePath: "PLAN.md" } }] },
      // denied: revise and resubmit
      {
        toolCalls: [
          { id: "w3", ...write("PLAN.md", plan2) },
          { id: "s2", name: "plannotator_submit_plan", input: { filePath: "PLAN.md" } },
        ],
      },
      // approved: step 1 with the tool, step 2 with a marker
      { toolCalls: [{ id: "d1", name: "plannotator_mark_done", input: { step: 1 } }] },
      { text: "Tested. [DONE:2]" },
      // after plan mode
      { text: "ok" },
    ],
    { host: { kind: "test", interactive: true } },
  );
  t.after(() => agent.close());
  await agent.setSession(session);
  const command = (name: string, arg = "") =>
    agent
      .commands()
      .find((c) => c.name === name)
      ?.run(arg);

  assert.equal(await command("plannotator-plan-mode"), "Plannotator: planning mode enabled.");
  assert.deepEqual(obs.statuses.at(-1), "⏸ plan");
  assert.equal(obs.colors.at(-1), "yellow");
  await agent.run("add a flag");
  const [planning, planned] = provider.requests;
  assert.equal(provider.requests.length, 2, "submitting ends the run");
  assert.match(hidden(planning, "framing")?.[0]?.content ?? "", /PLANNING PHASE/);
  assert.ok(tools(planning).includes("plannotator_submit_plan"));
  assert.ok(!tools(planning).includes("plannotator_mark_done") && !tools(planning).includes("plannotator"));
  const results = planned?.messages.at(-1);
  assert.ok(results?.role === "tool");
  assert.match(results.results[0]?.output ?? "", /Blocked by plannotator: .*limited to markdown/);
  assert.equal(results.results[0]?.isError, true);
  assert.equal(await readFile(join(cwd, "PLAN.md"), "utf8"), plan1);

  // the review page: the plan, then a denial with feedback, which comes back as a message and starts a run
  await until(() => obs.opened.length === 1);
  const first = obs.opened[0];
  assert.equal(first?.action, "plan-review");
  assert.equal(first?.sessionId, session.id);
  assert.equal((await api(first?.url ?? "", "/api/state")).content, plan1);
  assert.equal((await fetch(new URL("/api/state", first?.url))).status, 403, "the token is required");
  await api(first?.url ?? "", "/api/decision", { feedback: "Add a test step" });
  await until(() => obs.opened.length === 2 && obs.idles() === 2);
  const denied = provider.requests[2];
  assert.match(lastUser(denied), /^YOUR PLAN WAS NOT APPROVED[\s\S]*PLAN\.md[\s\S]*Add a test step$/);
  assert.equal(hidden(denied, "framing")?.length, 1, "framing is delivered once per phase");
  assert.deepEqual(obs.closed[0] && [obs.closed[0].id, obs.closed[0].outcome], [first?.id, "submitted"]);

  // approved: the executing phase, its framing and checklist, model settings from the config
  const second = obs.opened[1];
  assert.equal((await api(second?.url ?? "", "/api/state")).content, plan2);
  await api(second?.url ?? "", "/api/decision", { approved: true });
  await until(() => obs.idles() === 3);
  const executing = provider.requests[3];
  assert.match(lastUser(executing), /^Plan approved\. [\s\S]*## Approved plan[\s\S]*- \[ \] Test it/);
  assert.match(
    hidden(executing, "framing").at(-1)?.content ?? "",
    /EXECUTING PLAN[\s\S]*1\. Add the flag\n- \[ \] 2\. Test it/,
  );
  assert.equal(executing?.effort, "high");
  assert.ok(
    tools(executing).includes("plannotator_mark_done") && !tools(executing).includes("plannotator_submit_plan"),
  );
  assert.ok(obs.statuses.includes("📋 1/2"));

  // both steps done: the file is checked off, "Plan Complete!" shown, plan mode off
  assert.equal(await readFile(join(cwd, "PLAN.md"), "utf8"), "# Flag\n\n- [x] Add the flag\n- [x] Test it\n");
  const complete = session.getState().messages.at(-1);
  assert.ok(complete?.role === "user" && complete.meta?.type === "complete" && complete.meta.display === true);
  assert.match(complete.content, /Plan Complete![\s\S]*~~Test it~~/);
  assert.equal(obs.statuses.at(-1), undefined);
  await agent.run("thanks");
  const after = provider.requests[5];
  assert.match(hidden(after, "framing").at(-1)?.content ?? "", /PLAN MODE OFF/);
  assert.ok(!tools(after).some((n) => n.startsWith("plannotator")));
  // the phase is a session entry: replaying the session gives idle, with nothing owed
  const resumed = await openSession(session.leafId);
  await agent.setSession(resumed, "resume");
  // (as JSON: the live state keeps the `undefined` fields the entry was appended with, the file doesn't)
  assert.deepEqual(
    resumed.getState().data.plannotator,
    JSON.parse(JSON.stringify(session.getState().data.plannotator)),
  );
  assert.equal((session.getState().data.plannotator as { phase: string }).phase, "idle");
});

test("plannotator: headless plans auto-approve and continue; the bus toggles plan mode and hands plans off", async (t) => {
  const { cwd, session } = await setup(t);
  await writeFile(join(cwd, "PLAN.md"), "- [ ] One\n");
  const { agent, provider, obs } = await agentWith(
    [
      { toolCalls: [{ id: "s", name: "plannotator_submit_plan", input: { filePath: "PLAN.md" } }] },
      { text: "Doing it [DONE:1]" },
    ],
    {},
  );
  t.after(() => agent.close());
  await agent.setSession(session);
  const respond = (action: Events["plannotator:request"]["action"], payload?: unknown) =>
    new Promise<unknown>(
      (r) => void agent.ctx.emit("plannotator:request", { requestId: "x", action, payload, respond: r }),
    );
  assert.deepEqual(await respond("plan-mode", { mode: "enter" }), { status: "handled", result: { phase: "planning" } });
  await agent.run("plan");
  const auto = provider.requests[0];
  await until(() => obs.idles() === 1);
  assert.equal(provider.requests.length, 2);
  assert.match(hidden(auto, "framing")?.[0]?.content ?? "", /PLANNING PHASE/);
  assert.equal(lastUser(provider.requests[1]), "Continue with the approved plan.");
  assert.match(hidden(provider.requests[1], "framing").at(-1)?.content ?? "", /EXECUTING PLAN/);
  assert.equal(await readFile(join(cwd, "PLAN.md"), "utf8"), "- [x] One\n");
  assert.deepEqual(await respond("plan-mode", { mode: "status" }), { status: "handled", result: { phase: "idle" } });
  assert.deepEqual(await respond("nope" as never), { status: "unhandled" });
});

test("plannotator: external execution hands the approved plan to the bus", async (t) => {
  const { cwd, session } = await setup(t, { executionMode: "external" });
  await writeFile(join(cwd, "PLAN.md"), "- [ ] One\n");
  const approved: Events["plannotator:plan-approved"][] = [];
  // a companion plugin listening on the bus
  const companion = {
    on: { "plannotator:plan-approved": (p: Events["plannotator:plan-approved"]) => void approved.push(p) },
  };
  const { agent } = await agentWith(
    [{ toolCalls: [{ id: "s", name: "plannotator_submit_plan", input: { filePath: "PLAN.md" } }] }],
    { extra: [{ name: "companion", plugin: companion }] },
  );
  t.after(() => agent.close());
  await agent.setSession(session);
  await agent
    .commands()
    .find((c) => c.name === "plannotator-plan-mode")
    ?.run("");
  await agent.run("plan");
  assert.deepEqual(approved, [{ cwd, planFilePath: "PLAN.md", planContent: "- [ ] One\n" }]);
  assert.equal((session.getState().data.plannotator as { phase: string }).phase, "idle");
});

test("plannotator: annotating the last message, with Ask this session, sends the feedback back", async (t) => {
  const { session } = await setup(t);
  const { agent, provider, obs } = await agentWith(
    [{ text: "Here is my answer." }, { text: "It means X." }, { text: "Fixed." }],
    { host: { kind: "test", interactive: true } },
  );
  t.after(() => agent.close());
  await agent.setSession(session);
  await agent.run("question");
  const opened = await agent
    .commands()
    .find((c) => c.name === "plannotator-last")
    ?.run("");
  const url = obs.opened[0]?.url ?? "";
  assert.equal(opened, `Last-message annotation opened: ${url}`);
  assert.equal((await api(url, "/api/state")).content, "Here is my answer.");
  assert.deepEqual(await api(url, "/api/ask", { question: "What does it mean?" }), { answer: "It means X." });
  await api(url, "/api/decision", { feedback: "Too short" });
  await until(() => provider.requests.length === 3 && obs.idles() === 3);
  assert.match(
    lastUser(provider.requests[2]),
    /^Plannotator: last message \(pn-[0-9a-f]{6}\) — Feedback\.\n\n# Message Annotations\n\nToo short/,
  );
});

test("plannotator: /plannotator-review opens the git diff; the agent tool lists and closes reviews", async (t) => {
  const { cwd, session } = await setup(t, { agentTool: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  git("init", "-q");
  await writeFile(join(cwd, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "init");
  await writeFile(join(cwd, "a.txt"), "two\n");
  const { agent, provider, obs } = await agentWith(
    [
      { toolCalls: [{ id: "l", name: "plannotator", input: { action: "list" } }] },
      { toolCalls: [{ id: "c", name: "plannotator", input: { action: "close", session: "all" } }] },
      { text: "closed" },
      { text: "Will fix." },
    ],
    { host: { kind: "test", interactive: true } },
  );
  t.after(() => agent.close());
  await agent.setSession(session);
  const text = await agent
    .commands()
    .find((c) => c.name === "plannotator-review")
    ?.run("");
  assert.match(text ?? "", /^Code review opened: http:\/\/127\.0\.0\.1:/);
  const review = obs.opened[0];
  assert.match((await api(review?.url ?? "", "/api/state")).content, /-one\n\+two/);
  await agent.run("what's open?");
  assert.ok(tools(provider.requests[0]).includes("plannotator"));
  const listed = provider.requests[1]?.messages.at(-1);
  assert.ok(listed?.role === "tool" && listed.results[0]?.output.startsWith(`${review?.id}  changes in .`));
  await until(() => obs.closed.length === 1);
  assert.deepEqual([obs.closed[0]?.outcome, obs.closed[0]?.closedBy], ["closed", "agent"]);
  // a second review, answered with changes requested
  await agent
    .commands()
    .find((c) => c.name === "plannotator-review")
    ?.run("");
  await api(obs.opened[1]?.url ?? "", "/api/decision", { feedback: "a.txt: why two?" });
  await until(() => provider.requests.length === 4);
  assert.match(
    lastUser(provider.requests[3]),
    /— Changes requested\.\nTarget: .*\n\na\.txt: why two\?\n\nTreat the findings/,
  );
});

test("plannotator: the TUI shows the executing checklist above the input", async (t) => {
  const { session } = await setup(t);
  await session.appendEntry("plannotator:state", {
    phase: "executing",
    planPath: "PLAN.md",
    approvedPlan: "x",
    items: [
      { step: 1, text: "Add the flag", completed: true },
      { step: 2, text: "Test it", completed: false },
    ],
  });
  const cli = await startCli({
    session,
    extra: [{ name: "scripted", plugin: { providers: { scripted: scripted([]) } } }],
  });
  t.after(() => cli.close());
  const ui = renderApp(cli);
  t.after(() => ui.app.unmount());
  await until(() => ui.screen().includes("☐ Test it"));
  assert.match(ui.screen(), /☑ Add the flag/);
  assert.match(ui.screen(), /📋 1\/2/);
});
