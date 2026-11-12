import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { type Ctx, type Plugin, type Provider, type ProviderDef, type Tool, tool } from "./llm.ts";
import { loadPlugins, mergePlugins, type Piece, sortManifests } from "./plugins.ts";
import { tempDir, toolCtx } from "./testing.ts";

async function writePlugin(dir: string, manifest: object, source: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "hortus.json"), JSON.stringify(manifest));
  await writeFile(join(dir, "index.mjs"), source);
}

const BUILTINS = [
  "builtin:prompt",
  "builtin:read",
  "builtin:skills",
  "builtin:write",
  "builtin:edit",
  "builtin:bash",
  "builtin:anthropic",
  "builtin:openai",
  "builtin:mcp",
  "builtin:codemode",
  "builtin:compaction",
  "builtin:name",
];

test("the default load is exactly the built-in pieces, in dependency order", async (t) => {
  const { plugins, providers, tools } = await loadPlugins(await tempDir(t));
  assert.deepEqual(
    plugins.map((p) => p.name),
    BUILTINS,
  );
  assert.deepEqual(Object.keys(providers), ["anthropic", "openai", "openai-responses"]);
  assert.deepEqual(
    tools.map((t) => t.name),
    ["read", "write", "edit", "bash", "codemode"],
  );
});

test("loadPlugins loads directory plugins after the built-ins, dependencies first, then extra", async (t) => {
  const dir = await tempDir(t);
  // "a" sorts first but depends on "b", so "b" loads first and "a" wraps b's wrap of read
  await writePlugin(
    join(dir, "a"),
    {
      name: "a",
      version: "1.0.0",
      entrypoint: "index.mjs",
      dependencies: { b: "^1.0.0" },
      optionalDependencies: { missing: "*" },
    },
    `export default {
      providers: { fake: { create: () => ({}) } },
      tools: [{ name: "read", wrap: (d) => ({ ...d, description: d.description + " a" }) }],
      on: { prompt: ({ system }) => { system.push("from a"); } },
    };`,
  );
  await writePlugin(
    join(dir, "b"),
    { name: "b", version: "1.0.0", entrypoint: "index.mjs" },
    `export default {
      tools: [{ name: "read", wrap: (d) => ({ ...d, description: "b" }) }],
      on: { prompt: ({ system }) => { system.push("from b"); } },
    };`,
  );
  await mkdir(join(dir, "not-a-plugin"));
  const extra = {
    name: "extra",
    plugin: { on: { prompt: (s: { system: string[] }) => void s.system.push("extra") } } satisfies Plugin,
  };
  const { providers, tools, plugins } = await loadPlugins(dir, { extra: [extra] });
  const start = { system: [] as string[], tools: [], skills: [], context: [] };
  // as the agent emits it: every plugin's handler, in load order
  for (const { plugin } of plugins) await plugin.on?.prompt?.(start, {} as Ctx);
  assert.deepEqual(start.system.slice(-3), ["from b", "from a", "extra"]);
  assert.match(start.system[0] ?? "", /coding agent/);
  assert.deepEqual(Object.keys(providers), ["anthropic", "openai", "openai-responses", "fake"]);
  assert.equal(tools.filter((t) => t.name === "read").length, 1);
  assert.equal(tools.find((t) => t.name === "read")?.description, "b a");
  assert.deepEqual(
    plugins.map((p) => p.name),
    [...BUILTINS, "b", "a", "extra"],
  );

  await writePlugin(join(dir, "c"), { name: "c", version: "1.0.0", entrypoint: "nope.mjs" }, "");
  await assert.rejects(loadPlugins(dir), /Failed to load plugin c/);
  await writePlugin(join(dir, "c"), { name: "c", version: "1.0", entrypoint: "index.mjs" }, "");
  await assert.rejects(loadPlugins(dir), /Invalid .*hortus\.json: .*invalid semver version/s);
});

