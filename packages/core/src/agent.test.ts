import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { createAgent } from "./agent.ts";
import { saveConfig } from "./config.ts";
import {
  type CreateOptions,
  type Events,
  type Message,
  type ProviderDef,
  type ProviderWrap,
  stateOf,
  tool,
} from "./llm.ts";
import { loadSecrets, saveSecrets, updateSecret } from "./secrets.ts";
import { openSession } from "./session.ts";
import { record, scripted, tempHome, untimed } from "./testing.ts";

const progress = tool({
  name: "progress",
  description: "",
  inputSchema: z.object({ fail: z.boolean() }),
  execute: async ({ fail }, ctx) => {
    ctx.update({ done: 1 });
    ctx.update({ done: 2 });
    if (fail) throw new Error("boom");
    return "ok";
  },
});

test("a tool's updates reach tool_update in order, and the last one is the result's details (even uncloneable, never sent), even when it throws", async (t) => {
  t.after(await tempHome());
  const plain = tool({ name: "plain", description: "", inputSchema: z.object({}), execute: async () => "x" });
  const cancel = () => {};
  const fn = tool({
    name: "fn",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      ctx.update({ cancel });
      return "y";
    },
  });
  const provider = scripted([
    {
      toolCalls: [
        { id: "1", name: "progress", input: { fail: false } },
        { id: "2", name: "progress", input: { fail: true } },
        { id: "3", name: "plain", input: {} },
        { id: "4", name: "fn", input: {} },
      ],
    },
    {},
  ]);
  const rec = record();
  const agent = await createAgent({
    extra: [
      { name: "t", plugin: { providers: { scripted: provider }, tools: [progress, plain, fn] } },
      { name: "rec", plugin: rec },
    ],
  });
  const end = await agent.run("hi");
  assert.deepEqual(
    rec.events
      .filter((e) => e.name === "tool_update" && (e.payload as Events["tool_update"]).call.id === "1")
      .map((e) => e.payload),
    [
      { call: { id: "1", name: "progress", input: { fail: false } }, details: { done: 1 } },
      { call: { id: "1", name: "progress", input: { fail: false } }, details: { done: 2 } },
    ],
  );
  const { entryId, ...saved } = end?.messages.at(-2) ?? {};
  assert.ok(entryId);
  assert.deepEqual(untimed(saved), {
    role: "tool",
    results: [
      { id: "1", output: "ok", details: { done: 2 } },
      { id: "2", output: "boom", isError: true, details: { done: 2 } },
      // a tool that never updates has no details key at all, so saved results don't change
      { id: "3", output: "x" },
      { id: "4", output: "y", details: { cancel } },
    ],
  });
  // details aren't sent, so a function in them (which can't be cloned) doesn't break the next request
  assert.deepEqual(provider.requests[1]?.messages.at(-1), {
    role: "tool",
    results: [
      { id: "1", output: "ok" },
      { id: "2", output: "boom", isError: true },
      { id: "3", output: "x" },
      { id: "4", output: "y" },
    ],
  });
});

test("a whole run: the model calls read, gets the result in its next request, then answers", async (t) => {
  t.after(await tempHome());
  const file = join(homedir(), "note.txt");
  await writeFile(file, "hello");
  const provider = scripted([
    { text: "Reading.", toolCalls: [{ id: "c1", name: "read", input: { path: file } }] },
    (req) => ({ text: `It says ${(req.messages.at(-1) as Extract<Message, { role: "tool" }>).results[0]?.output}` }),
  ]);
  const rec = record();
  const agent = await createAgent({
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider } } },
      { name: "record", plugin: rec },
    ],
  });
  await agent.run("what's in note.txt?");

  const toolMessage: Message = { role: "tool", results: [{ id: "c1", output: "hello" }] };
  assert.deepEqual(
    rec.events
      .filter((e) => e.name === "message")
      .map((e) => {
        const { entryId: _, ...m } = e.payload as Message;
        return untimed(m);
      }),
    [
      { role: "user", content: "what's in note.txt?" },
      { role: "assistant", text: "Reading.", toolCalls: [{ id: "c1", name: "read", input: { path: file } }] },
      toolMessage,
      { role: "assistant", text: "It says hello", toolCalls: [] },
    ],
  );
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(provider.requests[1]?.messages.at(-1), toolMessage);
  assert.deepEqual(
    // mcp_servers: builtin:mcp's, from init in the background
    rec.events.map((e) => e.name).filter((n) => n !== "mcp_servers"),
    [
      ...["init", "ready", "input", "message", "skills", "run_start", "prompt"],
      ...[
        "turn_start",
        "request",
        "text",
        "response",
        "message",
        "tool_call",
        "tool_gate",
        "tool_result",
        "message",
        "turn_end",
      ],
      ...["turn_start", "request", "text", "response", "message", "turn_end"],
      ...["run_end", "idle"],
    ],
  );
});

