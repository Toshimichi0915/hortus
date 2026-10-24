import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTool } from "./entry.ts";

test("formatTool shows a pi-style header and a tail/head preview", () => {
  const bash = { id: "1", name: "bash", input: { command: "seq 8" } };
  assert.equal(formatTool(bash), "\n$ seq 8\n");
  const out = "1\n2\n3\n4\n5\n6\n7\n8\n";
  assert.equal(formatTool(bash, { id: "1", output: out }), "\n$ seq 8\n\n... (3 earlier lines)\n4\n5\n6\n7\n8\n");
  const read = { id: "2", name: "read", input: { path: "a.ts", offset: 5, limit: 3 } };
  assert.equal(formatTool(read, { id: "2", output: "x" }).split("\n")[1], "read a.ts:5-7");
  const edit = { id: "3", name: "edit", input: { path: "b.ts", edits: [{ oldText: "a", newText: "b" }] } };
  assert.equal(formatTool(edit), "\nedit b.ts\n\n- a\n+ b\n");
});
