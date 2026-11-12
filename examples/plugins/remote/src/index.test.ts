import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { version } from "@hortus/cli";
import { createCli } from "@hortus/cli/testing";
import { createAgent, hortusDir, openSession } from "@hortus/core";
import { scripted, tempHome, until } from "@hortus/core/testing";
import { infoPath } from "./index.ts";

test("remote: a send from outside any run starts a turn in the CLI, and its events stream to the client", async (t) => {
  t.after(await tempHome({ plugins: { remote: fileURLToPath(new URL("..", import.meta.url)) } }));
  const provider = scripted([{ text: "on it" }]);
  const cli = await createCli(await openSession(null), (o) =>
    createAgent({
      ...o,
      provided: { "@hortus/cli": version },
      extra: [{ name: "s", plugin: { providers: { scripted: provider } } }, ...(o.extra ?? [])],
    }),
  );
  const { url, token } = JSON.parse(await readFile(infoPath(), "utf8")) as { url: string; token: string };
  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${url}/send`, { method: "POST", body: "{}" })).status, 401);

  const events = await fetch(`${url}/events`, { headers: auth });
  const reader = events.body?.getReader();
  let streamed = "";
  const reading = (async () => {
    for (let r = await reader?.read(); r && !r.done; r = await reader?.read()) streamed += Buffer.from(r.value);
  })();
  const sent = await fetch(`${url}/send`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ text: "hi from afar" }),
  });
  assert.equal(sent.status, 202);
  await until(() => streamed.includes('"idle"'));

  const shown = cli.ui.getState().entries.flatMap((e) => (e.kind === "user" || e.kind === "assistant" ? [e.text] : []));
  assert.deepEqual(shown, ["\nhi from afar\n", "on it"]);
  assert.equal(cli.ui.getState().busy, false);
  const names = streamed.split("\n\n").flatMap((l) => (l.startsWith("data: ") ? [JSON.parse(l.slice(6)).name] : []));
  assert.deepEqual(names, ["input", "message", "run_start", "text", "message", "run_end", "idle"]);
  assert.match(streamed, /"source":"remote"/);

  // another hortus process's file is left alone
  const other = join(hortusDir(), "remote-1.json");
  await writeFile(other, "{}");
  await cli.close();
  await reading;
  await assert.rejects(readFile(infoPath()), /ENOENT/);
  assert.equal(await readFile(other, "utf8"), "{}");
});

test("remote: a client answers an ask while the TUI's dialog is open, closing it", async (t) => {
  t.after(await tempHome({ plugins: { remote: fileURLToPath(new URL("..", import.meta.url)) } }));
  const cli = await createCli(await openSession(null), (o) =>
    createAgent({ ...o, provided: { "@hortus/cli": version } }),
  );
  const { url, token } = JSON.parse(await readFile(infoPath(), "utf8")) as { url: string; token: string };
  const auth = { authorization: `Bearer ${token}` };
  const events = await fetch(`${url}/events`, { headers: auth });
  const reader = events.body?.getReader();
  let streamed = "";
  const reading = (async () => {
    for (let r = await reader?.read(); r && !r.done; r = await reader?.read()) streamed += Buffer.from(r.value);
  })();
  let engaged = false;
  const asked = cli.agent.ctx.ask(
    { question: "Deploy?", options: [{ label: "yes" }, { label: "no" }] },
    { detailed: true },
  );
  void cli.ui.getState().asks[0]?.engaged.then(() => (engaged = true));
  await until(() => streamed.includes('"ask"'));
  // the TUI shows its dialog meanwhile
  assert.equal(cli.ui.getState().asks[0]?.question, "Deploy?");
  const ask = streamed
    .split("\n\n")
    .flatMap((l) => (l.startsWith("data: ") ? [JSON.parse(l.slice(6))] : []))
    .find((e) => e.name === "ask")?.payload as { id: string; question: string; options: { label: string }[] };
  assert.deepEqual([ask.question, ask.options.map((o) => o.label)], ["Deploy?", ["yes", "no"]]);
  // a client says it's answering (an autopilot's countdown would stop)
  const engage = await fetch(`${url}/engage`, { method: "POST", headers: auth, body: JSON.stringify({ id: ask.id }) });
  assert.equal(engage.status, 204);
  await until(() => engaged, 5000);
  const res = await fetch(`${url}/answer`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ id: ask.id, answer: "no" }),
  });
  assert.equal(res.status, 204);
  assert.deepEqual(await asked, { answer: "no", by: "remote", reason: "answered" });
  assert.equal(cli.ui.getState().asks.length, 0);
  await until(() => streamed.includes('"answered"'));
  assert.match(streamed, new RegExp(`"answered","payload":\\{"id":"${ask.id}"`));
  // answered already: nothing to answer
  const again = await fetch(`${url}/answer`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ id: ask.id, answer: "yes" }),
  });
  assert.equal(again.status, 404);
  await cli.close();
  await reading;
});

test("remote: an ask waiting on a client fails closed once the last client leaves (headless)", async (t) => {
  t.after(await tempHome({ plugins: { remote: fileURLToPath(new URL("..", import.meta.url)) } }));
  const agent = await createAgent();
  const { url, token } = JSON.parse(await readFile(infoPath(), "utf8")) as { url: string; token: string };
  const leave = new AbortController();
  const events = await fetch(`${url}/events`, { headers: { authorization: `Bearer ${token}` }, signal: leave.signal });
  const reader = events.body?.getReader();
  let streamed = "";
  const reading = (async () => {
    for (let r = await reader?.read(); r && !r.done; r = await reader?.read()) streamed += Buffer.from(r.value);
  })().catch(() => {});
  let settled = false;
  const asked = agent.ctx.ask({ question: "Deploy?" }).finally(() => (settled = true));
  await until(() => streamed.includes('"ask"'));
  assert.match(streamed, /"Deploy\?"/);
  await sleep(30); // negative check: a (wrong) fail-closed would settle by now
  assert.equal(settled, false, "held while a client could answer");
  leave.abort();
  assert.equal(await asked, undefined);
  await reading;
  await agent.close();
});
