import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { createAgent } from "./agent.ts";
import type { CodemodeDetails } from "./codemode.ts";
import { loadConfig } from "./config.ts";
import {
  type CompletionRequest,
  type Events,
  type Plugin,
  type ProviderDef,
  type Tool,
  type ToolResult,
  tool,
} from "./llm.ts";
import type { LoadOptions } from "./plugins.ts";
import { record, tempHome } from "./testing.ts";

const add = tool({
  name: "add",
  description: "Adds",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }) => a + b,
});
const fail = tool({
  name: "fail",
  description: "Fails",
  inputSchema: z.object({}),
  execute: async () => {
    throw new Error("boom");
  },
});
/** codemode-only, like an MCP tool; returns structured data */
const hidden = tool({
  name: "hidden",
  description: "Hidden",
  inputSchema: z.object({}),
  exposure: "codemode",
  execute: async () => ({ n: 1 }),
});
const img = { type: "image", mediaType: "image/png", data: "AA==", text: "shot" } as const;
const shot = tool({ name: "shot", description: "", inputSchema: z.object({}), execute: async () => img });

/**
 * An agent whose model calls codemode with the code `run(code)` is given (once per run, then stops), with `add`,
 * `fail`, `hidden` and `shot`, then `plugins`; `run` resolves with the codemode call's result.
 */
async function setup(t: { after: (fn: () => Promise<void>) => void }, plugins: Plugin[] = [], opts: LoadOptions = {}) {
  t.after(await tempHome());
  let input: { code: string; timeout?: number } = { code: "" };
  const requests: CompletionRequest[] = [];
  const provider: ProviderDef = {
    create: () => ({
      complete: async (req) => {
        requests.push(req);
        const call = { id: "c", name: "codemode", input };
        return { role: "assistant", text: "", toolCalls: req.messages.at(-1)?.role === "user" ? [call] : [] };
      },
      listModels: async () => ["scripted"],
    }),
  };
  const rec = record();
  const agent = await createAgent({
    ...opts,
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider }, tools: [add, fail, hidden, shot] } },
      ...plugins.map((plugin, i) => ({ name: `p${i}`, plugin })),
      { name: "rec", plugin: rec },
    ],
  });
  const run = async (code: string, timeout?: number) => {
    input = { code, ...(timeout && { timeout }) };
    const end = await agent.run("go");
    const tool = [...(end?.messages ?? [])].reverse().find((m) => m.role === "tool");
    return (tool?.role === "tool" ? tool.results[0] : undefined) as ToolResult;
  };
  return { agent, run, rec, requests };
}

