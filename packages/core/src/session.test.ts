import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { test } from "node:test";
import { tempDir } from "./testing.ts";
import type { Message } from "./llm.ts";
import {
  branch,
  listSessions,
  memorySession,
  openSession,
  readSession,
  type PluginEntry,
  type SessionEntry,
  type SessionState,
} from "./session.ts";

test("branch walks from the leaf to the root, skipping sibling branches", () => {
  const e = (id: string, parentId: string | null): SessionEntry => ({
    v: 1,
    type: "message",
    id,
    parentId,
    message: { role: "user", content: id },
  });
  const entries = [e("a", null), e("b", "a"), e("c", "b"), e("d", "a")];
  const ids = (leaf: string) => branch(entries, leaf).messages.map((m) => (m.role === "user" ? m.content : ""));
  assert.deepEqual(ids("c"), ["a", "b", "c"]);
  assert.deepEqual(ids("d"), ["a", "d"]);
});

test("branch restores the last model chosen on its own path", () => {
  const entries: SessionEntry[] = [
    { v: 1, type: "message", id: "a", parentId: null, message: { role: "user", content: "a" } },
    { v: 1, type: "model", id: "m1", parentId: "a", model: "x" },
    { v: 1, type: "model", id: "m2", parentId: "m1", model: "y" },
    { v: 1, type: "message", id: "b", parentId: "m2", message: { role: "user", content: "b" } },
    { v: 1, type: "model", id: "m3", parentId: "a", model: "z" },
  ];
  assert.equal(branch(entries, "b").model, "y");
  assert.equal(branch(entries, "b").messages.length, 2);
  assert.equal(branch(entries, "m3").model, "z");
  assert.equal(branch(entries, "a").model, undefined);
});

test("branch skips lines no parser matches", () => {
  const entries = [
    { v: 1, type: "message", id: "a", parentId: null, message: { role: "user", content: "a" } },
    { v: 2, type: "model", id: "b", parentId: "a", model: "future" },
    { v: 1, type: "unknown", id: "c", parentId: "b" },
  ] as SessionEntry[];
  const s = branch(entries, "c");
  assert.equal(s.messages.length, 1);
  assert.equal(s.model, undefined);
});

test("branch restores model and provider together from the model line", () => {
  const entries: SessionEntry[] = [
    { v: 1, type: "model", id: "p1", parentId: null, model: "gpt-5", provider: "openai" },
    { v: 1, type: "model", id: "p2", parentId: "p1", provider: "anthropic" },
  ];
  const settings = (leaf: string) => {
    const { model, provider } = branch(entries, leaf);
    return { model, provider };
  };
  assert.deepEqual(settings("p2"), { model: undefined, provider: "anthropic" });
  assert.deepEqual(settings("p1"), { model: "gpt-5", provider: "openai" });
});

