import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgent, type GatedCall, hortusDir, type Plugin, type ToolResult, tool } from "@hortus/core";
import { scripted, tempDir, tempHome } from "@hortus/core/testing";
import { z } from "zod";
import fabric from "./index.tsx";
import type { FabricDetails } from "./runtime.ts";

const here = fileURLToPath(new URL("..", import.meta.url));
const guardDir = fileURLToPath(new URL("../../guard", import.meta.url));

/** A tool as builtin:mcp would make one, and an extension tool. */
const mcpTool = tool({
  name: "mcp__issue-db__get_issue",
  description: "Fetch an issue by number",
  inputSchema: z.object({ n: z.number() }),
  exposure: "codemode",
  execute: async ({ n }) => ({ n, title: `issue ${n}` }),
});
const status = tool({
  name: "project_status",
  description: "The project's deploy status",
  inputSchema: z.object({}),
  execute: async () => "green",
});

/** Runs one `fabric_exec` call with `code` (and `payloads`); returns the requests, the results and the gated calls. */
async function exec(code: string, opts: { payloads?: Record<string, string>; extra?: Plugin } = {}) {
  const provider = scripted([
    { toolCalls: [{ id: "1", name: "fabric_exec", input: { code, payloads: opts.payloads, display: "probe" } }] },
    { text: "done" },
  ]);
  const gated: GatedCall[] = [];
  const results: ToolResult[] = [];
  const agent = await createAgent({
    extra: [
      {
        name: "scripted",
        plugin: {
          providers: { scripted: provider },
          tools: [mcpTool, status],
          on: {
            tool_call: (p) => void gated.push(p.call),
            tool_result: (p) => void (p.call.name === "fabric_exec" && results.push(p.result)),
          },
        },
      },
      ...(opts.extra ? [{ name: "approver", plugin: opts.extra }] : []),
    ],
  });
  await agent.run("go");
  await agent.close();
  return { provider, gated, result: results[0] };
}

