import assert from "node:assert/strict";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgent,
  expandSkill,
  hortusDir,
  type LoadOptions,
  type Message,
  type Named,
  type Plugin,
  type ToolResult,
  tool,
} from "@hortus/core";
import { record, scripted, type Turn, tempDir, tempHome } from "@hortus/core/testing";
import { z } from "zod";
import type { CheckEvent, Config, DecisionEvent } from "./index.ts";
import { analyzeUnit, commandGrant, parseBash } from "./policy.ts";

const PLUGIN = fileURLToPath(new URL("..", import.meta.url));

async function setup(t: test.TestContext, config: Config) {
  t.after(await tempHome({ plugins: { "permission-system": PLUGIN } }));
  await writeFile(join(hortusDir(), "permission-system.json"), JSON.stringify(config));
  return tempDir(t, "perm-");
}

/** An agent on `turns`, answering asks with `answers` in order (none left: nobody answers). */
async function agentWith(
  turns: Turn[],
  { answers = [] as string[], extra = [] as Named[], ...opts }: LoadOptions & { answers?: string[] } = {},
) {
  const provider = scripted(turns);
  const asks: string[] = [];
  const rec = record();
  const host: Plugin = {
    providers: { scripted: provider },
    on: {
      ask: (p) => {
        asks.push(p.question);
        const a = answers.shift();
        if (a !== undefined) p.resolve(a);
      },
    },
  };
  const agent = await createAgent({
    ...opts,
    extra: [{ name: "scripted", plugin: host }, ...extra, { name: "rec", plugin: rec }],
  });
  const decisions = () =>
    rec.events.filter((e) => e.name === "permissions:decision").map((e) => e.payload as DecisionEvent);
  return { agent, provider, asks, rec, decisions };
}

const bash = (id: string, command: string) => ({ id, name: "bash", input: { command } });
const resultsOf = (m: Message | undefined): ToolResult[] => (m?.role === "tool" ? m.results : []);

test("policy: denies (with the rule's reason), nested and path denies, wrapper floors, and hides fully denied tools", async (t) => {
  const cwd = await setup(t, {
    permission: {
      "*": "allow",
      bash: { "*": "allow", "rm *": { action: "deny", reason: "use trash" } },
      path: { "*.env": "deny" },
      write: "deny",
    },
  });
  const { agent, provider, asks } = await agentWith([
    {
      toolCalls: [
        bash("1", "echo hi && rm -rf x"),
        { id: "2", name: "read", input: { path: ".env" } },
        bash("3", "echo ok"),
        bash("4", "echo $(rm y)"),
        bash("5", `bash -c "ls"`),
        bash("6", "cat < .env"),
        bash("7", "echo 'unbalanced"),
      ],
    },
    { text: "done" },
  ]);
  await agent.run("go", { cwd });
  const tools = provider.requests[0]?.tools.map((x) => x.name) ?? [];
  assert.ok(tools.includes("bash") && !tools.includes("write"), tools.join());
  const [rm, env, ok, nested, wrapped, redirect, unparsed] = resultsOf(provider.requests[1]?.messages.at(-1));
  assert.match(
    rm?.output ?? "",
    /^Blocked by permission-system: bash command "rm -rf x" is not permitted.*Reason: use trash$/,
  );
  assert.match(env?.output ?? "", /reading .*\.env is not permitted \(rule path_read "\*\.env"/);
  assert.equal(ok?.output, "ok\n");
  assert.match(nested?.output ?? "", /"rm y" \(inside command substitution\) is not permitted/);
  // allowed by bash "*" but floored to ask, and there's no one to ask
  assert.match(wrapped?.output ?? "", /needs approval and no one can approve it here/);
  assert.match(redirect?.output ?? "", /reading .*\.env \(by cat\) is not permitted/);
  assert.match(unparsed?.output ?? "", /not fully parsed\) needs approval/);
  assert.equal(asks.length, 2);
});

