import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderApp, startCli } from "@hortus/cli/testing";
import { type CompletionRequest, createAgent, type Message, openSession } from "@hortus/core";
import { scripted, tempHome, until } from "@hortus/core/testing";
import { hasTrigger } from "./index.tsx";

const dir = fileURLToPath(new URL("..", import.meta.url));
const first = (req: CompletionRequest) => (req.messages[0]?.role === "user" ? req.messages[0].content : "");
const last = (req: CompletionRequest): Message | undefined => req.messages.at(-1);
const usage = { input: 10, output: 5, cacheRead: 0 };

/** Answers every request by who sent it, since parallel children's requests interleave. */
function router(answer: (req: CompletionRequest) => Record<string, unknown>) {
  const provider = scripted(Array.from({ length: 50 }, () => (req: CompletionRequest) => answer(req)));
  const agent = () => createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  return { provider, agent };
}

const isParent = (req: CompletionRequest) => req.tools.some((t) => t.name === "workflow");

test("a foreground workflow fans agents out as subruns with their own cwd, tools, role and structured output; the result flows back", async (t) => {
  t.after(await tempHome({ plugins: { workflows: dir } }));
  const work = await realpath(await mkdtemp(join(tmpdir(), "hortus-wf-")));
  t.after(() => rm(work, { recursive: true, force: true }));
  await writeFile(join(work, "notes.txt"), "the answer is 42");
  await mkdir(join(process.env.HOME as string, ".hortus", "agents"), { recursive: true });
  await writeFile(
    join(process.env.HOME as string, ".hortus", "agents", "reader.md"),
    "---\nname: reader\ntools: read\n---\nYou only read files.",
  );
  const script = `export const meta = { name: 'demo', description: 'demo run', phases: [{ title: 'Scan' }, { title: 'Sum' }] }
phase('Scan')
const [found, count] = await parallel([
  () => agent('read notes', { cwd: ${JSON.stringify(work)}, agentType: 'reader', label: 'reader' }),
  () => agent('count things', { schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } }),
])
phase('Sum')
const piped = await pipeline([1, 2], (x) => x * 10, (x) => x + 1)
log('spent ' + budget.spent())
return { found, n: count.n, piped }`;
  const { provider, agent: make } = router((req) => {
    if (isParent(req)) {
      const end = last(req);
      if (end?.role === "tool") return { text: `parent got ${end.results[0]?.output}` };
      return { toolCalls: [{ id: "w", name: "workflow", input: { script, background: false } }] };
    }
    const end = last(req);
    if (first(req) === "read notes")
      return end?.role === "tool"
        ? { text: `found: ${end.results[0]?.output}`, usage }
        : { toolCalls: [{ id: "r", name: "read", input: { path: "notes.txt" } }], usage };
    if (first(req) === "count things")
      return { toolCalls: [{ id: "s", name: "structured_output", input: { n: 3 } }], usage };
    throw new Error(`unexpected request ${first(req)}`);
  });
  const agent = await make();
  const session = await openSession(null);
  await agent.setSession(session);
  await agent.run("go");

  const reader = provider.requests.find((r) => first(r) === "read notes");
  const counter = provider.requests.find((r) => first(r) === "count things");
  // agentType binds the child's tools and role; neither child can start a workflow (no recursion)
  assert.deepEqual(
    reader?.tools.map((x) => x.name),
    ["read"],
  );
  assert.match(reader?.system ?? "", /You only read files\.[\s\S]*Workflow phase: Scan/);
  assert.match(reader?.system ?? "", new RegExp(`Working directory: ${work}\\.`));
  assert.ok(counter?.tools.some((x) => x.name === "structured_output"));
  assert.ok(!counter?.tools.some((x) => x.name === "workflow" || x.name === "workflow_control"));
  assert.match(counter?.system ?? "", /Your final action MUST be a structured_output tool call/);
  // structured_output ends the agent: one request
  assert.equal(provider.requests.filter((r) => first(r) === "count things").length, 1);

  const answer = provider.requests.at(-1);
  const out = last(answer as CompletionRequest);
  assert.ok(out?.role === "tool");
  const value = JSON.parse(out.results[0]?.output ?? "");
  assert.deepEqual(value, { found: "found: the answer is 42", n: 3, piped: [11, 21] });
  // the children's tokens count toward the workflow call
  const saved = session.getState().messages.flatMap((m) => (m.role === "tool" ? m.results : []));
  assert.equal(saved[0]?.usage?.input, 30);
  // and its last progress is the call's details
  assert.match(
    (saved[0]?.details as { line?: string } | undefined)?.line ?? "",
    /demo \(wf-\w+\) completed · Sum · 2\/2 agents · 45 tok/,
  );

  const status = await agent
    .commands()
    .find((c) => c.name === "workflows")
    ?.run("list");
  assert.match(status ?? "", /demo \(wf-\w+\) completed/);
  await agent.close();
});