test("a disabled piece isn't loaded; one a required dependency needs fails the load, naming both", async (t) => {
  const dir = await tempDir(t);
  const names = async (disabled: string[]) => (await loadPlugins(dir, { disabled })).plugins.map((p) => p.name);
  assert.deepEqual(
    await names(["builtin:edit"]),
    BUILTINS.filter((n) => n !== "builtin:edit"),
  );
  await assert.rejects(names(["builtin:read"]), /builtin:skills requires builtin:read, which disabledPlugins disables/);
  assert.deepEqual(
    await names(["builtin:read", "builtin:skills"]),
    BUILTINS.filter((n) => n !== "builtin:read" && n !== "builtin:skills"),
  );
  // an optional dependency on a disabled plugin is skipped
  const opt = { name: "opt", version: "1.0.0", optionalDependencies: { "builtin:bash": "*" }, plugin: {} };
  assert.deepEqual((await loadPlugins(dir, { pieces: [opt], disabled: ["builtin:bash"] })).plugins.at(-1)?.name, "opt");
  // every piece can go: the rest loads, or the load names the piece needing it
  for (const name of BUILTINS) {
    const rest = await names([name]).catch((e: Error) => e.message);
    if (typeof rest === "string") assert.match(rest, new RegExp(`requires ${name}, which disabledPlugins disables`));
    else
      assert.deepEqual(
        rest,
        BUILTINS.filter((n) => n !== name),
      );
  }
});

test("a replacer stands in for the plugin it replaces, dependencies included; two replacers fail the load", async (t) => {
  const dir = await tempDir(t);
  const read = tool({ name: "read", description: "mine", inputSchema: z.object({}), execute: async () => "" });
  await writePlugin(
    join(dir, "my-read"),
    { name: "my-read", version: "3.0.0", entrypoint: "index.mjs", replaces: ["builtin:read", "absent"] },
    `export default { tools: [{ name: "read", description: "mine", inputSchema: null, execute: async () => "" }] };`,
  );
  const { plugins, tools } = await loadPlugins(dir);
  const names = plugins.map((p) => p.name);
  assert.ok(!names.includes("builtin:read"));
  // builtin:skills depends on builtin:read: satisfied by my-read, which loads before it
  assert.ok(names.indexOf("my-read") < names.indexOf("builtin:skills"));
  assert.equal(tools.find((t) => t.name === "read")?.description, "mine");

  const other: Piece = { name: "other", version: "1.0.0", replaces: ["builtin:read"], plugin: { tools: [read] } };
  await assert.rejects(
    loadPlugins(dir, { pieces: [other] }),
    /Plugins other and my-read both replace builtin:read; disable one of them with disabledPlugins/,
  );
});

test("a replacer of a replacer stands in for both: only it loads, and it lists both as what it replaces", async (t) => {
  const read = (description: string) =>
    tool({ name: "read", description, inputSchema: z.object({}), execute: async () => "" });
  const mine: Piece = {
    name: "my-read",
    version: "1.0.0",
    replaces: ["builtin:read"],
    plugin: { tools: [read("mine")] },
  };
  const better: Piece = {
    name: "better-read",
    version: "1.0.0",
    replaces: ["my-read"],
    plugin: { tools: [read("b")] },
  };
  // no onError: my-read loading too would make better-read's read a conflict, which throws
  const { plugins, tools } = await loadPlugins(await tempDir(t), { pieces: [mine, better] });
  const names = plugins.map((p) => p.name);
  assert.ok(!names.includes("builtin:read") && !names.includes("my-read"));
  assert.ok(names.indexOf("better-read") < names.indexOf("builtin:skills"));
  assert.equal(tools.find((t) => t.name === "read")?.description, "b");
  assert.deepEqual(plugins.find((p) => p.name === "better-read")?.replaces, ["builtin:read", "my-read"]);
  assert.equal(plugins.find((p) => p.name === "builtin:skills")?.replaces, undefined);
  // replacing builtin:read as well isn't a second replacer: my-read, the other one, is replaced
  const both = { ...better, replaces: ["my-read", "builtin:read"] };
  const again = await loadPlugins(await tempDir(t), { pieces: [mine, both] });
  assert.equal(again.tools.find((t) => t.name === "read")?.description, "b");

  // a replacer of a required plugin is required too, along the chain
  const strict = await loadPlugins(await tempDir(t), { pieces: [{ ...mine, required: true }, better] });
  assert.equal(strict.plugins.find((p) => p.name === "better-read")?.required, true);
  assert.equal(plugins.find((p) => p.name === "better-read")?.required, undefined);

  const m = (name: string, replaces: string[]) => ({ name, version: "1.0.0", replaces, plugin: {} });
  assert.throws(() => sortManifests([m("a", ["b"]), m("b", ["a"])]), /Plugin replacement cycle: b -> a -> b/);
});

