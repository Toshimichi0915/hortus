import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { createAgent } from "./agent.ts";
import { codemodeTool, declare } from "./codemode.ts";
import type { Ctx, Plugin, RunInfo, Tool, ToolCtx } from "./llm.ts";
import { fitEffort, tool, toolResult } from "./llm.ts";
import type { LoadOptions, Named } from "./plugins.ts";
import { childDir, newSession, openSession, sessionLineage, sessionsDir } from "./session.ts";
import { scripted, type Turn, tempHome, untimed } from "./testing.ts";
import { bashTool, editTool, readTool, writeTool } from "./tools.ts";

const call = (id: string, name: string, input: unknown = {}) => ({ id, name, input });
const probe = tool({
  name: "probe",
  description: "",
  inputSchema: z.object({ cmd: z.string() }),
  execute: async ({ cmd }, ctx) => `ran ${cmd}${ctx.env?.X ? ` X=${ctx.env.X}` : ""}`,
});
/** A gate (`required` when asked) blocking `probe` calls whose cmd is "danger". */
const gatePlugin = (log: string[] = []): Plugin => ({
  on: {
    tool_gate: (p) => {
      log.push(JSON.stringify(p.call.input));
      if ((p.call.input as { cmd?: string }).cmd === "danger") p.block = "Blocked by gate: danger";
    },
  },
});

async function setup(
  t: { after(fn: () => unknown): void },
  turns: Turn[],
  extra: Named[] = [],
  opts: LoadOptions = {},
) {
  t.after(await tempHome());
  const provider = scripted(turns);
  const agent = await createAgent({
    ...opts,
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [probe] } }, ...extra],
  });
  t.after(() => agent.close());
  return { agent, provider };
}

const results = (end: { messages: readonly unknown[] } | undefined) =>
  (end?.messages ?? []).flatMap((m) =>
    (m as { role: string }).role === "tool" ? (m as { results: unknown[] }).results : [],
  );

test("tool_gate sees the input every tool_call handler (a later one too) left, frozen, and its block is final", async (t) => {
  const log: string[] = [];
  const { agent } = await setup(
    t,
    [{ toolCalls: [call("1", "probe", { cmd: "ok" }), call("2", "probe", { cmd: "fine" })] }, { text: "done" }],
    [
      { name: "gate", plugin: gatePlugin(log) },
      // loaded after the gate: its rewrite still reaches the gate, which runs after every tool_call handler
      {
        name: "rewriter",
        plugin: {
          on: {
            tool_call: (p) => {
              if ((p.call.input as { cmd: string }).cmd === "fine") (p.call.input as { cmd: string }).cmd = "danger";
            },
            tool_gate: (p) => {
              // too late: frozen
              assert.throws(() => {
                (p.call.input as { cmd: string }).cmd = "sneaky";
              }, TypeError);
              p.block = "a later block doesn't replace the first";
            },
          },
        },
      },
    ],
  );
  const end = await agent.run("go");
  assert.deepEqual(log, ['{"cmd":"ok"}', '{"cmd":"danger"}']);
  assert.deepEqual(
    results(end).map((r) => (r as { output: string }).output),
    ["a later block doesn't replace the first", "Blocked by gate: danger"],
  );
});

test("a gate's block replaces a non-error result an earlier tool_call handler supplied (fail closed)", async (t) => {
  const { agent } = await setup(
    t,
    [{ toolCalls: [call("1", "probe", { cmd: "danger" })] }, { text: "done" }],
    [
      {
        name: "cache",
        plugin: {
          on: {
            tool_call: (p) => {
              p.result = { id: p.call.id, output: "cached" };
            },
          },
        },
      },
      { name: "gate", plugin: gatePlugin() },
    ],
  );
  const [r] = results(await agent.run("go")) as { output: string; isError?: boolean }[];
  assert.deepEqual(r, { id: "1", output: "Blocked by gate: danger", isError: true });
});

test("tool_gate's tool is the one that runs: a tool_call handler's rename included", async (t) => {
  const seen: string[] = [];
  const reader = tool({
    name: "reader",
    description: "",
    effects: { reads: ["cmd"] },
    inputSchema: z.object({ cmd: z.string() }),
    execute: async () => "read",
  });
  const { agent } = await setup(
    t,
    [{ toolCalls: [call("1", "reader", { cmd: "danger" })] }, { text: "done" }],
    [
      {
        name: "renamer",
        plugin: {
          tools: [reader],
          on: {
            tool_call: (p) => {
              p.call.name = "probe";
            },
            tool_gate: (p) => {
              seen.push(`${p.call.name}:${p.tool?.name}`);
              if (p.tool?.name === "probe") p.block = "probe blocked";
            },
          },
        },
      },
    ],
  );
  const [r] = results(await agent.run("go")) as { output: string }[];
  assert.deepEqual(seen, ["probe:probe"]);
  assert.equal(r?.output, "probe blocked");
});