test("a background workflow returns at once; its result is delivered back as a workflows:result message that starts a turn", async (t) => {
  t.after(await tempHome({ plugins: { workflows: dir } }));
  const script = `export const meta = { name: 'bg', description: 'background run' }
const a = await agent('child task')
return 'final: ' + a`;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { agent: make } = router((req) => {
    if (isParent(req)) {
      const end = last(req);
      if (end?.role === "tool") return { text: "started it" };
      if (end?.role === "user" && end.meta?.type === "result") return { text: "the workflow reported back" };
      return { toolCalls: [{ id: "w", name: "workflow", input: { script } }] };
    }
    return gate.then(() => ({ text: "child result" })) as never;
  });
  const agent = await make();
  const session = await openSession(null);
  await agent.setSession(session);
  const end = await agent.run("go");
  const final = end?.messages.at(-1);
  assert.equal(final?.role === "assistant" && final.text, "started it");
  const call = session.getState().messages.find((m) => m.role === "tool");
  assert.match(
    call?.role === "tool" ? (call.results[0]?.output ?? "") : "",
    /started in the background \(run wf-\w+\)/,
  );

  // Esc on a later turn doesn't stop it: its agents aren't the caller's
  const control = await agent.ctx.runTool({ id: "c", name: "workflow_control", input: { action: "list" } });
  assert.match(control.output, /bg \(wf-\w+\) running · 0\/1 agents/);

  release();
  await until(
    () => session.getState().messages.some((m) => m.role === "assistant" && m.text === "the workflow reported back"),
    3000,
  );
  const delivered = session.getState().messages.find((m) => m.role === "user" && m.meta?.type === "result");
  assert.ok(delivered?.role === "user");
  assert.equal(delivered.meta?.plugin, "workflows");
  assert.match(delivered.content, /Background workflow "bg" \(wf-\w+\) completed[\s\S]*final: child result/);
  await agent.close();
});

