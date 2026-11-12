import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type CliPlugin, version } from "@hortus/cli";
import { composeTools } from "@hortus/cli/testing";
import { createAgent, type Message } from "@hortus/core";
import { scripted, tempHome, untimed } from "@hortus/core/testing";

test("restyle-read wraps read to add details, and its renderer draws over the built-in one", async (t) => {
  t.after(await tempHome({ plugins: { "restyle-read": fileURLToPath(new URL("..", import.meta.url)) } }));
  const file = join(homedir(), "note.txt");
  await writeFile(file, "a\nb\nc");
  const call = { id: "1", name: "read", input: { path: file } };
  const provider = scripted([{ toolCalls: [call] }, { text: "done" }]);
  const agent = await createAgent({
    // as the CLI loads plugins: restyle-read depends on it
    provided: { "@hortus/cli": version },
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }],
  });
  // the run's history, not the request: details are never sent
  const messages = (await agent.run("read note.txt"))?.messages ?? [];
  const last = messages.at(-2) as Extract<Message, { role: "tool" }> | undefined;
  const result = last?.results[0];
  assert.deepEqual(untimed(result), { id: "1", output: "a\nb\nc", details: { lines: 3 } });

  const block = composeTools(
    agent.plugins.map((p) => p.plugin as CliPlugin),
    undefined,
    assert.fail,
  )("read");
  const text = block.text({ call, result, details: result?.details, width: 80 });
  // the built-in block's header and preview (its `Default`), then the plugin's line
  assert.match(text, /^read .*note\.txt\n\na\nb\nc\n3 lines read$/);
});
