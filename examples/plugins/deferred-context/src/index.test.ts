import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type CompletionRequest, createAgent, hortusDir, type Message, openSession, tool } from "@hortus/core";
import { scripted, tempHome } from "@hortus/core/testing";
import { z } from "zod";

const dir = fileURLToPath(new URL("..", import.meta.url));
const user: Message[] = [{ role: "user", content: "go" }];
const names = (r?: CompletionRequest) => r?.tools.map((t) => t.name) ?? [];
const results = (r?: CompletionRequest) => {
  const last = r?.messages.at(-1);
  return last?.role === "tool" ? last.results.map((x) => x.output) : [];
};
const call = (name: string, input: unknown = {}, id = name) => ({ id, name, input });

/**
 * A plugin sorting after deferred-context that declares `write` in every request: deferred-context (`order: "last"`)
 * still sees the final tools, so `write` stays deferred.
 */
const zz = {
  "hortus.json": JSON.stringify({ name: "zz", version: "1.0.0", entrypoint: "index.js" }),
  "index.js": `export default { on: { request: (r, ctx) => { r.tools.push(...ctx.tools.filter((t) => t.name === "write")); } } };`,
};

/** A temp home with the plugin, and a temp project (cwd) holding `agentsMd`, so this repo's AGENTS.md stays out. */
async function setup(t: TestContext, agentsMd: string) {
  t.after(await tempHome({ plugins: { "deferred-context": dir, zz } }));
  const cwd = process.cwd();
  const project = await mkdtemp(join(tmpdir(), "dce-project-"));
  t.after(async () => {
    process.chdir(cwd);
    await rm(project, { recursive: true, force: true });
  });
  await mkdir(join(project, ".git"));
  await writeFile(join(project, "AGENTS.md"), agentsMd);
  process.chdir(project);
}

test("deferred-context: only search_tools is declared; a search promotes tools for the run and loads a skill", async (t) => {
  await setup(t, "Ship small changes.\n");
  await mkdir(join(hortusDir(), "skills", "release"), { recursive: true });
  await writeFile(
    join(hortusDir(), "skills", "release", "SKILL.md"),
    "---\nname: release\ndescription: Cut a release, bump the version, tag and publish\n---\nRun the release script.\n",
  );
  const jira = tool({
    name: "jira_create_issue",
    description: "Create a Jira issue in a project",
    inputSchema: z.object({ title: z.string() }),
    execute: async ({ title }) => `created ${title}`,
  });
  const provider = scripted([
    { toolCalls: [call("search_tools", { query: "jira issue" })] },
    { toolCalls: [call("jira_create_issue", { title: "bug" })] },
    { text: "done" },
    // next run: promotions are gone; skills are found by the same search; a deferred tool isn't declared
    { toolCalls: [call("search_tools", { query: "release", kind: "skill" }), call("read", { path: "x" })] },
    { text: "done" },
  ]);
  const agent = await createAgent({
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [jira] } }],
  });
  await agent.run("go");
  // a preview ends with run_end too, which drops its per-run state
  await agent.ctx.preview(user);
  await agent.run("go");
  const [first, promoted, ran, next, loaded] = provider.requests;
  assert.deepEqual(agent.plugins.map((p) => p.name).slice(-3), ["zz", "deferred-context", "scripted"]);

  assert.deepEqual(names(first), ["search_tools"]);
  assert.match(first?.system ?? "", /<deferred_tools>/);
  assert.doesNotMatch(first?.system ?? "", /<available_skills>|Cut a release/);
  assert.deepEqual(names(promoted), ["search_tools", "jira_create_issue"]);
  assert.deepEqual(results(promoted), ["Promoted tools: jira_create_issue"]);
  assert.deepEqual(results(ran), ["created bug"]);
  assert.deepEqual(names(next), ["search_tools"]);
  const [skill, read] = results(loaded);
  assert.match(
    skill ?? "",
    /^Loaded skill release from .*SKILL\.md:\n\n---\nname: release[\s\S]*Run the release script\./,
  );
  assert.match(read ?? "", /^Unknown tool: read/);
});