test("asks: allow for the session covers the command's pattern, a typed answer denies with that reason, events on the bus", async (t) => {
  const cwd = await setup(t, { permission: { "*": "allow", bash: { "*": "ask" } } });
  const { agent, provider, asks, rec, decisions } = await agentWith(
    [
      { toolCalls: [bash("a", "echo one")] },
      { toolCalls: [bash("b", "echo two")] },
      { toolCalls: [bash("c", "ls")] },
      { text: "done" },
    ],
    { answers: ["Allow for this session", "use exa instead"] },
  );
  await agent.run("go", { cwd });
  assert.equal(resultsOf(provider.requests[1]?.messages.at(-1))[0]?.output, "one\n");
  assert.equal(resultsOf(provider.requests[2]?.messages.at(-1))[0]?.output, "two\n");
  assert.equal(
    resultsOf(provider.requests[3]?.messages.at(-1))[0]?.output,
    'Blocked by permission-system: the user denied bash command "ls". Reason: use exa instead',
  );
  assert.equal(asks.length, 2);
  assert.match(asks[0] ?? "", /^Allow bash\?\n• bash command "echo one" \(rule bash "\*": ask \(global\)\)$/);
  assert.deepEqual(
    decisions().map((d) => d.resolution),
    ["user_approved_for_session", "session_approved", "user_denied"],
  );
  assert.equal(rec.events.filter((e) => e.name === "permissions:ui_prompt").length, 2);
  // the query API (no session here, so no session approvals)
  const q: CheckEvent = { surface: "bash", value: "echo three" };
  await agent.ctx.emit("permissions:check", q);
  assert.deepEqual(q.result, { action: "ask", pattern: "*", origin: "global" });
});

test("codemode scripts and subruns go through the same gate", async (t) => {
  const cwd = await setup(t, { permission: { "*": "allow", bash: { "*": "allow", "rm *": "deny" } } });
  const lookup = tool({
    name: "lookup",
    description: "",
    inputSchema: z.object({}),
    exposure: "codemode",
    execute: async () => "",
  });
  const spawn = tool({
    name: "spawn",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      const end = await ctx.subrun("clean up").done;
      return resultsOf(end?.messages.at(-2))[0]?.output ?? "";
    },
  });
  const code = "await tools.bash({ command: 'rm -rf /tmp/x' });";
  const { agent, provider } = await agentWith(
    [
      {
        toolCalls: [
          { id: "c", name: "codemode", input: { code } },
          { id: "s", name: "spawn", input: {} },
        ],
      },
      { toolCalls: [bash("b", "rm -rf /tmp/y")] },
      { text: "child done" },
      { text: "done" },
    ],
    { extra: [{ name: "tools", plugin: { tools: [lookup, spawn] } }] },
  );
  await agent.run("go", { cwd });
  const [script, child] = resultsOf(provider.requests[3]?.messages.at(-1));
  assert.match(script?.output ?? "", /Script error: Blocked by permission-system: bash command "rm -rf \/tmp\/x"/);
  assert.match(child?.output ?? "", /^Blocked by permission-system: bash command "rm -rf \/tmp\/y"/);
});

test("required: a subrun whose plugin filter leaves permission-system out is still gated (a harmless probe write)", async (t) => {
  const cwd = await setup(t, { permission: { "*": "allow", write: "ask" } });
  const spawn = tool({
    name: "spawn",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      const end = await ctx.subrun("write it", { plugins: { only: ["builtin:write"] } }).done;
      return resultsOf(end?.messages.find((m) => m.role === "tool"))[0]?.output ?? "no result";
    },
  });
  const { agent, provider } = await agentWith(
    [
      { toolCalls: [{ id: "s", name: "spawn", input: {} }] },
      { toolCalls: [{ id: "w", name: "write", input: { path: join(cwd, "out.txt"), content: "x" } }] },
      { text: "child done" },
      { text: "done" },
    ],
    { extra: [{ name: "tools", plugin: { tools: [spawn] } }] },
  );
  await agent.run("go", { cwd });
  const [result] = resultsOf(provider.requests[2]?.messages.at(-1));
  assert.match(result?.output ?? "", /^Blocked by permission-system: write .*out\.txt needs approval/);
  await assert.rejects(access(join(cwd, "out.txt")));
});

test("per-subrun policy (agents, keyed by the subrun's agent) hides bash from that child only", async (t) => {
  const cwd = await setup(t, {
    permission: { "*": "allow" },
    agents: { reviewer: { permission: { bash: "deny" } } },
  });
  const spawn = tool({
    name: "spawn",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => (await ctx.subrun("review", { agent: "reviewer" }).done)?.messages.at(-1)?.role ?? "",
  });
  const { agent, provider } = await agentWith(
    [{ toolCalls: [{ id: "s", name: "spawn", input: {} }] }, { text: "reviewed" }, { text: "done" }],
    { extra: [{ name: "tools", plugin: { tools: [spawn] } }] },
  );
  await agent.run("go", { cwd });
  assert.ok(provider.requests[0]?.tools.some((x) => x.name === "bash"));
  assert.ok(!provider.requests[1]?.tools.some((x) => x.name === "bash"));
});