test("codemode scripts call tools through ctx.runTool: values, images, errors and progress", async (t) => {
  const { run, rec, requests } = await setup(t);
  // declared, as there is a codemode-only tool, listing every other tool in its description
  assert.equal((await run("")).output, "(no output)");
  const declared = requests[0]?.tools.find((t) => t.name === "codemode");
  assert.match(declared?.description ?? "", /add\(input: \{\n {4}a: number;/);
  assert.match(declared?.description ?? "", /hidden\(input/);
  assert.ok(!requests[0]?.tools.some((t) => t.name === "hidden"));

  const out = await run(
    "const [x, y] = await Promise.all([tools.add({a: 1, b: 2}), tools.add({a: 3, b: 4})]);\nconsole.log('hi', {x});\nreturn x + y;",
  );
  assert.equal(out.output, '10\n<console_output>\nhi {\n  "x": 3\n}\n</console_output>');
  // a structured result is the value itself, not its JSON
  assert.equal((await run("const v = await tools.hidden({}); return v.n + 1;")).output, "2");
  // each call's progress reaches the codemode call's details, the last with every call settled
  await run("await tools.add({a: 1, b: 2}); await tools.fail({}).catch(() => {});");
  const updates = rec.events.filter((e) => e.name === "tool_update").map((e) => e.payload as Events["tool_update"]);
  assert.deepEqual(updates.at(-1)?.details, {
    calls: [
      { tool: "add", input: { a: 1, b: 2 }, status: "done" },
      { tool: "fail", input: {}, status: "error" },
    ],
  } satisfies CodemodeDetails);
  const failed = await run("text('before'); await tools.fail({});");
  assert.equal(failed.isError, true);
  assert.match(failed.output, /before\nScript error: boom/);
  assert.match((await run("await tools.add({a: 'x'});")).output, /Script error: Invalid input/);
  assert.match((await run("await new Promise(() => {});", 0.05)).output, /timed out/);
  // a tool's image is a block the script attaches; it was saved once, its text names the file
  const r = await run("image(await tools.shot());");
  const path = r.images?.[0]?.path;
  assert.ok(path);
  assert.equal(r.output, `shot\n[Image saved to ${path}]`);
  assert.equal(readFileSync(path, "base64"), "AA==");
  // every image attached reaches the model
  const two = await run("image(await tools.shot()); image(await tools.shot());");
  assert.equal(two.images?.length, 2);
  for (const p of [path, ...(two.images ?? []).map((i) => i.path)]) if (p) rmSync(p);
});

test("codemode's calls are gated as children of its call; a tool removed in run_start is out of reach", async (t) => {
  const plugin: Plugin = {
    on: {
      run_start: (p) => {
        p.tools = p.tools.filter((t) => t.name !== "fail");
      },
      tool_call: ({ call }) => {
        if (call.name === "add" && (call.input as { a: number }).a === 666) throw new Error("not that");
      },
    },
  };
  const { run, rec, requests } = await setup(t, [plugin]);
  assert.equal((await run("return await tools.add({a: 1, b: 2});")).output, "3");
  const calls = rec.events.filter((e) => e.name === "tool_call").map((e) => (e.payload as Events["tool_call"]).call);
  assert.deepEqual(
    calls.map((c) => [c.id, c.name, c.parentId]),
    [
      ["c", "codemode", undefined],
      ["c/1", "add", "c"],
    ],
  );
  assert.match((await run("await tools.add({a: 666, b: 0});")).output, /Script error: Blocked by p0: not that/);
  assert.equal((await run("return typeof tools.fail;")).output, "undefined");
  assert.doesNotMatch(requests[0]?.tools.find((t) => t.name === "codemode")?.description ?? "", /fail\(/);
});

test("codemode lists codemode-only tools whichever plugin made them; without any, it isn't declared", async (t) => {
  // stands in for an MCP replacement: its tools are codemode-only
  const mine: Tool = { ...hidden, name: "mcp__x__y" };
  const { agent, requests, run } = await setup(t, [], {
    pieces: [{ name: "my-mcp", version: "1.0.0", replaces: ["builtin:mcp"], plugin: { tools: [mine] } }],
  });
  assert.ok(!agent.plugins.some((p) => p.name === "builtin:mcp"));
  assert.equal((await run("return (await tools.mcp__x__y({})).n;")).output, "1");
  assert.match(requests[0]?.tools.find((t) => t.name === "codemode")?.description ?? "", /mcp__x__y\(input/);
});

test("codemode isn't declared without codemode-only tools", async (t) => {
  const { agent, requests } = await setup(t, [
    {
      on: {
        run_start: (p) => {
          p.tools = p.tools.filter((t) => t.exposure !== "codemode");
        },
      },
    },
  ]);
  await agent.run("go");
  assert.ok(!requests[0]?.tools.some((t) => t.name === "codemode"));
  // a model's direct call to it is unknown (and gets no hint)
  const last = requests[1]?.messages.at(-1);
  assert.deepEqual(last?.role === "tool" && last.results, [
    { id: "c", output: "Unknown tool: codemode", isError: true },
  ]);
});

test("config.codemode: false still disables codemode (read as disabledPlugins)", async (t) => {
  t.after(await tempHome({ config: { provider: "scripted", model: "scripted", codemode: false } }));
  assert.deepEqual((await loadConfig()).disabledPlugins, ["builtin:codemode"]);
  const off = await createAgent({ extra: [{ name: "x", plugin: { tools: [hidden] } }] });
  assert.ok(!off.plugins.some((p) => p.name === "builtin:codemode"));
  assert.ok(!off.ctx.tools.some((t) => t.name === "codemode"));
});

test("a codemode script gets a result's output as a tool_result handler left it, not the tool's value", async (t) => {
  const redact: Plugin = {
    on: {
      tool_result: ({ call, result }) => {
        if (call.name === "hidden") result.output = "[redacted]";
      },
    },
  };
  const { run } = await setup(t, [redact]);
  assert.equal((await run("return await tools.hidden({});")).output, "[redacted]");
});

test("with codemode removed in run_start, codemode-only tools are declared directly", async (t) => {
  const plugin: Plugin = {
    on: {
      run_start: (p) => {
        p.tools = p.tools.filter((t) => t.name !== "codemode");
      },
    },
  };
  const { agent, requests } = await setup(t, [plugin]);
  await agent.run("go");
  const names = requests[0]?.tools.map((t) => t.name) ?? [];
  assert.ok(names.includes("hidden"));
  assert.ok(!names.includes("codemode"));
});
