import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnHortus } from "@hortus/cli/testing";
import { hortusDir } from "@hortus/core";
import { scriptedPlugin, tempDir, tempHome } from "@hortus/core/testing";

async function setup(t: test.TestContext) {
  const dir = await tempDir(t);
  t.after(
    await tempHome({
      plugins: {
        "permission-system": fileURLToPath(new URL("..", import.meta.url)),
        scripted: scriptedPlugin(`[
          { toolCalls: [{ id: "b", name: "bash", input: { command: "echo approved" } }] },
          (req) => ({ text: "said: " + req.messages.at(-1).results[0].output }),
        ]`),
      },
    }),
  );
  await writeFile(
    join(hortusDir(), "permission-system.json"),
    JSON.stringify({ permission: { "*": "allow", bash: { "*": "ask" } } }),
  );
  return dir;
}

test("under hortus -p nobody can approve, so an ask is denied instead of hanging", async (t) => {
  const dir = await setup(t);
  const h = spawnHortus(t, ["-p", "--cwd", dir, "go"]);
  assert.equal(await h.exit, 0, h.stderr());
  assert.match(
    h.stdout(),
    /said: Blocked by permission-system: bash command "echo approved" needs approval and no one can approve it here/,
  );
});

test("over --rpc the client answers the permission prompt", async (t) => {
  const dir = await setup(t);
  const h = spawnHortus(t, ["--rpc", "--cwd", dir]);
  await h.next((l) => l.event === "interactive");
  h.send({ type: "prompt", text: "go" });
  const ask = await h.next((l) => l.event === "ask");
  assert.match(ask.payload.question, /^Allow bash\?\n• bash command "echo approved"/);
  assert.deepEqual(
    ask.payload.options.map((o: { label: string }) => o.label),
    ["Allow once", "Allow for this session", "Deny"],
  );
  h.send({ type: "answer", askId: ask.payload.askId, answer: "Allow once" });
  const reply = await h.next((l) => l.event === "message" && l.payload.role === "assistant" && l.payload.text);
  assert.equal(reply.payload.text, "said: approved\n");
  h.send({ type: "exit" });
  assert.equal(await h.exit, 0, h.stderr());
});