test("session changes reach subscribers with the previous state, and the file replays to the same state", async (t) => {
  const session = await openSession(null, await tempDir(t, "hortus-"));
  const seen: [SessionState, SessionState][] = [];
  session.subscribe((state, prev) => void seen.push([state, prev]));
  await session.setModel("m");
  await session.append([{ role: "user", content: "hi" }]);
  await session.setProvider("p");
  await session.setModel("m2", "p2");
  assert.deepEqual(
    seen.map(([s, prev]) => [prev.model, s.model, prev.messages.length, s.messages.length, s.provider]),
    [
      [undefined, "m", 0, 0, undefined],
      ["m", "m", 0, 1, undefined],
      ["m", "m", 1, 1, "p"],
      ["m", "m2", 1, 1, "p2"],
    ],
  );
  const entries = (await readFile(session.path ?? "", "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEntry);
  assert.deepEqual(branch(entries, session.leafId ?? ""), session.getState());
});

test("listSessions lists non-empty sessions newest first, titled by the first user message, resumable at the leaf", async (t) => {
  const dir = await tempDir(t, "hortus-");
  const a = await openSession(null, dir);
  await a.setModel("m");
  await a.append([
    { role: "user", content: "first" },
    { role: "user", content: "second" },
  ]);
  await openSession(null, dir); // never written, so no file
  const list = await listSessions(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.title, "first");
  assert.equal(list[0]?.path, a.path);
  assert.ok(a.path?.includes(list[0]?.id ?? "?"));
  const resumed = await openSession(list[0]?.leafId ?? null, dir);
  assert.equal(resumed.path, a.path);
  assert.equal(resumed.getState().messages.length, 2);
  // readSession: the state without opening it, at the last entry or an earlier one
  const state = await readSession(list[0]?.path ?? "");
  assert.deepEqual(
    [state.model, state.messages.map((m) => m.role === "user" && m.content)],
    ["m", ["first", "second"]],
  );
  const earlier = (await readSession(a.path ?? "", state.messages[0]?.entryId)).messages;
  assert.deepEqual(
    earlier.map((m) => m.role === "user" && m.content),
    ["first"],
  );
});

test("a line cut short by a crash is skipped, and the next entry starts on a line of its own", async (t) => {
  const dir = await tempDir(t, "hortus-");
  const a = await openSession(null, dir);
  await a.append([{ role: "user", content: "hi" }]);
  await appendFile(a.path ?? "", '{"v":1,"id":"y","par');
  const [info] = await listSessions(dir);
  assert.equal(info?.title, "hi");
  const resumed = await openSession(info?.leafId ?? null, dir);
  await resumed.append([{ role: "user", content: "again" }]);
  const [after] = await listSessions(dir);
  assert.equal(after?.leafId, resumed.leafId);
  assert.equal((await openSession(after?.leafId ?? null, dir)).getState().messages.length, 2);
});

test("branch reads a line written before usage.cached became cacheRead", () => {
  const usage = { input: 10, output: 5, cached: 4 };
  const message = { role: "assistant", text: "", toolCalls: [], usage } as unknown as Message;
  const { messages } = branch([{ v: 1, type: "message", id: "a", parentId: null, message }], "a");
  assert.deepEqual(messages[0], { ...message, usage: { input: 10, output: 5, cacheRead: 4 }, entryId: "a" });
});

test("branch reads a line written before a tool result's image became images", () => {
  const image = { type: "image", mediaType: "image/png", data: "AA==", path: "/tmp/a.png" };
  const message = {
    role: "tool",
    results: [
      { id: "1", output: "shot", image },
      { id: "2", output: "plain" },
    ],
  } as unknown as Message;
  const { messages } = branch([{ v: 1, type: "message", id: "a", parentId: null, message }], "a");
  assert.deepEqual(messages[0], {
    role: "tool",
    entryId: "a",
    results: [
      { id: "1", output: "shot", images: [image] },
      { id: "2", output: "plain" },
    ],
  });
});

test("a plugin entry replays into state.data through its reducer; branching from before it drops it; no reducer skips it", async (t) => {
  const dir = await tempDir(t, "hortus-");
  const reducers = {
    "todo:list": (e: PluginEntry, s: SessionState) => {
      s.data.todo = e.data;
    },
  };
  const a = await openSession(null, dir);
  a.replay(reducers);
  await a.append([{ role: "user", content: "hi" }]);
  const before = a.leafId;
  await a.appendEntry("todo:list", ["one"]);
  assert.deepEqual(a.getState().data, { todo: ["one"] });
  await a.appendEntry("todo:list", ["one", "two"]);
  await a.setName("chores");
  const resumed = await openSession(a.leafId, dir);
  // without the plugin (no reducer), its entries are skipped
  assert.deepEqual(resumed.getState().data, {});
  resumed.replay(reducers);
  assert.deepEqual(resumed.getState().data, { todo: ["one", "two"] });
  assert.equal(resumed.getState().name, "chores");
  assert.deepEqual(
    resumed.entries().map((e) => e.type),
    ["message", "todo:list", "todo:list", "name"],
  );
  const earlier = await openSession(before, dir);
  earlier.replay(reducers);
  assert.deepEqual(earlier.getState().data, {});
  assert.equal(earlier.getState().messages.length, 1);
  // the name titles the session
  assert.equal((await listSessions(dir))[0]?.title, "chores");
});

test("effort is per branch: branching from before a setEffort gets the effort set before it", async (t) => {
  const dir = await tempDir(t, "hortus-");
  const s = await openSession(null, dir);
  await s.setEffort("high");
  await s.append([{ role: "user", content: "hi" }]);
  const before = s.leafId;
  await s.setEffort("low");
  assert.equal((await openSession(s.leafId, dir)).getState().effort, "low");
  assert.equal((await openSession(before, dir)).getState().effort, "high");
});

test("appendEntry applies its reducer before it returns, so a read-modify-append without an await between is atomic", async (t) => {
  const dir = await tempDir(t, "hortus-");
  const s = await openSession(null, dir);
  s.replay({
    "c:n": (e, state) => {
      state.data.n = e.data;
    },
  });
  // two writers each read the counter and append it plus one, concurrently: neither sees a stale value
  const bump = () => s.appendEntry("c:n", ((s.getState().data.n as number | undefined) ?? 0) + 1);
  const pending = [bump(), bump()];
  assert.equal(s.getState().data.n, 2);
  await Promise.all(pending);
  const resumed = await openSession(s.leafId, dir);
  assert.deepEqual(
    resumed.entries().map((e) => (e as { data?: unknown }).data),
    [1, 2],
  );
});

test("appendEntry's reducer sees its data as replay will: through JSON", async (t) => {
  const dir = await tempDir(t, "hortus-");
  const s = await openSession(null, dir);
  const seen: unknown[] = [];
  const reducers = { "p:x": (e: PluginEntry) => void seen.push(e.data) };
  s.replay(reducers);
  const data = { at: new Date(0), gone: undefined, n: 1 };
  await s.appendEntry("p:x", data);
  (await openSession(s.leafId, dir)).replay(reducers);
  assert.deepEqual(seen, [
    { at: "1970-01-01T00:00:00.000Z", n: 1 },
    { at: "1970-01-01T00:00:00.000Z", n: 1 },
  ]);
  assert.notEqual(seen[0], data);
});

test("allEntries lists every branch's entries in file order, upgraded; an in-memory session's are its own", async (t) => {
  const dir = await tempDir(t, "hortus-");
  const a = await openSession(null, dir);
  await a.append([{ role: "user", content: "one" }]);
  const root = a.leafId as string;
  await a.append([{ role: "user", content: "two" }]);
  // a line written before usage.cached became cacheRead
  const old = { role: "assistant", text: "", toolCalls: [], usage: { input: 1, output: 1, cached: 1 } };
  await appendFile(
    a.path as string,
    `${JSON.stringify({ v: 1, id: "x", parentId: a.leafId, type: "message", message: old })}\n`,
  );
  // a branch from the first message, written to the same file
  const b = await openSession(root, dir);
  const pending = b.append([{ role: "user", content: "three" }]);
  // what was appended is listed even before the write settles
  const all = await b.allEntries();
  await pending;
  assert.deepEqual(
    all.map((e) => (e.type !== "message" ? e.type : e.message.role === "user" ? e.message.content : e.message)),
    ["one", "two", { ...old, usage: { input: 1, output: 1, cacheRead: 1 } }, "three"],
  );
  assert.deepEqual(
    b.entries().map((e) => e.id),
    [root, all[3]?.id],
  );
  const m = memorySession();
  await m.append([{ role: "user", content: "hi" }]);
  assert.deepEqual(await m.allEntries(), m.entries());
});
