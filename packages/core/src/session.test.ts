import assert from "node:assert/strict";
import { test } from "node:test";
import { branch, type SessionEntry } from "./session.ts";

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
  assert.deepEqual(branch(entries, "p2"), { messages: [], model: undefined, provider: "anthropic" });
  assert.deepEqual(branch(entries, "p1"), { messages: [], model: "gpt-5", provider: "openai" });
});