test("full code mode: only fabric_exec is declared; a program reads, writes and calls MCP and extension tools", async (t) => {
  t.after(await tempHome({ plugins: { fabric: here } }));
  const dir = await tempDir(t, "fabric-");
  await writeFile(join(dir, "a.txt"), "alpha\n");
  const code = `
    const text: string = await pi.read(${JSON.stringify(join(dir, "a.txt"))});
    const w = await pi.write({ path: ${JSON.stringify(join(dir, "b.txt"))}, content: π.body });
    const issue = await mcp.issue_db.get_issue({ n: 7 });
    const ext = await extensions.project_status({});
    const found = await tools.search({ query: "issue" });
    const via = await tools.call({ ref: "pi.bash", args: { command: "echo hi" } });
    print("logged");
    return { text, wrote: w.ok, issue, ext: ext.text, found: found.map((f) => f.ref), via: via.output };`;
  const { provider, gated, result } = await exec(code, { payloads: { body: "from payload" } });
  const first = provider.requests[0];
  assert.deepEqual(
    first?.tools.map((x) => x.name),
    ["fabric_exec"],
  );
  assert.match(first?.tools[0]?.description ?? "", /declare const pi: \{[\s\S]*read\(input/);
  assert.match(first?.tools[0]?.description ?? "", /mcp\.issue_db\.get_issue, extensions\.project_status/);
  assert.match(first?.system ?? "", /Fabric: use fabric_exec/);
  assert.equal(result?.isError, undefined, result?.output ?? "");
  const out = JSON.parse((result?.output ?? "").split("\nLogs:")[0] ?? "");
  assert.deepEqual(out, {
    text: "alpha\n",
    wrote: true,
    issue: { n: 7, title: "issue 7" },
    ext: "green",
    found: ["mcp.issue_db.get_issue"],
    via: "hi\n",
  });
  assert.match(result?.output ?? "", /\nLogs:\nlogged$/);
  assert.equal(await readFile(join(dir, "b.txt"), "utf8"), "from payload");
  // every nested call went through the gate, as a child of the fabric_exec call
  assert.deepEqual(
    gated.filter((c) => c.parentId).map((c) => [c.parentId, c.name]),
    [
      ["1", "read"],
      ["1", "write"],
      ["1", "mcp__issue-db__get_issue"],
      ["1", "project_status"],
      ["1", "bash"],
    ],
  );
  assert.deepEqual(
    (result?.details as FabricDetails | undefined)?.calls.map((c) => [c.ref, c.status]),
    [
      ["pi.read", "done"],
      ["pi.write", "done"],
      ["mcp.issue_db.get_issue", "done"],
      ["extensions.project_status", "done"],
      ["pi.bash", "done"],
    ],
  );
});

const allow: Plugin = { on: { ask: (p) => p.resolve("Allow") } };

test("guard blocks rm -rf / from inside fabric_exec, by proxy, by ref and with settle", async (t) => {
  t.after(await tempHome({ plugins: { fabric: here, guard: guardDir } }));
  // fabric_exec declares `effects.code`: with no one to approve it, guard blocks the program itself
  assert.equal((await exec(`return "ran";`)).result?.output, "Blocked by guard: no one approved the code");
  for (const call of [
    "pi.bash({ command: 'rm -rf /' })",
    "pi.bash('rm -rf /')",
    "tools.call({ ref: 'pi.bash', args: { command: 'rm -rf /' } })",
    "pi.bash({ command: 'rm -rf /', settle: true })",
  ]) {
    // guard asks before fabric_exec itself (its node:vm is no sandbox): allowed, so its nested calls reach the gate
    const { result } = await exec(`await ${call}; return "ran";`, { extra: allow });
    assert.equal(result?.isError, true, call);
    assert.match(result?.output ?? "", /Program error: pi\.bash: Blocked by guard: it would delete/, call);
  }
});

test("a direct call to a hidden tool is unknown, with a hint; settle reports exit codes", async (t) => {
  t.after(await tempHome({ plugins: { fabric: here } }));
  const provider = scripted([{ toolCalls: [{ id: "1", name: "bash", input: { command: "ls" } }] }, { text: "done" }]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  await agent.run("go");
  await agent.close();
  const last = provider.requests[1]?.messages.at(-1);
  const [r] = last?.role === "tool" ? last.results : [];
  assert.equal(r?.output, "Unknown tool: bash (call it from fabric_exec: `await pi.bash(input)`)");

  const { result } = await exec(
    "const r = await pi.bash({ command: 'echo out; exit 3', settle: true }); return [r.ok, r.exitCode, r.output];",
  );
  assert.deepEqual(JSON.parse(result?.output ?? ""), [false, 3, "out\n\nCommand exited with code 3"]);
  const failed = await exec("await pi.bash('true'); await pi.bash('exit 2');");
  assert.match(failed.result?.output ?? "", /pi\.bash: Command exited with code 2\nCompleted before the failure: /);
  const missing = await exec("return π.nope;", { payloads: { body: "x" } });
  assert.match(missing.result?.output ?? "", /π\.nope is not a payload of this call; its payloads: body/);
});

test("a program's timeout cancels its nested calls still running", async (t) => {
  t.after(await tempHome({ plugins: { fabric: here } }));
  await writeFile(join(hortusDir(), "fabric.json"), JSON.stringify({ executor: { timeoutMs: 100 } }));
  const marker = join(await tempDir(t, "fabric-"), "ran");
  const { result } = await exec(`await pi.bash(${JSON.stringify(`sleep 0.5; touch ${marker}`)});`);
  assert.match(result?.output ?? "", /Program timed out after 100 ms/);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(existsSync(marker), false);
});

test("approvals: deny blocks nested calls; ask with 'Allow for this session' asks once", async (t) => {
  t.after(await tempHome({ plugins: { fabric: here } }));
  await writeFile(join(hortusDir(), "fabric.json"), JSON.stringify({ approvals: { execute: "deny", read: "ask" } }));
  const denied = await exec("await pi.bash('echo hi')");
  assert.match(denied.result?.output ?? "", /Denied by fabric \(execute\): approvals\.execute is "deny"/);
  const asks: string[] = [];
  const approver: Plugin = {
    on: {
      ask: (p) => {
        asks.push(p.question);
        p.resolve("Allow for this session");
      },
    },
  };
  const { result } = await exec("await pi.read('/etc/hostname').catch(() => 0); await pi.bash('ls').catch(() => 0);", {
    extra: approver,
  });
  assert.equal(result?.isError, undefined, result?.output ?? "");
  assert.deepEqual(asks, ["Allow pi.read (read)?"]);
});

test("orchestration-only mode keeps tools native and leaves only MCP to programs; output is capped", async (t) => {
  t.after(await tempHome({ plugins: { fabric: here } }));
  await writeFile(
    join(hortusDir(), "fabric.json"),
    JSON.stringify({ fullCodeMode: false, executor: { maxOutputChars: 200 } }),
  );
  const { provider, result } = await exec(
    "return [typeof pi.read, (await mcp.issue_db.get_issue({ n: 1 })).title, 'x'.repeat(500)].join(' ');",
  );
  const names = provider.requests[0]?.tools.map((x) => x.name);
  assert.deepEqual(names?.sort(), ["bash", "edit", "fabric_exec", "project_status", "read", "write"]);
  assert.match(result?.output ?? "", /^undefined issue 1 x+\n… \[\d+ characters omitted; full output: (\S+)\] …/);
  const path = /full output: (\S+)\]/.exec(result?.output ?? "")?.[1] ?? "";
  assert.equal((await readFile(path, "utf8")).length, 518);
  await rm(path);
});

test("renderer: compact card with each nested call; Ctrl+O adds the program", () => {
  const view = {
    call: { id: "1", name: "fabric_exec", input: { code: "return 1", display: { name: "count", description: "obj" } } },
    result: { id: "1", output: "1" },
    details: { calls: [{ ref: "pi.read", input: { path: "a" }, status: "done" }] } satisfies FabricDetails,
    width: 60,
  };
  const r = fabric.cli.tools.fabric_exec;
  assert.equal(r.text(view), 'fabric count\nobj\n✓ pi.read {"path":"a"}\n\n1');
  assert.equal(r.text({ ...view, expanded: true }), 'fabric count\nobj\n✓ pi.read {"path":"a"}\n\nreturn 1\n\n1');
});

test("agents.run starts a child agent from a program and resolves its final text", async (t) => {
  t.after(await tempHome({ plugins: { fabric: here } }));
  const dir = await tempDir(t, "fabric-agent-");
  const code = `const r = await agents.run({ task: "summarize", tools: ["read"], cwd: ${JSON.stringify(dir)} }); return r.status + ": " + r.text;`;
  const provider = scripted([
    { toolCalls: [{ id: "1", name: "fabric_exec", input: { code, display: "delegate" } }] },
    { text: "a summary" },
    { text: "done" },
  ]);
  const runs: { depth?: number; cwd?: string }[] = [];
  const agent = await createAgent({
    extra: [
      {
        name: "scripted",
        plugin: {
          providers: { scripted: provider },
          on: { run_start: (_, ctx) => void runs.push({ depth: ctx.run?.depth, cwd: ctx.run?.cwd }) },
        },
      },
    ],
  });
  await agent.run("go");
  await agent.close();
  assert.deepEqual(runs[1], { depth: 1, cwd: dir });
  assert.deepEqual(
    provider.requests[1]?.tools.map((x) => x.name),
    ["read"],
  );
  const last = provider.requests[2]?.messages.at(-1);
  assert.equal(last?.role === "tool" && last.results[0]?.output, "completed: a summary");
});