test("mergePlugins merges a subset anew: a left-out wrapper's wrap is gone, a wrap of a left-out tool is reported", async (t) => {
  const restyle: Plugin = {
    tools: [{ name: "read", wrap: (Default): Tool => ({ ...Default, description: "styled" }) }],
  };
  const { plugins, tools } = await loadPlugins(await tempDir(t), { extra: [{ name: "restyle", plugin: restyle }] });
  const read = (ts: Tool[]) => ts.find((t) => t.name === "read")?.description;
  assert.equal(read(tools), "styled");
  assert.notEqual(read(mergePlugins(plugins.filter((p) => p.name !== "restyle")).tools), "styled");
  const errors: string[] = [];
  const rest = mergePlugins(
    plugins.filter((p) => p.name !== "builtin:read"),
    (plugin) => errors.push(plugin),
  );
  assert.equal(read(rest.tools), undefined);
  assert.deepEqual(errors, ["restyle"]);
  // an optional wrap of nothing is skipped silently, a tool's and a provider's
  const optional: Plugin = {
    tools: [{ name: "read", optional: true, wrap: (Default): Tool => ({ ...Default, description: "styled" }) }],
    providers: { nope: { optional: true, wrap: (d) => d } },
  };
  const quiet = mergePlugins([
    ...plugins.filter((p) => !["builtin:read", "restyle"].includes(p.name)),
    { name: "o", plugin: optional },
  ]);
  assert.equal(read(quiet.tools), undefined);
  assert.equal(quiet.providers.nope, undefined);
});

test("a duplicate of a wrapped tool is told to replace the plugin that provides it, not the wrapper", async (t) => {
  const restyle: Plugin = { tools: [{ name: "read", wrap: (Default): Tool => ({ ...Default }) }] };
  const plain: Plugin = {
    tools: [tool({ name: "read", description: "", inputSchema: z.object({}), execute: async () => "" })],
  };
  const errors: string[] = [];
  await loadPlugins(await tempDir(t), {
    extra: [
      { name: "restyle", plugin: restyle },
      { name: "plain", plugin: plain },
    ],
    onError: (_, e) => errors.push(e.message),
  });
  assert.deepEqual(errors, [
    "Plugin plain provides tool read, which builtin:read already does; wrap it, or replace builtin:read",
  ]);
});

test("a plain duplicate tool or provider is reported once each and skipped, keeping the earlier one", async (t) => {
  const errors: [string, string][] = [];
  const dup = (description: string): Plugin => ({
    tools: [tool({ name: "dup", description, inputSchema: z.object({}), execute: async () => "" })],
    providers: { anthropic: { create: () => ({}) as Provider } },
  });
  const { tools, providers } = await loadPlugins(await tempDir(t), {
    extra: [
      { name: "first", plugin: { tools: dup("first").tools } },
      { name: "second", plugin: dup("second") },
    ],
    onError: (plugin, e) => errors.push([plugin, e.message]),
  });
  assert.deepEqual(errors, [
    [
      "second",
      "Plugin second provides provider anthropic, which builtin:anthropic already does; wrap it, or replace builtin:anthropic",
    ],
    ["second", "Plugin second provides tool dup, which first already does; wrap it, or replace first"],
  ]);
  assert.equal(tools.find((t) => t.name === "dup")?.description, "first");
  assert.equal(typeof providers.anthropic?.create({ type: "anthropic", apiKey: "k" }, { name: "a" }).info, "function");
  // without onError, the load fails
  await assert.rejects(
    loadPlugins(await tempDir(t), { extra: [{ name: "second", plugin: dup("second") }] }),
    /second provides/,
  );
});

test("wraps layer in load order over the built-in, for providers and tools", async (t) => {
  const log: string[] = [];
  const wrapProvider = (n: string): Plugin => ({
    providers: {
      anthropic: {
        wrap: (Default) => ({
          create: (entry, opts) => {
            log.push(n);
            return Default.create(entry, opts);
          },
        }),
      },
    },
  });
  const wrapTool = (n: string): Plugin => ({
    tools: [
      {
        name: "read",
        wrap: (Default): Tool => ({
          ...Default,
          execute: async (input, ctx) => `${n}(${await Default.execute(input, ctx)})`,
        }),
      },
    ],
  });
  const { providers, tools } = await loadPlugins(await tempDir(t), {
    extra: [
      { name: "inner", plugin: { ...wrapProvider("inner"), ...wrapTool("inner") } },
      { name: "outer", plugin: { ...wrapProvider("outer"), ...wrapTool("outer") } },
    ],
  });
  const provider = providers.anthropic?.create({ type: "anthropic", apiKey: "k" }, { name: "a" });
  assert.deepEqual(log, ["outer", "inner"]);
  // the built-in's
  assert.equal(typeof provider?.info, "function");
  const dir = await tempDir(t);
  await writeFile(join(dir, "f.txt"), "text");
  const read = tools.find((t) => t.name === "read");
  assert.equal(await read?.execute({ path: join(dir, "f.txt") } as never, toolCtx()), "outer(inner(text))");
  // a wrap of nothing is reported
  const errors: string[] = [];
  await loadPlugins(dir, {
    extra: [{ name: "w", plugin: { tools: [{ name: "nothing", wrap: (d) => d }] } }],
    onError: (_, e) => errors.push(e.message),
  });
  assert.deepEqual(errors, ["Plugin w wraps tool nothing, which no earlier plugin provides"]);
});