test("skills: denied ones leave the prompt, invoking or reading an asked one is gated, reading an allowed one skips external_directory", async (t) => {
  const cwd = await setup(t, {
    permission: { "*": "allow", skill: { "*": "allow", secret: "deny", gated: "ask" }, external_directory: "ask" },
  });
  const skill = async (name: string) => {
    const path = join(hortusDir(), "skills", name, "SKILL.md");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `---\nname: ${name}\ndescription: the ${name} skill\n---\nDo ${name} things.\n`);
    return { name, description: `the ${name} skill`, path };
  };
  const open = await skill("open");
  const gated = await skill("gated");
  await skill("secret");
  const read = (id: string, path: string) => ({ id, name: "read", input: { path } });
  const { agent, provider, asks } = await agentWith([
    {
      toolCalls: [read("1", open.path), read("2", gated.path), read("3", join(hortusDir(), "permission-system.json"))],
    },
    { text: "done" },
  ]);
  // invoking a skill that asks, with no one to ask: no run starts
  assert.equal(await agent.run(await expandSkill(gated), { cwd }), undefined);
  assert.equal(provider.requests.length, 0);
  await agent.run("go", { cwd });
  const system = provider.requests[0]?.system ?? "";
  assert.ok(system.includes("<name>open</name>") && system.includes("<name>gated</name>"));
  assert.ok(!system.includes("<name>secret</name>"));
  const [r1, r2, r3] = resultsOf(provider.requests[1]?.messages.at(-1));
  assert.match(r1?.output ?? "", /Do open things/);
  assert.match(r2?.output ?? "", /skill "gated" .*needs approval/);
  assert.match(r3?.output ?? "", /outside the working directory needs approval/);
  assert.equal(asks.length, 3);
});

test("authorizer chain: a listed link decides before the prompt, an unlisted one is ignored; yolo via the command", async (t) => {
  const cwd = await setup(t, { permission: { "*": "allow", bash: { "*": "ask" } }, authorizerChain: ["judge"] });
  const judge: Plugin = {
    on: {
      "permissions:authorize": (p, ctx) => {
        const curl = p.checks.some((c) => c.value.startsWith("curl"));
        p.verdicts.push({ name: ctx.plugin, verdict: curl ? "deny" : "defer", reason: "no network" });
      },
    },
  };
  const rogue: Plugin = {
    on: { "permissions:authorize": (p, ctx) => void p.verdicts.push({ name: ctx.plugin, verdict: "allow" }) },
  };
  const { agent, provider, asks, rec } = await agentWith(
    [
      { toolCalls: [bash("1", "curl example.com"), bash("2", "echo hi")] },
      { text: "" },
      { toolCalls: [bash("3", "echo yolo")] },
      { text: "done" },
    ],
    {
      extra: [
        { name: "judge", plugin: judge },
        { name: "rogue", plugin: rogue },
      ],
    },
  );
  await agent.run("go", { cwd });
  const [curl, echo] = resultsOf(provider.requests[1]?.messages.at(-1));
  assert.equal(
    curl?.output,
    'Blocked by permission-system: judge refused bash command "curl example.com". Reason: no network',
  );
  assert.match(echo?.output ?? "", /needs approval/);
  assert.equal(asks.length, 1);

  const cmd = agent.commands().find((c) => c.name === "permission-system");
  assert.equal(await cmd?.run("yolo on"), "Yolo mode is on.");
  assert.ok(rec.events.some((e) => e.name === "status" && (e.payload as { text?: string }).text === "yolo"));
  await agent.run("again", { cwd });
  assert.equal(resultsOf(provider.requests[3]?.messages.at(-1))[0]?.output, "yolo\n");
  assert.equal(asks.length, 1);
  assert.match((await cmd?.run("show")) ?? "", /yolo on.*\nbash "\*": ask \(global\)/s);
});

test("an unanswered prompt times out once shown; a gate error fails closed", async (t) => {
  const cwd = await setup(t, { permission: { "*": "allow", bash: { "*": "ask" } }, promptTimeoutMs: 30 });
  const broken = tool({
    name: "broken",
    description: "",
    inputSchema: z.object({}),
    meta: {
      accessPaths: () => {
        throw new Error("extractor exploded");
      },
    },
    execute: async () => "ran",
  });
  // a UI that shows asks but never answers
  const ui: Plugin = {
    on: {
      ask: (p) => {
        p.show();
        return new Promise((r) => p.signal.addEventListener("abort", () => r()));
      },
    },
  };
  const { agent, provider, decisions } = await agentWith(
    [{ toolCalls: [bash("1", "echo hi"), { id: "2", name: "broken", input: {} }] }, { text: "done" }],
    {
      host: { kind: "test", interactive: true },
      extra: [
        { name: "ui", plugin: ui },
        { name: "tools", plugin: { tools: [broken] } },
      ],
    },
  );
  await agent.run("go", { cwd });
  const [echo, b] = resultsOf(provider.requests[1]?.messages.at(-1));
  assert.match(echo?.output ?? "", /needs approval and nobody answered within 0\.03s/);
  assert.equal(b?.output, "Blocked by permission-system: the permission check failed (extractor exploded)");
  assert.deepEqual(
    decisions().map((d) => d.resolution),
    ["prompt_unanswered", "gate_error"],
  );
});