test("isolation: 'worktree' runs an agent in its own git worktree and branch; keepWorktree: false removes it", async (t) => {
  t.after(await tempHome({ plugins: { workflows: dir } }));
  const repo = await realpath(await mkdtemp(join(tmpdir(), "hortus-wf-repo-")));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  await writeFile(join(repo, "a.txt"), "x");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const script = `export const meta = { name: 'iso', description: 'isolated' }
return await parallel([
  () => agent('edit in a tree', { isolation: 'worktree', keepWorktree: false }),
  () => agent('edit in another', { isolation: 'worktree' }),
])`;
  const { provider, agent: make } = router((req) => {
    if (isParent(req)) {
      const end = last(req);
      return end?.role === "tool"
        ? { text: "ok" }
        : { toolCalls: [{ id: "w", name: "workflow", input: { script, background: false } }] };
    }
    return { text: `done in ${/Working directory: (.*?)\. /.exec(req.system)?.[1]}` };
  });
  const agent = await make();
  await agent.run("go", { cwd: repo });
  const cwds = provider.requests
    .filter((r) => !isParent(r))
    .map((r) => /Working directory: (.*?)\. /.exec(r.system)?.[1] ?? "");
  assert.equal(cwds.length, 2);
  for (const c of cwds) assert.ok(c.startsWith(join(repo, ".hortus", "worktrees")), c);
  const removed = cwds.find((c) => !existsSync(c));
  const kept = cwds.find((c) => existsSync(c));
  assert.ok(removed && kept, `one tree removed, one kept: ${cwds.map((c) => `${c} ${existsSync(c)}`)}`);
  assert.match(git("branch", "--list", "hortus/wf/*"), /hortus\/wf\//);
  assert.equal(git("branch", "--list", "hortus/wf/*").trim().split("\n").length, 1);
  await agent.close();
});

test("the keyword arms workflows mode for that turn only; identifiers and paths don't", async (t) => {
  t.after(await tempHome({ plugins: { workflows: dir } }));
  const { provider, agent: make } = router(() => ({ text: "ok" }));
  const agent = await make();
  await agent.run("run a workflow to audit the routes");
  await agent.run("look at src/workflow.ts");
  assert.match(provider.requests[0]?.system ?? "", /workflows mode armed/);
  assert.doesNotMatch(provider.requests[1]?.system ?? "", /workflows mode armed/);
  assert.match(provider.requests[0]?.system ?? "", /ONLY call it when the user explicitly opts in/);
  assert.equal(hasTrigger("Workflows, please", "workflow"), true);
  assert.equal(hasTrigger("myworkflow workflow_name", "workflow"), false);
  await agent
    .commands()
    .find((c) => c.name === "workflows-trigger")
    ?.run("off");
  await agent.run("run a workflow");
  assert.doesNotMatch(provider.requests[2]?.system ?? "", /workflows mode armed/);
  await agent.close();
});

test("TUI: the live panel shows a running workflow's agents; /workflows opens the navigator in place of the transcript", async (t) => {
  t.after(await tempHome({ plugins: { workflows: dir } }));
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const script = `export const meta = { name: 'tui_run', description: 'shown in the TUI', phases: [{ title: 'Work' }] }
phase('Work')
return await agent('slow task', { label: 'slowpoke' })`;
  const provider = scripted(
    Array.from({ length: 10 }, () => (req: CompletionRequest) => {
      if (!isParent(req)) return gate.then(() => ({ text: "slow done" }));
      const end = last(req);
      return end?.role === "tool"
        ? { text: "started" }
        : end?.role === "user" && end.meta
          ? { text: "reported" }
          : { toolCalls: [{ id: "w", name: "workflow", input: { script } }] };
    }),
  );
  const cli = await startCli({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  const ui = renderApp(cli, { columns: 100, rows: 30 });
  t.after(() => ui.app.unmount());
  cli.submit("go");
  await until(() => ui.screen().includes("slowpoke (scripted/scripted)"));
  assert.match(
    ui.screen(),
    /◆ tui_run \(wf-\w+\) running · Work · 0\/1 agents[\s\S]*◆ slowpoke \(scripted\/scripted\)/,
  );

  await until(() => !cli.ui.getState().busy);
  cli.submit("/workflows");
  await until(() => ui.screen().includes("↑/↓ select"));
  ui.keys("\r");
  await until(() => ui.screen().includes("shown in the TUI"));
  assert.match(ui.screen(), /▸ Work[\s\S]*◆ slowpoke/);
  ui.keys("\x1b");
  await until(() => ui.screen().includes("↑/↓ select"));
  ui.keys("q");
  await until(() => !ui.screen().includes("↑/↓ select"));

  release();
  await until(() => ui.screen().includes("◆ workflow result"), 3000);
  await until(() => ui.screen().includes("reported"));
  await cli.close();
});
