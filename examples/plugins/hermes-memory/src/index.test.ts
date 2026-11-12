import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgent, hortusDir, openSession, type Plugin } from "@hortus/core";
import { scripted, type Turn, tempHome, until } from "@hortus/core/testing";
import plugin, { WRITE_TOOLS } from "./index.ts";

const dir = fileURLToPath(new URL("..", import.meta.url));
const mem = (...p: string[]) => join(hortusDir(), "hermes-memory", ...p);
const read = (path: string) => readFile(path, "utf8").catch(() => "");

async function setup(
  t: { after: (fn: () => Promise<void>) => void },
  config: object,
  turns: Turn[],
  on: Plugin["on"] = {},
) {
  await writeFile(join(hortusDir(), "hermes-memory.json"), JSON.stringify(config));
  const provider = scripted(turns);
  const notes: string[] = [];
  const agent = await createAgent({
    extra: [
      {
        name: "scripted",
        plugin: { providers: { scripted: provider }, on: { ...on, notify: (n) => void notes.push(n.text) } },
      },
    ],
  });
  // a project: a git repository named "proj"
  const tmp = await mkdtemp(join(tmpdir(), "hermes-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "proj");
  await mkdir(join(cwd, ".git"), { recursive: true });
  const session = await openSession(null);
  await session.setCwd(cwd);
  await agent.setSession(session);
  const command = (name: string, arg = "") =>
    agent
      .commands()
      .find((c) => c.name === name)
      ?.run(arg);
  return { provider, agent, notes, command };
}

const userText = (req?: { messages: { role: string; content?: unknown }[] }) => String(req?.messages[0]?.content);

test("hermes-memory: memory tools, policy prompt, a correction subrun and a background review subrun", async (t) => {
  t.after(await tempHome({ plugins: { "hermes-memory": dir } }));
  const { provider, agent, notes, command } = await setup(t, { nudgeInterval: 3, flushOnShutdown: false }, [
    // run 1
    { toolCalls: [{ id: "a", name: "memory_add", input: { target: "user", content: "Name is Toshi" } }] },
    { text: "Nice to meet you." },
    // run 2: a correction, saved by a subrun at turn_end
    { text: "OK, pnpm." },
    { toolCalls: [{ id: "c", name: "memory_add", input: { target: "project", content: "Uses pnpm, not npm" } }] },
    { text: "Saved." },
    // run 3: third user turn, past nudgeInterval turns: the background review
    { text: "Let's ship." },
    { toolCalls: [{ id: "r", name: "memory_add", input: { target: "memory", content: "Ships on Fridays" } }] },
    { text: "Saved." },
  ]);
  t.after(() => agent.close());

  await agent.run("Hi, I'm Toshi.");
  await agent.run("No, use pnpm instead of npm");
  await agent.run("Thanks, what next?");
  await until(() => notes.includes("Memory auto-reviewed and updated"));

  const [first, , , correction, , , review] = provider.requests;
  assert.match(first?.system ?? "", /<memory-policy>/);
  assert.ok(first?.tools.some((x) => x.name === "memory_search"));

  // the correction child: only the write tools, no policy, the correction and the memory so far
  assert.deepEqual(correction?.tools.map((x) => x.name).sort(), [...WRITE_TOOLS].sort());
  assert.doesNotMatch(correction?.system ?? "", /memory-policy|AGENTS/);
  assert.match(userText(correction), /^The user just corrected you/);
  assert.match(userText(correction), /--- User Correction to Save ---\nNo, use pnpm instead of npm/);
  assert.match(userText(correction), /--- Current User Profile ---\nName is Toshi/);
  assert.match(userText(correction), /--- Current Project Memory ---/);
  assert.ok(notes.includes("Correction detected — memory updated"));

  // the review child sees the conversation
  assert.deepEqual(review?.tools.map((x) => x.name).sort(), [...WRITE_TOOLS].sort());
  assert.match(userText(review), /^Review the conversation above/);
  assert.match(userText(review), /\[USER\]: Hi, I'm Toshi\.[\s\S]*\[ASSISTANT\]: Let's ship\./);

  assert.match(await read(mem("USER.md")), /^Name is Toshi <!-- created=\d{4}-\d\d-\d\d, last=/);
  assert.match(await read(mem("projects", "proj", "MEMORY.md")), /Uses pnpm, not npm/);
  assert.match(
    await read(mem("failures.md")),
    /\[correction\] use pnpm instead of npm — Failed: User corrected the agent/,
  );
  assert.match(await read(mem("MEMORY.md")), /Ships on Fridays/);

  const search = await agent.ctx.runTool({ id: "s", name: "memory_search", input: { query: "pnpm" } });
  assert.match(search.output, /\[target=project\] scope=project:proj Uses pnpm, not npm/);
  assert.match(search.output, /\[target=failure\] scope=global \[correction\]/);
  const blocked = await agent.ctx.runTool({
    id: "b",
    name: "memory_add",
    input: { target: "memory", content: "key is sk-ant-api0123456789abcdef" },
  });
  assert.match(blocked.output, /"success":false.*Blocked/);
  assert.match(String(await command("memory-insights")), /PROJECT MEMORY: proj\n {2}1\. Uses pnpm, not npm/);
});

test("hermes-memory: legacy-inject freezes memory into the prompt, standing instructions, flush on /new and at exit", async (t) => {
  t.after(await tempHome({ plugins: { "hermes-memory": dir } }));
  const today = new Date().toISOString().slice(0, 10);
  await mkdir(mem(), { recursive: true });
  await writeFile(mem("USER.md"), `Name is Toshi <!-- created=${today}, last=${today} -->`);
  await writeFile(mem("failures.md"), `[correction] use pnpm <!-- created=${today}, last=${today} -->`);
  const { provider, agent, command } = await setup(
    t,
    { memoryMode: "legacy-inject", flushMinTurns: 1, reviewEnabled: false },
    [
      { text: "hi" },
      { text: "again" },
      // /new: the flush subrun
      { toolCalls: [{ id: "f", name: "memory_add", input: { target: "memory", content: "Flushed fact" } }] },
      { text: "Saved." },
      { text: "yes" },
      // exit: the flush subrun, as on /new
      { toolCalls: [{ id: "e", name: "memory_add", input: { target: "user", content: "Likes tea" } }] },
      { text: "Saved." },
    ],
  );
  assert.match(String(await command("memory-pin", "never run find /")), /Pinned standing instruction 1/);

  await agent.run("hello");
  await agent.ctx.runTool({ id: "u", name: "memory_add", input: { target: "user", content: "Added mid-session" } });
  const full = await agent.ctx.runTool({
    id: "x",
    name: "memory_add",
    input: { target: "user", content: "x".repeat(6000) },
  });
  assert.match(full.output, /Memory at \d+\/5000 chars/);
  await agent.run("again");
  await agent.setSession(await openSession(null), "new");
  await agent.run("remember?");
  await agent.close();

  const [first, second, flush, , fresh, exit] = provider.requests;
  assert.doesNotMatch(first?.system ?? "", /memory-policy/);
  assert.match(first?.system ?? "", /<memory-context>[\s\S]*USER PROFILE[\s\S]*Name is Toshi/);
  assert.match(first?.system ?? "", /RECENT FAILURES & LESSONS[\s\S]*• \[correction\] use pnpm/);
  assert.match(first?.system ?? "", /<standing-instructions>[\s\S]*1\. never run find \/\n<\/standing-instructions>$/);
  // frozen for the session
  assert.doesNotMatch(second?.system ?? "", /Added mid-session/);
  assert.match(userText(flush), /^\[System: The session is being compressed[\s\S]*\[USER\]: hello/);
  // a new session takes a new snapshot
  assert.match(fresh?.system ?? "", /Flushed fact[\s\S]*Added mid-session/);
  assert.deepEqual(exit?.tools.map((x) => x.name).sort(), [...WRITE_TOOLS].sort());
  assert.match(userText(exit), /^\[System: The session is being compressed[\s\S]*\[USER\]: remember\?/);
  assert.match(await read(mem("USER.md")), /Likes tea/);
});

test("hermes-memory: flushes what a compaction summarized away, once saved, with flushMinTurns user turns", async (t) => {
  t.after(await tempHome({ plugins: { "hermes-memory": dir } }));
  let cancel = true;
  const { provider, agent, command } = await setup(
    t,
    { reviewEnabled: false, flushOnShutdown: false, flushMinTurns: 2 },
    [
      { text: "the build uses pnpm" },
      { text: "ok" },
      // the second /compact: the summary, then the flush subrun (waited for, as /compact is manual)
      { text: "SUMMARY" },
      { toolCalls: [{ id: "f", name: "memory_add", input: { target: "memory", content: "Builds with pnpm" } }] },
      { text: "Saved." },
    ],
    {
      compact: (p) => {
        if (cancel) p.cancel = true;
      },
    },
  );
  await agent.run("how do we build?");
  await agent.run("thanks");
  // cancelled after hermes-memory saw it: no flush
  assert.equal(await command("compact"), "Compaction cancelled by a plugin");
  assert.equal(provider.requests.length, 2);
  cancel = false;
  assert.equal(await command("compact"), undefined);
  const [, , summary, flush] = provider.requests;
  assert.match(userText(summary), /<conversation>/);
  assert.match(userText(flush), /^\[System: The session is being compressed[\s\S]*\[USER\]: how do we build\?/);
  assert.match(await read(mem("MEMORY.md")), /Builds with pnpm/);
  await agent.close();
});

test("hermes-memory: no flush when what a compaction summarizes has fewer than flushMinTurns user turns", async (t) => {
  t.after(await tempHome({ plugins: { "hermes-memory": dir } }));
  const { provider, agent, command } = await setup(t, { reviewEnabled: false, flushOnShutdown: false }, [
    { text: "the build uses pnpm" },
    { text: "ok" },
    { text: "SUMMARY" },
  ]);
  await agent.run("how do we build?");
  await agent.run("thanks");
  assert.equal(await command("compact"), undefined);
  assert.equal(provider.requests.length, 3);
  await agent.close();
});

test("hermes-memory: overlapping compactions on two sessions each flush their own messages", async (t) => {
  t.after(await tempHome());
  const prompts: string[] = [];
  const state = {};
  const ctx = (session: object) =>
    ({
      session,
      state,
      cwd: tmpdir(),
      subrun: (prompt: string) => {
        prompts.push(prompt);
        return { done: Promise.resolve(undefined) };
      },
    }) as never;
  const a = ctx({});
  const b = ctx({});
  const event = (word: string) =>
    ({
      reason: "threshold",
      tokensBefore: 0,
      messages: Array.from({ length: 6 }, () => [
        { role: "user", content: word },
        { role: "assistant", text: "ok", toolCalls: [] },
      ]).flat(),
    }) as never;
  const on = plugin.on as Required<Plugin>["on"] as Record<string, (p: unknown, ctx: never) => unknown>;
  await on.compact?.(event("alpha"), a);
  await on.compact?.(event("beta"), b);
  await on.compacted?.({ reason: "manual" }, a);
  await on.compacted?.({ reason: "manual" }, b);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0] ?? "", /alpha/);
  assert.doesNotMatch(prompts[0] ?? "", /beta/);
  assert.match(prompts[1] ?? "", /beta/);
});
