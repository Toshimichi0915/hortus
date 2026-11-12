import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bashTool, createAgent, type Ctx, type Plugin, tool } from "@hortus/core";
import { scripted, tempDir, tempHome } from "@hortus/core/testing";
import { z } from "zod";
import guard from "./index.ts";

test("guard blocks rm -rf / in bash with a reason the model sees, and lets ls through", async (t) => {
  t.after(await tempHome({ plugins: { guard: fileURLToPath(new URL("..", import.meta.url)) } }));
  const bash = (id: string, command: string) => ({ id, name: "bash", input: { command } });
  const provider = scripted([
    {
      toolCalls: [
        bash("1", "rm -rf /"),
        bash("2", "rm -fr ~"),
        bash("3", "rm -r -f $HOME/"),
        bash("4", "echo ok && ls /"),
        bash("5", "rm -rf /tmp/hortus-guard-test-missing"),
      ],
    },
    { text: "done" },
  ]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  await agent.run("clean up");
  const last = provider.requests[1]?.messages.at(-1);
  const results = last?.role === "tool" ? last.results : [];
  assert.equal(results.length, 5);
  for (const r of results.slice(0, 3)) {
    assert.equal(r.isError, true, r.id);
    assert.match(r.output, /^Blocked by guard: it would delete/);
  }
  assert.equal(results[3]?.isError, undefined);
  assert.match(results[3]?.output ?? "", /^ok\n/);
  // any other path is up to the model: rm runs (and finds nothing to delete)
  assert.doesNotMatch(results[4]?.output ?? "", /Blocked/);
});

test("codemode runs unasked (QuickJS has no way out), and guard blocks the calls its script makes", async (t) => {
  t.after(await tempHome({ plugins: { guard: fileURLToPath(new URL("..", import.meta.url)) } }));
  // a codemode-only tool (as MCP's are), so codemode is declared
  const lookup = tool({
    name: "lookup",
    description: "",
    inputSchema: z.object({}),
    exposure: "codemode",
    execute: async () => "",
  });
  const run = async (code: string, answer?: string) => {
    const provider = scripted([{ toolCalls: [{ id: "1", name: "codemode", input: { code } }] }, { text: "done" }]);
    const asks: string[] = [];
    const plugin: Plugin = {
      providers: { scripted: provider },
      tools: [lookup],
      on: {
        ask: (p) => {
          asks.push(p.question);
          if (answer) p.resolve(answer);
        },
      },
    };
    const agent = await createAgent({ extra: [{ name: "scripted", plugin }] });
    t.after(() => agent.close());
    await agent.run("go");
    const last = provider.requests[1]?.messages.at(-1);
    return { result: last?.role === "tool" ? last.results[0] : undefined, asks };
  };
  // node:vm's old escape finds no process in the isolate (a harmless recorder: an env var in this process)
  const breakout = await run(`console.log.constructor("return process")().env.HORTUS_GUARD_PROBE = "ran";`);
  assert.deepEqual(breakout.asks, []);
  assert.match(breakout.result?.output ?? "", /Script error: .process. is not defined/);
  assert.equal(process.env.HORTUS_GUARD_PROBE, undefined);
  // its tools.* calls pass the gate
  const { result, asks } = await run("await tools.bash({ command: 'rm -rf /' });");
  assert.deepEqual(asks, []);
  assert.equal(result?.isError, true);
  assert.match(result?.output ?? "", /Script error: Blocked by guard: it would delete/);
});

test("guard's rm rule: -R, quoted targets and braced HOME are blocked; other paths aren't", () => {
  // the handler alone, so nothing here ever runs
  const blocked = (command: string) => {
    const p: Parameters<typeof guard.on.tool_gate>[0] = {
      call: { id: "1", name: "bash", input: { command } },
      tool: bashTool,
    };
    void guard.on.tool_gate(p, {} as Ctx);
    return p.block !== undefined;
  };
  for (const command of [
    "rm -rf /",
    "rm -Rf /",
    "rm -fR /*",
    "rm -rf '/'",
    'rm -rf "/"',
    "rm -rf ~/",
    "rm -rf /;",
    "rm  -rf\t/",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
    "rm -rf ${HOME}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
    'rm -rf "${HOME}/"',
    'rm -rf "$HOME"/',
  ])
    assert.equal(blocked(command), true, command);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
  for (const command of ["rm -rf /tmp/x", "rm -rf '/tmp'", "rm -rf ${HOME}/src", "rm -R /"])
    assert.equal(blocked(command), false, command);
});

test("guard asks before write: a denial blocks it, an allow lets it through, and no one to ask blocks it", async (t) => {
  t.after(await tempHome({ plugins: { guard: fileURLToPath(new URL("..", import.meta.url)) } }));
  const dir = await tempDir(t, "guard-");
  const write = (id: string, name: string) => ({ id, name: "write", input: { path: join(dir, name), content: "x" } });
  const results = async (answer?: string) => {
    const provider = scripted([{ toolCalls: [write("1", "a.txt")] }, { text: "done" }]);
    const asks: string[] = [];
    const labels: (string[] | undefined)[] = [];
    const approver: Plugin = {
      providers: { scripted: provider },
      on: {
        ask: (p) => {
          asks.push(p.question);
          labels.push(p.options?.map((o) => o.label));
          if (answer) p.resolve(answer);
        },
      },
    };
    const agent = await createAgent({ extra: [{ name: "scripted", plugin: approver }] });
    await agent.run("write it");
    const last = provider.requests[1]?.messages.at(-1);
    return { result: last?.role === "tool" ? last.results[0] : undefined, asks, labels };
  };
  const denied = await results("Deny");
  assert.deepEqual(denied.labels[0], ["Deny", "Allow"]);
  assert.deepEqual(denied.asks, [`Allow writing ${join(dir, "a.txt")}?`]);
  assert.equal(denied.result?.output, "Blocked by guard: the user denied the write");
  assert.equal((await results()).result?.output, "Blocked by guard: no one approved the write");
  await assert.rejects(readFile(join(dir, "a.txt")));
  assert.equal((await results("Allow")).result?.isError, undefined);
  assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "x");
});