test('a "*" provider wrap wraps every type, those of later plugins too, outermost', async (t) => {
  const log: string[] = [];
  const def = (n: string, Default?: ProviderDef): ProviderDef => ({
    create: (entry, opts) => {
      log.push(n);
      return Default ? Default.create(entry, opts) : ({} as Provider);
    },
  });
  const { providers } = await loadPlugins(await tempDir(t), {
    extra: [
      { name: "star", plugin: { providers: { "*": { wrap: (d) => def("star", d) } } } },
      { name: "base", plugin: { providers: { later: def("base") } } },
      { name: "wrapper", plugin: { providers: { later: { wrap: (d) => def("wrapper", d) } } } },
    ],
  });
  providers.later?.create({ type: "later" }, { name: "later" });
  assert.deepEqual(log, ["star", "wrapper", "base"]);
  log.length = 0;
  providers.openai?.create({ type: "openai", apiKey: "k" }, { name: "o" });
  assert.deepEqual(log, ["star"]);
});

test("sortManifests checks version ranges and rejects missing dependencies, cycles and duplicates", () => {
  const m = (name: string, dependencies?: Record<string, string>, optionalDependencies?: Record<string, string>) => ({
    name,
    version: "1.2.0",
    entrypoint: "x",
    dependencies,
    optionalDependencies,
    dir: name,
  });
  assert.throws(() => sortManifests([m("a", { b: "^1.0.0" })]), /a requires missing plugin b@\^1\.0\.0/);
  assert.throws(() => sortManifests([m("a", { b: "^2.0.0" }), m("b")]), /a requires b@\^2\.0\.0, found 1\.2\.0/);
  assert.throws(() => sortManifests([m("a", {}, { b: "~1.1.0" }), m("b")]), /a requires b@~1\.1\.0, found 1\.2\.0/);
  assert.deepEqual(
    sortManifests([m("a", { b: ">=1.0.0 <2" }), m("b")]).map((x) => x.name),
    ["b", "a"],
  );
  assert.throws(() => sortManifests([m("a", { b: "*" }), m("b", { a: "*" })]), /cycle: a -> b -> a/);
  assert.throws(() => sortManifests([m("a"), m("a")]), /Duplicate plugin a/);
  // disabled names match like subrun filters: `prefix*` by prefix
  assert.deepEqual(
    sortManifests([m("web-a"), m("web-b"), m("webx")], {}, ["web-*"]).map((x) => x.name),
    ["webx"],
  );
  assert.throws(() => sortManifests([m("a", { "web-b": "*" }), m("web-b")], {}, ["web*"]), /which disabledPlugins/);
  // names the host provides satisfy dependencies, version-checked, without being loaded
  assert.deepEqual(
    sortManifests([m("a", { host: "^1.0.0" })], { host: "1.5.0" }).map((x) => x.name),
    ["a"],
  );
  assert.throws(
    () => sortManifests([m("a", { host: "^2.0.0" })], { host: "1.5.0" }),
    /a requires host@\^2\.0\.0, found 1\.5\.0/,
  );
  assert.throws(
    () => sortManifests([m("host")], { host: "1.5.0" }),
    /Duplicate plugin host in host: hortus provides it/,
  );
  assert.throws(() => sortManifests([m("a", { toString: "*" })]), /a requires missing plugin toString@\*/);
  // "last" ones load after the others, in dependency order among themselves; a plugin depending on one pulls it earlier
  const last = (name: string, dependencies?: Record<string, string>) => ({
    ...m(name, dependencies),
    order: "last" as const,
  });
  assert.deepEqual(
    sortManifests([last("a", { c: "*" }), m("b"), last("c"), m("d")]).map((x) => x.name),
    ["b", "d", "c", "a"],
  );
  assert.deepEqual(
    sortManifests([last("a"), m("b", { a: "*" }), m("c")]).map((x) => x.name),
    ["a", "b", "c"],
  );
});