test("deferred-context: pins, priority, blocks, session promotions of codemode tools, one copy of AGENTS.md", async (t) => {
  await setup(t, "Be terse.\n");
  await writeFile(join(hortusDir(), "AGENTS.md"), "Be terse.\n");
  await writeFile(
    join(hortusDir(), "deferred-tools.json"),
    JSON.stringify({
      alwaysActive: ["read", "list_capabilities"],
      toolPriority: ["read"],
      blockedTools: ["bash"],
      promotionLifetime: "session",
    }),
  );
  // an MCP-like tool: callable, but not declared unless promoted
  const tracker = tool({
    name: "mcp__tracker__create_issue",
    description: "Create an issue in the tracker",
    inputSchema: z.object({}),
    exposure: "codemode",
    execute: async () => "created",
  });
  const provider = scripted([
    { toolCalls: [call("list_capabilities"), call("search_tools", { query: "tracker issue" })] },
    { toolCalls: [call("mcp__tracker__create_issue")] },
    { text: "done" },
    { text: "done" },
  ]);
  const agent = await createAgent({
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [tracker] } }],
  });
  const session = await openSession(null);
  await agent.setSession(session);
  await agent.run("go");
  await agent.run("go");
  const [first, listed, ran, next] = provider.requests;

  assert.deepEqual(names(first), ["read", "search_tools", "list_capabilities"]);
  assert.equal(first?.system.split("Be terse.").length, 2);
  assert.match(first?.system ?? "", /<dce_tool_priority>\nDCE owns tool selection priority: \["read"\]/);
  const [list, search] = results(listed);
  assert.match(list ?? "", /^active {2,}tool +read {2}--/m);
  assert.match(list ?? "", /^blocked {2,}tool +bash {2}--/m);
  assert.match(list ?? "", /^deferred {2,}tool +write {2}--/m);
  assert.match(list ?? "", /^deferred {2,}tool +mcp__tracker__create_issue \[codemode; nested=true\] {2}--/m);
  assert.equal(search, "Promoted tools: mcp__tracker__create_issue");
  assert.ok(names(listed).includes("mcp__tracker__create_issue"));
  assert.deepEqual(results(ran), ["created"]);
  // promotionLifetime "session": still declared in the next run
  assert.ok(names(next).includes("mcp__tracker__create_issue"));

  // blocked even when called from outside the model, until a human unblocks it
  const bash = () => agent.ctx.runTool(call("bash", { command: "echo hi" }));
  assert.match((await bash()).output, /^DCE blocks this tool: bash/);
  // and from a codemode script, whose calls pass the same gate
  const script = await agent.ctx.runTool(call("codemode", { code: "await tools.bash({ command: 'echo hi' });" }));
  assert.match(script.output, /Script error: DCE blocks this tool: bash/);
  // run as any host runs it: with the plugin's host ctx, on the current session
  const deferred = agent.commands().find((c) => c.name === "deferred");
  assert.equal(await deferred?.run("blocked"), "Blocked: bash");
  assert.equal(await deferred?.run("unblock bash nope"), "Unblocked for this session: bash; Not blocked: nope");
  assert.match((await bash()).output, /hi/);
  assert.match((await deferred?.run("status")) ?? "", /blocked: bash \(unblocked this session\)/);
  // all of it is the session's: a resumed one has it, a new one doesn't
  const resumed = await openSession(session.leafId);
  await agent.setSession(resumed, "resume");
  assert.match((await bash()).output, /hi/);
  assert.match((await deferred?.run("status")) ?? "", /promoted this session: mcp__tracker__create_issue/);
  await agent.setSession(await openSession(null), "new");
  assert.match((await bash()).output, /^DCE blocks this tool: bash/);
});