test("a throwing tool_gate handler blocks; tool_call's env reaches the gate (frozen) and ToolCtx.env", async (t) => {
  const envs: unknown[] = [];
  const { agent } = await setup(
    t,
    [{ toolCalls: [call("1", "probe", { cmd: "a" }), call("2", "probe", { cmd: "b" })] }, { text: "done" }],
    [
      {
        name: "env",
        plugin: {
          on: {
            tool_call: (p) => {
              p.env = { X: "1" };
            },
          },
        },
      },
      {
        name: "thrower",
        plugin: {
          on: {
            tool_gate: (p) => {
              envs.push(p.env);
              assert.ok(Object.isFrozen(p.env));
              if ((p.call.input as { cmd: string }).cmd === "b") throw new Error("no b");
            },
          },
        },
      },
    ],
  );
  const out = results(await agent.run("go")).map((r) => (r as { output: string }).output);
  assert.deepEqual(out, ["ran a X=1", "Blocked by thrower: no b"]);
  assert.deepEqual(envs, [{ X: "1" }, { X: "1" }]);
});

/** A directory plugin `gate` (manifest `required` as given) whose tool_gate blocks "danger". */
const gateDir = (required: boolean) => ({
  gate: {
    "hortus.json": JSON.stringify({
      name: "gate",
      version: "1.0.0",
      entrypoint: "index.js",
      ...(required && { required }),
    }),
    "index.js": `export default { on: { tool_gate: (p) => { if (p.call.input.cmd === "danger") p.block = "Blocked by gate" } } }`,
  },
});

test("required: a subrun's only/disable filters and LoadOptions.only keep the plugin's gate; disabledPlugins removes it", async () => {
  for (const required of [true, false]) {
    const restore = await tempHome({ plugins: gateDir(required) });
    try {
      const provider = scripted([
        { toolCalls: [call("1", "probe", { cmd: "danger" })] },
        { text: "a" },
        { toolCalls: [call("2", "probe", { cmd: "danger" })] },
        { text: "b" },
        { toolCalls: [call("3", "probe", { cmd: "danger" })] },
        { text: "c" },
      ]);
      const extra: Named[] = [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [probe] } }];
      const agent = await createAgent({ extra });
      const ctx = agent.ctxOf("tester");
      const only = await ctx.subrun("x", { plugins: { only: ["scripted"] } }).done;
      const disabled = await ctx.subrun("y", { plugins: { disable: ["gate"] } }).done;
      await agent.close();
      const flagged = await createAgent({ extra, only: ["scripted"] });
      const top = await flagged.run("z");
      await flagged.close();
      const outs = [only, disabled, top].map((e) => (results(e)[0] as { output: string }).output);
      // without `required`, each filter drops the gate and the probe runs
      assert.deepEqual(
        outs,
        required ? ["Blocked by gate", "Blocked by gate", "Blocked by gate"] : Array(3).fill("ran danger"),
      );
      // the user's own disabling still removes it
      const off = await createAgent({ extra, disabled: ["gate"] });
      assert.ok(!off.ctx.plugins().some((p) => p.name === "gate"));
      await off.close();
    } finally {
      await restore();
    }
  }
});

test("ctx.plugins() lists the plugins taking part; only accepts a `prefix*`", async (t) => {
  const seen: { name: string; builtin: boolean; required: boolean }[][] = [];
  const lister: Plugin = { on: { run_start: (_, ctx) => void seen.push(ctx.plugins()) } };
  const { agent } = await setup(t, [{ text: "a" }, { text: "b" }], [{ name: "lister", plugin: lister }]);
  const all = agent.ctx.plugins();
  assert.deepEqual(
    all.find((p) => p.name === "builtin:read"),
    { name: "builtin:read", builtin: true, required: false },
  );
  assert.deepEqual(
    all.find((p) => p.name === "lister"),
    { name: "lister", builtin: false, required: false },
  );
  await agent.run("a");
  await agent.ctxOf("tester").subrun("x", { plugins: { only: ["builtin:*"] } }).done;
  // lister takes part in the child as a host extra; scripted's tools aren't kept but it is listed (an extra)
  const child = seen[1]?.map((p) => p.name) ?? [];
  assert.ok(child.includes("builtin:bash") && child.includes("lister"));
  assert.equal(seen[0]?.length, all.length);
});

