import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "@hortus/cli";
import { type Agent, createAgent, type Plugin, type ToolResult, tool } from "@hortus/core";
import { scripted, tempHome } from "@hortus/core/testing";
import { z } from "zod";
import { compactToolOutput } from "./compactor.ts";
import { normalizeConfig } from "./config.ts";

/** A stand-in `rtk` on PATH: rewrites `git status` and `echo plain`, runs `rtk git status`; `RTK_BROKEN` fails --version. */
const FAKE_RTK = `#!/bin/sh
case "$1" in
  --version) [ -n "$RTK_BROKEN" ] && exit 1; echo "rtk 0.0.0-test" ;;
  rewrite)
    [ "$2" = "git status" ] && { echo "rtk git status"; exit 0; }
    [ "$2" = "echo plain" ] && { echo "echo rewritten"; exit 0; }
    exit 1 ;;
  git) printf '\\033[32mclean\\033[0m db=%s\\n' "$RTK_DB_PATH" ;;
esac
`;

async function setup(t: import("node:test").TestContext) {
  t.after(await tempHome({ plugins: { "rtk-optimizer": fileURLToPath(new URL("..", import.meta.url)) } }));
  const bin = await mkdtemp(join(tmpdir(), "rtk-bin-"));
  await writeFile(join(bin, "rtk"), FAKE_RTK);
  await chmod(join(bin, "rtk"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(async () => {
    process.env.PATH = path;
    delete process.env.RTK_BROKEN;
    await rm(bin, { recursive: true });
  });
}

/** `/rtk <arg>` of the agent's loaded plugin */
const rtk = (agent: Agent) => async (arg: string) =>
  agent
    .commands()
    .find((c) => c.name === "rtk")
    ?.run(arg);
const extra = (plugin: Plugin) => ({ provided: { "@hortus/cli": version }, extra: [{ name: "scripted", plugin }] });
const bash = (id: string, command: string) => ({ id, name: "bash", input: { command } });

test("rewrites bash commands through rtk for execution only, and compacts bash/grep output and progress", async (t) => {
  await setup(t);
  // by call id: parallel calls finish in any order
  const seen = {
    results: {} as Record<string, ToolResult>,
    inputs: {} as Record<string, unknown>,
    updates: [] as [id: string, details: unknown][],
    notes: [] as string[],
  };
  const observer: Plugin = {
    providers: {},
    tools: [
      // a grep tool (hortus has none built in)
      tool({
        name: "grep",
        description: "search",
        inputSchema: z.object({ pattern: z.string() }),
        execute: async () => "src/a.ts:1:foo\nsrc/a.ts:9:foo again\nsrc/b.ts:3:foo",
      }),
    ],
    on: {
      tool_update: ({ call, details }) => void seen.updates.push([call.id, details]),
      notify: ({ text }) => void seen.notes.push(text),
      tool_result: ({ call, result }) => {
        seen.inputs[call.id] = call.input;
        seen.results[call.id] = result;
      },
    },
  };
  const provider = scripted([
    {
      toolCalls: [
        bash("1", "git status"),
        bash("2", "printf '\\033[1mbold\\033[0m\\n'; head -c 13000 /dev/zero | tr '\\0' x"),
        { id: "3", name: "grep", input: { pattern: "foo" } },
        // long enough for builtin:bash to stream its coloured output
        bash("4", "printf '\\033[31mrunning\\033[0m\\n'; sleep 0.4"),
      ],
    },
    { text: "done" },
  ]);
  const agent = await createAgent(extra({ ...observer, providers: { scripted: provider } }));
  const end = await agent.run("status?");

  // the command ran as rtk's, with its history db in a temp dir; the model and the history keep the original
  const { 1: git, 2: long, 3: grep } = seen.results;
  assert.match(git?.output ?? "", /^clean db=.*pi-rtk-optimizer\/history\.db\n$/);
  assert.match((seen.inputs[1] as { command: string }).command, /^export RTK_DB_PATH='.*'; rtk git status$/);
  assert.deepEqual(seen.notes, ["RTK rewrite: git status -> rtk git status"]);
  const assistant = end?.messages[1];
  assert.deepEqual(assistant?.role === "assistant" && assistant.toolCalls[0]?.input, { command: "git status" });
  // ANSI stripped and hard-truncated, recorded in details (the model gets only the output)
  assert.equal(long?.output.length, 12_000);
  assert.match(long?.output ?? "", /^bold\nx+\.\.\.$/);
  assert.deepEqual(
    (long?.details as { rtkCompaction: { techniques: string[] } } | undefined)?.rtkCompaction.techniques,
    ["ansi", "truncate"],
  );
  assert.match(grep?.output ?? "", /^3 matches in 2 files:\n\n> src\/a\.ts \(2 matches\):\n {4}1: foo\n/);
  // bash's live output loses its colour codes (then bash clears it: the result has the output)
  assert.deepEqual(
    seen.updates.filter(([id]) => id === "4").map(([, d]) => d),
    [{ output: "running\n" }, undefined],
  );
  const sent = provider.requests[1]?.messages.at(-1);
  assert.deepEqual(
    sent?.role === "tool" && sent.results.map((r) => r.output),
    [git, long, grep, seen.results[4]].map((r) => r?.output),
  );
  const stats = String(await rtk(agent)("stats"));
  for (const line of [/^calls=4, saved=/m, /^- bash: 3 calls, saved /m, /^- grep: 1 calls, saved /m])
    assert.match(stats, line);
});

test("/rtk verify reports a broken rtk, and then commands run unchanged", async (t) => {
  await setup(t);
  const provider = scripted([
    { toolCalls: [bash("1", "echo plain")] },
    { text: "done" },
    { toolCalls: [bash("2", "echo plain")] },
    { text: "done" },
  ]);
  const agent = await createAgent(extra({ providers: { scripted: provider } }));
  const command = rtk(agent);
  const output = (i: number) => {
    const sent = provider.requests[i]?.messages.at(-1);
    return sent?.role === "tool" && sent.results[0]?.output;
  };
  process.env.RTK_BROKEN = "1";
  await assert.rejects(command("verify"), /RTK binary is not available: .*exit 1/);
  assert.match(String(await command("show")), /mode=rewrite.*rtk=missing/);
  await agent.run("hi");
  assert.equal(output(1), "plain\n");

  delete process.env.RTK_BROKEN;
  assert.match(String(await command("verify")), /^RTK binary is available at .*\/rtk\.$/);
  await agent.run("hi");
  assert.equal(output(3), "rewritten\n");
});

test("read compaction keeps hashline anchors whole, and leaves skill files exact when asked", () => {
  const config = normalizeConfig({
    outputCompaction: {
      readCompaction: { enabled: true },
      truncate: { maxChars: 1000 },
      preserveExactSkillReads: true,
    },
  });
  const text = Array.from({ length: 200 }, (_, i) => `${i + 1}#ab:const value${i} = ${i};`).join("\n");
  const out = compactToolOutput("read", { path: "src/a.ts" }, text, config)?.text ?? "";
  assert.ok(out.length <= 1000 + 60, String(out.length));
  const lines = out.split("\n");
  assert.equal(lines[0], "[RTK compacted output: truncate]");
  assert.match(lines.at(-1) ?? "", /^\[RTK anchor-safe truncate/);
  for (const line of lines.slice(1, -1)) assert.match(line, /^\d+#ab:const value\d+ = \d+;$/);
  assert.equal(compactToolOutput("read", { path: "/skills/x/SKILL.md" }, text, config, ["/skills/x"]), undefined);
  assert.equal(compactToolOutput("read", { path: "src/a.ts", offset: 1 }, text, config), undefined);
});

test("/rtk alone asks which setting to flip where someone can answer; suggest mode notifies instead of rewriting", async (t) => {
  await setup(t);
  const provider = scripted([{ toolCalls: [bash("1", "echo plain")] }, { text: "done" }]);
  const notes: string[] = [];
  const asked: string[] = [];
  const answer: Plugin = {
    providers: { scripted: provider },
    on: {
      ask: (p) => {
        asked.push(`${p.question} ${p.options?.map((o) => `${o.label}=${o.description}`).join(" ")}`);
        p.resolve("mode");
      },
      notify: ({ text }) => void notes.push(text),
    },
  };
  const headless = await createAgent(extra(answer));
  assert.match(String(await rtk(headless)("")), /^rtk: enabled=true, mode=rewrite/);
  assert.deepEqual(asked, []);
  const agent = await createAgent({ ...extra(answer), host: { kind: "tui", interactive: true } });
  // this test's rtk (the module keeps the last one found)
  await rtk(agent)("verify");
  assert.equal(await rtk(agent)(""), "rtk mode=suggest");
  assert.match(asked[0] ?? "", /^RTK settings: pick one to change enabled=true mode=rewrite/);
  const end = await agent.run("hi");
  const result = end?.messages.at(-2);
  assert.deepEqual(result?.role === "tool" && result.results[0]?.output, "plain\n");
  assert.deepEqual(notes, ["RTK suggestion: echo rewritten"]);
});