test("tempHome leaves the real ~/.hortus untouched", async (t) => {
  const real = join(homedir(), ".hortus");
  // the dir and each entry: writing a file changes its mtime, adding or removing one the dir's
  const mtimes = async () => {
    const names = await readdir(real).catch(() => []);
    return Promise.all(
      ["", ...names].map((n) =>
        stat(join(real, n)).then(
          (s) => s.mtimeMs,
          () => undefined,
        ),
      ),
    );
  };
  const before = await mtimes();
  const cleanup = await tempHome();
  t.after(cleanup);
  await saveConfig({ provider: "x", model: "y" });
  await saveSecrets({ x: { type: "scripted", apiKey: "k" } });
  await (await openSession(null)).append([{ role: "user", content: "hi" }]);
  await cleanup();
  assert.deepEqual(await mtimes(), before);
});

test("createAgent loads a plugin dir written by tempHome", async (t) => {
  t.after(
    await tempHome({
      plugins: {
        hello: {
          "hortus.json": JSON.stringify({ name: "hello", version: "1.0.0", entrypoint: "index.js" }),
          "index.js": `export default { on: { prompt: (p) => { p.system.push("hello from a plugin") } } }`,
        },
      },
    }),
  );
  const provider = scripted([{ text: "hi" }]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  await agent.run("hi");
  assert.match(provider.requests[0]?.system ?? "", /hello from a plugin$/);
});

const withScripted = (provider: ProviderDef) => [{ name: "scripted", plugin: { providers: { scripted: provider } } }];

test("disabledPlugins: builtin:edit leaves out the edit tool and every mention of it, and the agent still runs", async (t) => {
  t.after(await tempHome({ config: { provider: "scripted", model: "scripted", disabledPlugins: ["builtin:edit"] } }));
  // outside this repository, whose AGENTS.md (read from the cwd) mentions edit
  const cwd = process.cwd();
  process.chdir(homedir());
  t.after(() => process.chdir(cwd));
  const provider = scripted([{ text: "hi" }]);
  const agent = await createAgent({ extra: withScripted(provider) });
  assert.ok(!agent.plugins.some((p) => p.name === "builtin:edit"));
  await agent.run("hi");
  const [req] = provider.requests;
  assert.deepEqual(
    req?.tools.map((t) => t.name),
    ["read", "write", "bash"],
  );
  assert.doesNotMatch(req?.system ?? "", /edit/i);
});

test("a plain duplicate tool and provider are reported once each, the earlier kept, and the agent loads and runs", async (t) => {
  t.after(await tempHome());
  const provider = scripted([{ text: "hi" }]);
  const read = tool({ name: "read", description: "dup", inputSchema: z.object({}), execute: async () => "" });
  const errors: string[] = [];
  const agent = await createAgent({
    extra: [
      ...withScripted(provider),
      { name: "dup", plugin: { tools: [read], providers: { scripted: scripted([]) } } },
    ],
    onError: (plugin, e) => errors.push(`${plugin}: ${e.message}`),
  });
  assert.deepEqual(errors, [
    "dup: Plugin dup provides provider scripted, which scripted already does; wrap it, or replace scripted",
    "dup: Plugin dup provides tool read, which builtin:read already does; wrap it, or replace builtin:read",
  ]);
  await agent.run("hi");
  // the run went to the first scripted provider, with builtin:read's read
  assert.notEqual(provider.requests[0]?.tools.find((t) => t.name === "read")?.description, "dup");
});

test("secrets keep unknown fields, take entries without apiKey and expand env vars only when read through the agent", async (t) => {
  t.after(await tempHome());
  process.env.HORTUS_TEST_KEY = "from-env";
  t.after(() => delete process.env.HORTUS_TEST_KEY);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: secrets.json's ${VAR} syntax
  const ref = "${HORTUS_TEST_KEY}";
  const secrets = {
    scripted: { type: "scripted", apiKey: ref },
    oauth: { type: "anthropic", refreshToken: "r", expires: 5, nested: { a: [1] } },
    // a type no provider has: a plugin's credential
    brave: { type: "brave", apiKey: ref, headers: { "x-team": ref }, list: [ref, 1] },
  };
  await saveSecrets(secrets);
  assert.deepEqual(await loadSecrets(), secrets);
  assert.equal(await updateSecret("oauth", (e) => e && { ...e, expires: 6 }).then((e) => e?.expires), 6);
  assert.deepEqual((await loadSecrets()).oauth, { ...secrets.oauth, expires: 6 });
  const agent = await createAgent({ extra: withScripted(scripted([])) });
  assert.deepEqual(await agent.ctx.secrets.get("scripted"), { type: "scripted", apiKey: "from-env" });
  // stored as written
  assert.equal((await loadSecrets()).scripted?.apiKey, ref);
  // nested strings expand too; find lists a type's entries
  assert.deepEqual(await agent.ctx.secrets.find("brave"), [
    {
      name: "brave",
      entry: { type: "brave", apiKey: "from-env", headers: { "x-team": "from-env" }, list: ["from-env", 1] },
    },
  ]);
  assert.deepEqual(await agent.ctx.secrets.find("nothing"), []);
  // listing models skips the plugin credential
  assert.deepEqual(await agent.listModels(), [{ provider: "scripted", id: "scripted" }]);
});

test("LoadOptions.fetch reaches create, auth, tools and agent.ctx.fetch; CreateOptions.auth and ctx.secrets refresh through auth", async (t) => {
  t.after(await tempHome({ secrets: { s: { type: "scripted", apiKey: "old", expires: 0 } } }));
  const fetch = async () => new Response("stub");
  const fetches: unknown[] = [];
  let refreshes = 0;
  let opts: CreateOptions | undefined;
  const base = scripted([{ toolCalls: [{ id: "1", name: "probe", input: {} }] }, { text: "done" }]);
  const provider: ProviderDef = {
    create: (entry, o) => {
      opts = o;
      return base.create(entry, o);
    },
    auth: async (entry, { refresh, fetch }) => {
      fetches.push(fetch);
      return refresh || (entry.expires as number) < Date.now()
        ? { ...entry, apiKey: `fresh${++refreshes}`, expires: Date.now() + 60_000 }
        : entry;
    },
  };
  const probe = tool({
    name: "probe",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      fetches.push(ctx.fetch);
      // a tool reusing a login: through its owner's auth
      return (await ctx.secrets.get("s", { refresh: true }))?.apiKey;
    },
  });
  const agent = await createAgent({
    fetch,
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider }, tools: [probe] } }],
  });
  assert.equal(agent.ctx.fetch, fetch);
  await agent.run("hi", { provider: "s", model: "m" });
  assert.equal(opts?.fetch, fetch);
  const result = base.requests[1]?.messages.at(-1) as Extract<Message, { role: "tool" }>;
  assert.equal(result.results[0]?.output, "fresh2");
  // a token expiring mid-run: the provider (in its fetch) re-reads it through the same auth, which saves it
  await agent.ctx.secrets.update("s", (e) => e && { ...e, expires: 0 });
  assert.equal((await opts?.auth?.())?.apiKey, "fresh3");
  assert.equal((await loadSecrets()).s?.apiKey, "fresh3");
  assert.deepEqual(fetches, [fetch, fetch, fetch, fetch]);
});