test("guard blocks a subrun's bash call too", async (t) => {
  t.after(await tempHome({ plugins: { guard: fileURLToPath(new URL("..", import.meta.url)) } }));
  const spawn = tool({
    name: "spawn",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      const end = await ctx.subrun("clean up").done;
      const last = end?.messages.at(-2);
      return last?.role === "tool" ? last.results[0]?.output : "";
    },
  });
  const provider = scripted([
    { toolCalls: [{ id: "s", name: "spawn", input: {} }] },
    { toolCalls: [{ id: "b", name: "bash", input: { command: "rm -rf /" } }] },
    { text: "child done" },
    { text: "done" },
  ]);
  const agent = await createAgent({
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [spawn] } }],
  });
  await agent.run("go");
  const last = provider.requests[3]?.messages.at(-1);
  assert.match(last?.role === "tool" ? (last.results[0]?.output ?? "") : "", /^Blocked by guard: it would delete/);
});

test("guard is required: a subrun whose plugin filter leaves it out still asks before a write (a harmless probe)", async (t) => {
  t.after(await tempHome({ plugins: { guard: fileURLToPath(new URL("..", import.meta.url)) } }));
  const dir = await tempDir(t, "guard-");
  const provider = scripted([
    { toolCalls: [{ id: "w", name: "write", input: { path: join(dir, "probe.txt"), content: "x" } }] },
    { text: "child done" },
  ]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  t.after(() => agent.close());
  for (const plugins of [{ only: ["builtin:write"] }, { disable: ["guard"] }]) {
    const end = await agent.ctxOf("tester").subrun("write it", { plugins }).done;
    const tool = end?.messages.find((m) => m.role === "tool");
    assert.equal(tool?.role === "tool" && tool.results[0]?.output, "Blocked by guard: no one approved the write");
    // the scripted turns again
    provider.requests.length = 0;
  }
  await assert.rejects(readFile(join(dir, "probe.txt")));
});
