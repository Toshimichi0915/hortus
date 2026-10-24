import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTool, theme } from "./entry.ts";
import { selectionText, toRows, wrap } from "./transcript.tsx";

test("wrap keeps every character and respects width, including wide chars", () => {
  for (const line of [
    "the quick brown fox jumps over the lazy dog",
    "日本語のテキストを折り返す",
    "averyveryverylongword x",
    "",
  ]) {
    const rows = wrap(line, 10);
    assert.equal(rows.join(""), line);
    for (const r of rows) assert.ok([...r].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0) <= 10, r);
  }
  assert.deepEqual(wrap("aaa bbb ccc", 7), ["aaa ", "bbb ccc"]);
});

test("selection joins soft-wrapped rows without newlines and real lines with them", () => {
  const rows = toRows([{ id: 0, kind: "assistant", text: "aaa bbb ccc\nsecond" }], 7);
  assert.deepEqual(
    rows.map((r) => [r.text, r.cont]),
    [
      ["aaa ", false],
      ["bbb ccc", true],
      ["second", false],
    ],
  );
  // from "bbb" on row 0's wrap through "sec"
  assert.equal(selectionText(rows, { row: 1, col: 0 }, { row: 2, col: 2 }), "bbb ccc\nsec");
  // reversed drag gives the same text; columns past the end are fine
  assert.equal(selectionText(rows, { row: 2, col: 2 }, { row: 0, col: 0 }), "aaa bbb ccc\nsec");
  assert.equal(selectionText(rows, { row: 0, col: 2 }, { row: 0, col: 99 }), "a ");
});

test("styled spans are split across wrapped rows", () => {
  const rows = toRows([{ id: 0, kind: "assistant", text: "**aaa bbb** ccc" }], 7);
  assert.deepEqual(
    rows.map((r) => r.spans),
    [[{ bold: true, text: "aaa " }], [{ bold: true, text: "bbb" }, { text: " ccc" }]],
  );
});

test("edit blocks color removed lines red and added lines green", () => {
  const call = { id: "1", name: "edit", input: { path: "a", edits: [{ oldText: "x", newText: "y" }] } };
  const rows = toRows([{ id: 0, kind: "toolOk", text: formatTool(call) }], 20);
  assert.deepEqual(
    rows.map((r) => [r.text, r.spans[0]?.color]),
    [
      ["", undefined],
      ["edit a", theme.text],
      ["", undefined],
      ["- x", theme.red],
      ["+ y", theme.green],
      ["", undefined],
    ],
  );
});