test('a routing provider delegates through CreateOptions.providers (wrapped, but not by "*" again) with its maxOutput', async (t) => {
  t.after(await tempHome({ secrets: { r: { type: "router" } } }));
  const inner = scripted([{ text: "hi" }, { text: "again" }]);
  let infos = 0;
  const created: string[] = [];
  const trace = (label: string): ProviderWrap => ({
    wrap: (Default) => ({
      ...Default,
      create: (entry, opts) => {
        created.push(`${label} ${entry.type}`);
        return Default.create(entry, opts);
      },
    }),
  });
  const router: ProviderDef = {
    create: (_, opts) => {
      const p = opts.providers?.inner?.create({ type: "inner" }, { name: opts.name });
      assert.ok(p);
      return { ...p, info: async () => ({ maxOutput: 77 + infos++ }) };
    },
  };
  const agent = await createAgent({
    extra: [
      { name: "providers", plugin: { providers: { inner, router } } },
      { name: "wrap", plugin: { providers: { inner: trace("wrap") } } },
      { name: "star", plugin: { providers: { "*": trace("*") } } },
    ],
  });
  await agent.run("hi", { provider: "r", model: "m" });
  assert.deepEqual(created, ["* router", "wrap inner"]);
  assert.equal(inner.requests[0]?.maxTokens, 77);
  // info is asked once per provider and model, not every run
  await agent.run("hi", { provider: "r", model: "m" });
  assert.equal(infos, 1);
  assert.equal(inner.requests[1]?.maxTokens, 77);
});