test("a provider wrap gets its plugin's host ctx: the state its handlers use", async (t) => {
  const seen: unknown[] = [];
  const wrapper: Plugin = {
    providers: {
      "*": {
        wrap: (Default, ctx: Ctx) => ({
          ...Default,
          create: (entry, opts) => {
            const p = Default.create(entry, opts);
            return {
              ...p,
              complete: (req, cb, c) => {
                seen.push(ctx.state.route);
                return p.complete(req, cb, c);
              },
            };
          },
        }),
      },
    },
    on: {
      run_start: (_, ctx) => {
        ctx.state.route = `run ${ctx.plugin}`;
      },
    },
  };
  const { agent } = await setup(t, [{ text: "a" }], [{ name: "wrapper", plugin: wrapper }]);
  await agent.run("go");
  assert.deepEqual(seen, ["run wrapper"]);
});

test("ToolCtx.stop() ends the run after its batch; parentId names the calling tool", async (t) => {
  const parents: (string | undefined)[] = [];
  const stopper = tool({
    name: "stopper",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      parents.push(ctx.parentId);
      await ctx.runTool({ id: "", name: "inner", input: {} });
      ctx.stop();
      return "stopping";
    },
  });
  const inner = tool({
    name: "inner",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      parents.push(ctx.parentId);
      return "in";
    },
  });
  const { agent, provider } = await setup(
    t,
    [{ toolCalls: [call("1", "stopper"), call("2", "probe", { cmd: "x" })] }, { text: "never" }],
    [{ name: "s", plugin: { tools: [stopper, inner] } }],
  );
  const end = await agent.run("go");
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(
    results(end).map((r) => (r as { output: string }).output),
    ["stopping", "ran x"],
  );
  assert.deepEqual(parents, [undefined, "1"]);
});

test("execute may return toolResult({ output, value, isError }); outputSchema types codemode's declaration", async (t) => {
  const both = tool({
    name: "both",
    description: "d",
    inputSchema: z.object({}),
    outputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    execute: async () => toolResult({ output: "three", value: { n: 3 } }),
  });
  const bad = tool({
    name: "bad",
    description: "",
    inputSchema: z.object({}),
    execute: async () => toolResult({ output: "nope", isError: true }),
  });
  const { agent } = await setup(t, [], [{ name: "b", plugin: { tools: [both, bad] } }]);
  const r = await agent.ctx.runTool(call("1", "both"));
  assert.deepEqual(untimed(r), { id: "1", output: "three", value: { n: 3 } });
  assert.deepEqual(untimed(await agent.ctx.runTool(call("2", "bad"))), { id: "2", output: "nope", isError: true });
  assert.match(declare([both]), /\): Promise<\{\n {4}n: number;\n {2}\}>;/);
});

test("builtin tools declare their effects", () => {
  assert.deepEqual(
    [readTool, writeTool, editTool, bashTool, codemodeTool].map((t: Tool) => t.effects),
    [
      { reads: ["path"], readOnly: true },
      { writes: ["path"] },
      { reads: ["path"], writes: ["path"] },
      { exec: ["command"] },
      { code: ["code"] },
    ],
  );
});

test("a tool pushed into ctx.tools without a plugin gets the pushing plugin's, and so its ctx.state", async (t) => {
  const mine = tool({
    name: "mine",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => String(ctx.state.marker),
  });
  const pusher: Plugin = {
    on: {
      init: (_, ctx) => {
        ctx.state.marker = "pusher's";
      },
      run_start: (p, ctx) => {
        p.tools.splice(0, Infinity, ...p.tools.filter((x) => x.name !== "mine"));
        // re-added mid-run through ctx.tools, by the constant itself
        ctx.tools.push(mine);
      },
    },
  };
  const { agent } = await setup(
    t,
    [{ toolCalls: [call("1", "mine")] }, { text: "ok" }],
    [{ name: "pusher", plugin: pusher }],
  );
  const [r] = results(await agent.run("go")) as { output: string }[];
  assert.equal(r?.output, "pusher's");
  assert.equal(mine.plugin, "pusher");
});

test("ctx.pending() lists the sends waiting on the session, with their source", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let seen: ReturnType<Ctx["pending"]> = [];
  const { agent } = await setup(t, [
    async () => {
      await held;
      return { text: "a" };
    },
    { text: "b" },
    { text: "c" },
  ]);
  const session = newSession();
  await agent.setSession(session);
  const run = agent.run("go");
  await new Promise((r) => setTimeout(r, 20));
  void agent.ctxOf("other").send("joining", { deliver: "context" });
  void agent.ctx.send("later", { deliver: "after", source: "user" });
  seen = agent.ctx.pending();
  release();
  await run;
  assert.deepEqual(
    seen.map((p) => [p.deliver, p.source, p.message.content]),
    [
      ["context", "other", "joining"],
      ["after", "user", "later"],
    ],
  );
});

