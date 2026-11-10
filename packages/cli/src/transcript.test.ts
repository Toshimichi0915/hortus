import assert from "node:assert/strict";
import { test } from "node:test";
import { wrap } from "./markdown.ts";
import { toolEntry } from "./entry.ts";
import { builtinTools, genericTool } from "./tools.tsx";
import { layout, selectionText, toRows, withBlockText } from "./transcript.tsx";

const tools = (name: string) => builtinTools[name] ?? genericTool;

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
  const rows = toRows([{ id: 0, kind: "user", text: "aaa bbb ccc\nsecond" }], 7);
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

test("selection across rows copies assistant output as its markdown source lines", () => {
  const md = "Title\n===\n**aaa bbb** ccc\n\n| a | b |\n|---|---|\n| c | d |\nend";
  const rows = toRows(
    [
      { id: 0, kind: "user", text: "hi" },
      { id: 1, kind: "assistant", text: md },
    ],
    7,
  );
  const at = (t: string) => rows.findIndex((r) => r.text.startsWith(t));
  // a single row stays rendered text
  assert.equal(selectionText(rows, { row: at("bbb"), col: 0 }, { row: at("bbb"), col: 2 }), "bbb");
  // the heading pulls in its underline; a wrapped line copies once, whole
  assert.equal(
    selectionText(rows, { row: at("Title"), col: 3 }, { row: at("bbb"), col: 0 }),
    "Title\n===\n**aaa bbb** ccc",
  );
  // touching a table copies all of it; plain rows before the entry stay as they were
  assert.equal(
    selectionText(rows, { row: 0, col: 0 }, { row: at("c"), col: 0 }),
    "hi\n\nTitle\n===\n**aaa bbb** ccc\n\n| a | b |\n|---|---|\n| c | d |",
  );
});

test("styled spans are split across wrapped rows", () => {
  const rows = toRows([{ id: 0, kind: "assistant", text: "**aaa bbb** ccc" }], 7);
  assert.deepEqual(
    rows.map((r) => r.spans),
    [[{ bold: true, text: "aaa " }], [{ bold: true, text: "bbb" }, { text: " ccc" }]],
  );
});

test("a tool block takes the rows it measured, and copies as its renderer's text between its background rows", () => {
  const bash = toolEntry({ id: "1", name: "bash", input: { command: "seq 2" } }, { id: "1", output: "1\n2\n" });
  const entries = [{ id: 0, kind: "user" as const, text: "hi" }, bash, { id: 2, kind: "info" as const, text: "done" }];
  // unmeasured: a guess of 3 rows; measured: as many as it drew (a blank row, header, blank, 2 lines, blank)
  assert.equal(toRows(entries, 20).length, 1 + 1 + 3 + 1);
  const { rows, segments } = layout(entries, 20, () => 6);
  assert.deepEqual(
    segments.map(({ start, height, gap }) => [start, height, gap]),
    [
      [0, 1, false],
      [1, 7, true],
      [8, 1, false],
    ],
  );
  assert.deepEqual(
    rows.map((r) => r.block?.line ?? r.text),
    ["hi", "", 0, 1, 2, 3, 4, 5, "done"],
  );
  // block rows have no text until copied; from "hi" into the block's output, then from the block's header on
  const copy = (a: number, b: number, col = 99) =>
    selectionText(
      withBlockText(rows, { row: a, col: 0 }, { row: b, col }, 20, tools),
      { row: a, col: 0 },
      { row: b, col },
    );
  assert.equal(copy(0, 5), "hi\n\n\n$ seq 2\n\n1");
  assert.equal(copy(3, 8, 1), "$ seq 2\n\n1\n2\n\ndo");
});