test("secrets.get(name, { refresh }) and provider calls go through the provider's auth, which is saved", async (t) => {
  t.after(await tempHome({ secrets: { s: { type: "scripted", apiKey: "old", expires: 0 } } }));
  const calls: boolean[] = [];
  const created: unknown[] = [];
  const base = scripted([{ text: "hi" }]);
  const provider: ProviderDef = {
    create: (entry, opts) => {
      created.push(entry.apiKey);
      return base.create(entry, opts);
    },
    auth: async (entry, { refresh }) => {
      calls.push(refresh);
      return refresh || (entry.expires as number) < Date.now()
        ? { ...entry, apiKey: `fresh${calls.length}`, expires: Date.now() + 60_000 }
        : entry;
    },
  };
  const agent = await createAgent({ extra: withScripted(provider) });
  const path = join(homedir(), ".hortus", "secrets.json");
  assert.equal((await agent.ctx.secrets.get("s", { refresh: true }))?.apiKey, "fresh1");
  assert.equal((await loadSecrets()).s?.apiKey, "fresh1");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  // expired again: the run's provider call refreshes it first
  await updateSecret("s", (e) => e && { ...e, expires: 0 });
  await agent.run("hi", { provider: "s", model: "m" });
  assert.deepEqual(calls, [true, false]);
  assert.deepEqual(created, ["fresh2"]);
  assert.equal((await loadSecrets()).s?.apiKey, "fresh2");
});

test("two processes updating different secrets at once both keep their changes", async (t) => {
  t.after(await tempHome({ secrets: {} }));
  const script = `
    import { updateSecret } from ${JSON.stringify(new URL("./secrets.js", import.meta.url).href)};
    const name = process.argv[1];
    for (let i = 0; i < 25; i++) await updateSecret(name, (e) => ({ type: "x", n: ((e && e.n) || 0) + 1 }));
  `;
  const run = (name: string) =>
    new Promise<void>((resolve, reject) =>
      execFile(process.execPath, ["--input-type=module", "-e", script, name], { env: process.env }, (e) =>
        e ? reject(e) : resolve(),
      ),
    );
  await Promise.all([run("a"), run("b")]);
  const saved = JSON.parse(await readFile(join(homedir(), ".hortus", "secrets.json"), "utf8"));
  assert.deepEqual(saved, { a: { type: "x", n: 25 }, b: { type: "x", n: 25 } });
});