test("RunInfo.agent is SubrunOptions.agent; root is the top-level session's id, down the tree", async (t) => {
  const infos: RunInfo[] = [];
  const watcher: Plugin = { on: { run_start: (_, ctx) => void (ctx.run && infos.push(ctx.run)) } };
  const nest = tool({
    name: "nest",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx: ToolCtx) => {
      await ctx.subrun("grand", { agent: "inner" }).done;
      return "ok";
    },
  });
  const { agent } = await setup(
    t,
    [{ text: "top" }, { toolCalls: [call("1", "nest")] }, { text: "grand" }, { text: "child" }],
    [{ name: "w", plugin: { ...watcher, tools: [nest] } }],
  );
  const session = await openSession(null);
  await agent.setSession(session);
  await agent.run("top");
  await agent.ctxOf("tester").subrun("child", { agent: "outer", session: "file" }).done;
  assert.deepEqual(
    infos.map((i) => [i.depth, i.agent, i.root]),
    [
      [0, undefined, session.id],
      [1, "outer", session.id],
      [2, "inner", session.id],
    ],
  );
});

test("sessionLineage and LoadOptions.parent: a child process's runs sit under its parent's session", async (t) => {
  t.after(await tempHome());
  // p-root (top level) > p-child (in p-root's children's dir)
  await mkdir(childDir("p-root"), { recursive: true });
  await writeFile(join(sessionsDir(), "1_p-root.jsonl"), "");
  await writeFile(join(childDir("p-root"), "2_p-child.jsonl"), "");
  assert.deepEqual(await sessionLineage("p-child"), { depth: 1, root: "p-root" });
  assert.deepEqual(await sessionLineage("p-root"), { depth: 0, root: "p-root" });
  assert.deepEqual(await sessionLineage("unknown"), { depth: 0, root: "unknown" });
  let info: RunInfo | undefined;
  const agent = await createAgent({
    parent: "p-child",
    extra: [
      { name: "scripted", plugin: { providers: { scripted: scripted([{ text: "b" }]) } } },
      {
        name: "w",
        plugin: {
          on: {
            run_start: (_, ctx) => {
              info = ctx.run;
            },
          },
        },
      },
    ],
  });
  await agent.run("go", { session: newSession(childDir("p-child")) });
  await agent.close();
  assert.deepEqual([info?.depth, info?.parent, info?.root], [2, { session: "p-child" }, "p-root"]);
});

test("core stamps durationMs on a run tool's result (saved), not on a handler's; images a tool_result handler adds are saved", async (t) => {
  const slow = tool({
    name: "slow",
    description: "",
    inputSchema: z.object({}),
    execute: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return "done";
    },
  });
  const pic: Plugin = {
    tools: [slow],
    on: {
      tool_result: (p) => {
        if (p.call.name === "slow") p.result.images = [{ type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }];
      },
    },
  };
  // a result a tool_call handler supplies never ran: no timing
  const preset: Plugin = {
    on: {
      tool_call: (p) => {
        if (p.call.name === "probe") p.result = { id: p.call.id, output: "cached" };
      },
    },
  };
  const { agent } = await setup(
    t,
    [],
    [
      { name: "pic", plugin: pic },
      { name: "p", plugin: preset },
    ],
  );
  const r = await agent.ctx.runTool(call("1", "slow"));
  assert.ok((r.durationMs ?? 0) >= 25, String(r.durationMs));
  const path = r.images?.[0]?.path;
  assert.ok(path);
  t.after(() => rm(path, { force: true }));
  assert.equal(r.output, `done\n[Image saved to ${path}]`);
  assert.deepEqual(await agent.ctx.runTool(call("2", "probe", { cmd: "x" })), { id: "2", output: "cached" });
});

test("fitEffort: as is when taken, off as the lowest level, a level as the nearest below (else above)", () => {
  assert.equal(fitEffort("high", undefined), "high");
  assert.equal(fitEffort(undefined, ["low"]), undefined);
  assert.equal(fitEffort("off", ["low", "high"]), "low");
  assert.equal(fitEffort("max", ["off", "low", "high"]), "high");
  assert.equal(fitEffort("medium", ["off", "high", "max"]), "high");
  assert.equal(fitEffort("low", ["off"]), "off");
});

test("ctx.complete's effort is fitted to the model's efforts before the request", async (t) => {
  t.after(await tempHome());
  const provider = scripted([{ text: "a" }, { text: "b" }]);
  const agent = await createAgent({
    extra: [
      {
        name: "scripted",
        plugin: {
          providers: {
            scripted: {
              create: (e, o) => ({ ...provider.create(e, o), info: async () => ({ efforts: ["low", "high"] }) }),
            },
          },
        },
      },
    ],
  });
  t.after(() => agent.close());
  await agent.ctx.complete({ messages: [{ role: "user", content: "q" }], effort: "off" });
  await agent.ctx.complete({ messages: [{ role: "user", content: "q" }], effort: "max" });
  assert.deepEqual(
    provider.requests.map((r) => r.effort),
    ["low", "high"],
  );
});
