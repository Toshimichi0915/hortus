import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnHortus } from "@hortus/cli/testing";
import { scriptedPlugin, tempDir, tempHome } from "@hortus/core/testing";

test("guard under hortus -p: no one to ask, so a write is blocked instead of hanging", async (t) => {
  const dir = await tempDir(t);
  t.after(
    await tempHome({
      plugins: {
        guard: fileURLToPath(new URL("..", import.meta.url)),
        scripted: scriptedPlugin(`[
          { toolCalls: [{ id: "w", name: "write", input: { path: "out.txt", content: "x" } }] },
          (req) => ({ text: req.messages.at(-1).results[0].output }),
        ]`),
      },
    }),
  );
  const h = spawnHortus(t, ["-p", "--cwd", dir, "write it"]);
  assert.equal(await h.exit, 0, h.stderr());
  assert.match(h.stdout(), /Blocked by guard: no one approved the write/);
  await assert.rejects(access(join(dir, "out.txt")));
});