test("a wrapper's Usage.cost is kept on the message", async (t) => {
  t.after(await tempHome());
  const provider = scripted([{ text: "hi", usage: { input: 10, output: 2, cacheRead: 0 } }]);
  const pricing: ProviderWrap = {
    wrap: (Default) => ({
      ...Default,
      create: (entry, opts) => {
        const p = Default.create(entry, opts);
        return {
          ...p,
          complete: async (...args) => {
            const m = await p.complete(...args);
            return { ...m, usage: m.usage && { ...m.usage, cost: m.usage.input * 0.001 } };
          },
        };
      },
    }),
  };
  const rec = record();
  const agent = await createAgent({
    extra: [
      ...withScripted(provider),
      { name: "pricing", plugin: { providers: { "*": pricing } } },
      { name: "rec", plugin: rec },
    ],
  });
  await agent.run("hi");
  const message = rec.events.find((e) => e.name === "message" && (e.payload as Message).role === "assistant")
    ?.payload as Extract<Message, { role: "assistant" }>;
  assert.equal(message.usage?.cost, 0.01);
});

test("the loop knows no features: agent.ts names none of MCP, codemode, skills, AGENTS.md or compaction", async () => {
  const source = await readFile(new URL("../src/agent.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /mcp|codemode|skill|agents\.md|compact/i);
});

test("a command whose enabled(ctx) is false is left out of agent.commands() (an earlier same-named one shows) and won't run", async (t) => {
  t.after(await tempHome());
  let on = false;
  const agent = await createAgent({
    extra: [
      { name: "a", plugin: { commands: [{ name: "x", description: "a's", run: () => "a" }] } },
      {
        name: "b",
        plugin: {
          commands: [{ name: "x", description: "b's", enabled: (ctx) => on && ctx.plugin === "b", run: () => "b" }],
        },
      },
    ],
  });
  const x = () => agent.commands().find((c) => c.name === "x");
  assert.equal(await x()?.run(""), "a");
  on = true;
  const b = x();
  assert.equal(await b?.run(""), "b");
  on = false;
  await assert.rejects(async () => b?.run(""), /turned off/);
});

test("a plugin whose commands(ctx) or enabled(ctx) throws is skipped and reported once, not thrown", async (t) => {
  t.after(await tempHome());
  const errors: string[] = [];
  const agent = await createAgent({
    onError: (plugin, e) => void errors.push(`${plugin}: ${e.message}`),
    extra: [
      {
        name: "bad",
        plugin: {
          commands: () => {
            throw new Error("boom");
          },
        },
      },
      {
        name: "half",
        plugin: {
          commands: [
            {
              name: "off",
              description: "",
              enabled: () => {
                throw new Error("nope");
              },
              run: () => "",
            },
            { name: "ok", description: "", run: () => "ok" },
          ],
        },
      },
    ],
  });
  for (let i = 0; i < 3; i++) {
    const names = agent.commands().map((c) => c.name);
    assert.ok(names.includes("ok") && !names.includes("off"));
  }
  assert.deepEqual(errors, [
    "bad: Plugin bad's commands failed: boom",
    "half: Plugin half's /off enabled() failed: nope",
  ]);
});

test("stateOf makes ctx.state[key] once, per plugin", async (t) => {
  t.after(await tempHome());
  const agent = await createAgent();
  const a = stateOf(agent.ctxOf("p"), "k", () => ({ n: 1 }));
  a.n++;
  assert.equal(stateOf(agent.ctxOf("p"), "k", () => ({ n: 0 })).n, 2);
  assert.equal(stateOf(agent.ctxOf("q"), "k", () => ({ n: 0 })).n, 0);
});
