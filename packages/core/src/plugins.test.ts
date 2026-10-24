import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlugins, sortManifests } from "./plugins.ts";

async function writePlugin(dir: string, manifest: object, source: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "phi.json"), JSON.stringify(manifest));
  await writeFile(join(dir, "index.mjs"), source);
}

test("loadPlugins merges plugins over the built-ins, dependencies first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phi-"));
  // "a" sorts first but depends on "b", so "b" loads first and "a" overrides it
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
      providers: { fake: { create: () => ({}), defaultModel: "m" } },
      tools: [{ name: "read", description: "override", inputSchema: null, execute: async () => "" }],
      on: { session_start: ({ system }) => { system.push("from a"); } },
    };`,
  );
  await writePlugin(
    join(dir, "b"),
    { name: "b", version: "1.0.0", entrypoint: "index.mjs" },
    `export default {
      tools: [{ name: "read", description: "from b", inputSchema: null, execute: async () => "" }],
      on: { session_start: ({ system }) => { system.push("from b"); } },
    };`,
  );
  await mkdir(join(dir, "not-a-plugin"));
  const { providers, tools, emit } = await loadPlugins(dir, [
    { on: { session_start: (s) => void s.system.push("extra") } },
  ]);
  const start = { system: [] as string[] };
  await emit("session_start", start);
  assert.deepEqual(start.system.slice(1), ["from b", "from a", "extra"]);
  assert.match(start.system[0] ?? "", /coding agent/);
  assert.deepEqual(Object.keys(providers), ["openrouter", "openai", "anthropic", "fake"]);
  assert.equal(tools.filter((t) => t.name === "read").length, 1);
  assert.equal(tools.find((t) => t.name === "read")?.description, "override");
  const empty = await loadPlugins(join(dir, "nonexistent"));
  assert.deepEqual(Object.keys(empty.providers), ["openrouter", "openai", "anthropic"]);

  await writePlugin(join(dir, "c"), { name: "c", version: "1.0.0", entrypoint: "nope.mjs" }, "");
  await assert.rejects(loadPlugins(dir), /Failed to load plugin c/);
  await writePlugin(join(dir, "c"), { name: "c", version: "1.0", entrypoint: "index.mjs" }, "");
  await assert.rejects(loadPlugins(dir), /Invalid .*phi\.json: .*invalid semver version/s);
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
});
