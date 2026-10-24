import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlugins } from "./plugins.ts";

test("loadPlugins merges plugins over the built-ins", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "phi-")), "plugin.mjs");
  await writeFile(
    path,
    `export default {
      providers: { fake: { create: () => ({}), defaultModel: "m" } },
      tools: [{ name: "read", description: "override", inputSchema: null, execute: async () => "" }],
      on: { session_start: ({ system }) => { system.push("from file"); } },
    };`,
  );
  const { providers, tools, emit } = await loadPlugins(
    [path],
    [{ on: { session_start: (s) => void s.system.push("extra") } }],
  );
  const start = { system: [] as string[] };
  await emit("session_start", start);
  assert.deepEqual(start.system.slice(1), ["from file", "extra"]);
  assert.match(start.system[0] ?? "", /coding agent/);
  assert.deepEqual(Object.keys(providers), ["openrouter", "openai", "anthropic", "fake"]);
  assert.equal(tools.filter((t) => t.name === "read").length, 1);
  assert.equal(tools.find((t) => t.name === "read")?.description, "override");
  await assert.rejects(loadPlugins(["/nonexistent.mjs"]), /Failed to load plugin \/nonexistent\.mjs/);
});
