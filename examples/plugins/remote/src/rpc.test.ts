import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnHortus } from "@hortus/cli/testing";
import { hortusDir } from "@hortus/core";
import { scriptedPlugin, tempDir, tempHome, until } from "@hortus/core/testing";

test("remote over --rpc: a stdin client drives a full turn and answers an ask, racing remote's HTTP clients", async (t) => {
  const dir = await tempDir(t);
  await writeFile(
    join(dir, "asker.mjs"),
    `import { tool } from "@hortus/core";
import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
export default { tools: [tool({ name: "ask_me", description: "asks", inputSchema: z.object({}),
  execute: async (_, ctx) => "answer: " + await ctx.ask({ question: "Deploy?", options: [{ label: "yes" }, { label: "no" }] }) })] };
`,
  );
  t.after(
    await tempHome({
      plugins: {
        remote: fileURLToPath(new URL("..", import.meta.url)),
        scripted: scriptedPlugin(`[
          { toolCalls: [{ id: "a", name: "ask_me", input: {} }] },
          (req) => ({ text: "done, " + req.messages.at(-1).results[0].output }),
          { text: "hello afar" },
        ]`),
      },
    }),
  );
  const h = spawnHortus(t, ["--rpc", "--plugin", join(dir, "asker.mjs")]);
  await h.next((l) => l.event === "interactive");
  // remote's HTTP side, in the same process
  const { url, token } = JSON.parse(await readFile(join(hortusDir(), `remote-${h.child.pid}.json`), "utf8"));
  const auth = { authorization: `Bearer ${token}` };
  const reader = (await fetch(`${url}/events`, { headers: auth })).body?.getReader();
  let streamed = "";
  const reading = (async () => {
    for (let r = await reader?.read(); r && !r.done; r = await reader?.read()) streamed += Buffer.from(r.value);
  })();

  h.send({ type: "prompt", text: "go" });
  const ask = await h.next((l) => l.event === "ask");
  assert.equal(ask.payload.question, "Deploy?");
  await until(() => streamed.includes('"name":"ask"'));
  // the stdin client answers first; remote's copy of the ask is let go
  h.send({ type: "answer", askId: ask.payload.askId, answer: "yes" });
  const reply = await h.next((l) => l.event === "message" && l.payload.role === "assistant" && l.payload.text);
  assert.equal(reply.payload.text, "done, answer: yes");
  await until(() => streamed.includes('"name":"answered"'));

  // and a prompt sent through remote's HTTP shows on stdout
  assert.equal((await fetch(`${url}/send`, { method: "POST", headers: auth, body: '{"text":"hi"}' })).status, 202);
  const afar = await h.next((l) => l.event === "message" && l.payload.role === "assistant");
  assert.equal(afar.payload.text, "hello afar");

  h.send({ type: "exit" });
  assert.equal(await h.exit, 0, h.stderr());
  await reading;
});