test("project config applies only once the project is trusted; an invalid one fails closed", async (t) => {
  const cwd = await setup(t, { permission: { "*": "allow", bash: { "*": "ask" } } });
  await mkdir(join(cwd, ".git"));
  await mkdir(join(cwd, ".hortus"));
  const project = (c: unknown) => writeFile(join(cwd, ".hortus", "permission-system.json"), JSON.stringify(c));
  const run = async () => {
    const { agent, provider, rec } = await agentWith([{ toolCalls: [bash("1", "echo hi")] }, { text: "done" }]);
    await agent.run("go", { cwd });
    const notes = rec.events.filter((e) => e.name === "notify").map((e) => (e.payload as { text: string }).text);
    return { output: resultsOf(provider.requests[1]?.messages.at(-1))[0]?.output, notes };
  };
  await project({ permission: { bash: "allow" } });
  const untrusted = await run();
  assert.match(untrusted.output ?? "", /needs approval/);
  assert.match(untrusted.notes[0] ?? "", /skipped: the project isn't trusted/);
  await writeFile(
    join(hortusDir(), "permission-system.json"),
    JSON.stringify({ permission: { "*": "allow", bash: { "*": "ask" } }, trustedProjects: [cwd] }),
  );
  assert.equal((await run()).output, "hi\n");
  // or trusted through ctx.trust (~/.hortus/trust.json)
  await writeFile(
    join(hortusDir(), "permission-system.json"),
    JSON.stringify({ permission: { "*": "allow", bash: { "*": "ask" } } }),
  );
  await writeFile(join(hortusDir(), "trust.json"), JSON.stringify({ trusted: [await realpath(cwd)] }));
  assert.equal((await run()).output, "hi\n");
  await project({ permission: { bash: "sometimes" } });
  const invalid = await run();
  // the global "*": "allow" is clamped to ask, so even an unrelated read asks
  assert.match(invalid.output ?? "", /needs approval/);
  assert.match(invalid.notes[0] ?? "", /failing closed/);
});

test("bash parsing: chains, substitutions, subshells, heredocs, redirects, cd, wrappers and session patterns", () => {
  const p = parseBash("A=1 git status && (cd /tmp; ls x) | grep -v $(id -u) > out.txt 2>&1", "/w");
  assert.equal(p.unparsed, false);
  assert.deepEqual(
    p.units.map((u) => [u.text, u.cwd, u.nested]),
    [
      ["git status", "/w", undefined],
      ["cd /tmp", "/w", "inside a subshell"],
      ["ls x", "/tmp", "inside a subshell"],
      ["id -u", "/w", "inside command substitution"],
      ["grep -v $(id -u) > out.txt 2>&1", "/w", undefined],
    ],
  );
  assert.deepEqual(p.units.at(-1)?.redirects, [{ path: "out.txt", dir: "write" }]);
  const heredoc = parseBash("cat <<'EOF' > f\n$(not run)\nEOF\necho done", "/w");
  assert.deepEqual(
    heredoc.units.map((u) => u.words[0]),
    ["cat", "echo"],
  );
  assert.equal(parseBash("cat <<EOF\n$(rm x)\nEOF", "/w").unparsed, true);
  assert.equal(parseBash('echo "a', "/w").unparsed, true);
  const unit = (c: string) => analyzeUnit(parseBash(c, "/w").units[0] ?? { text: "", words: [], redirects: [] });
  assert.deepEqual(unit("timeout 5 nice -n 3 rm -rf x").words, ["rm", "-rf", "x"]);
  assert.equal(unit("sudo ls").floor, "<indirection-bash-wrapper>");
  assert.equal(unit("find . -exec rm {} ;").floor, "<indirection-bash-wrapper>");
  assert.equal(unit("sh -c 'ls'").floor, "<opaque-bash-wrapper>");
  assert.equal(unit("env FOO=1").floor, undefined);
  assert.equal(commandGrant(["git", "push", "origin"]), "git push *");
  assert.equal(commandGrant(["ls", "-la"]), "ls *");
  assert.equal(commandGrant(["ls"]), "ls");
});
