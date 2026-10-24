import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown } from "./markdown.ts";

test("markdown strips markers into styled spans and keeps fenced code verbatim", () => {
  const md = "# Title\n- a **b _c_** `d` [e](http://x)\n```\n**raw**\n```\n> q\n---";
  assert.deepEqual(markdown(md, 3), [
    [{ bold: true, text: "Title" }],
    [
      { text: "• " },
      { text: "a " },
      { bold: true, text: "b " },
      { bold: true, italic: true, text: "c" },
      { text: " " },
      { color: "yellow", text: "d" },
      { text: " " },
      { underline: true, text: "e" },
      { dimColor: true, text: " (http://x)" },
    ],
    [{ dimColor: true, text: "```" }],
    [{ color: "yellow", text: "**raw**" }],
    [{ dimColor: true, text: "```" }],
    [
      { dimColor: true, text: "│ " },
      { dimColor: true, text: "q" },
    ],
    [{ dimColor: true, text: "───" }],
  ]);
  // snake_case and lone asterisks are not emphasis
  assert.deepEqual(markdown("a_b_c 2 * 3", 1), [[{ text: "a_b_c 2 * 3" }]]);
});

test("markdown renders setext headings, styles across lines and tables", () => {
  assert.deepEqual(markdown("Title\n===\n- x\n---", 2), [
    [{ bold: true, text: "Title" }],
    [{ text: "• " }, { text: "x" }],
    [{ dimColor: true, text: "──" }],
  ]);
  assert.deepEqual(markdown("a **b\nc** d\n> *q\n> r*", 1), [
    [{ text: "a " }, { bold: true, text: "b" }],
    [{ bold: true, text: "c" }, { text: " d" }],
    [
      { dimColor: true, text: "│ " },
      { dimColor: true, italic: true, text: "q" },
    ],
    [
      { dimColor: true, text: "│ " },
      { dimColor: true, italic: true, text: "r" },
    ],
  ]);
  const rows = markdown("| a | bb |\n|---|---:|\n| ccc | d \\| |", 1);
  assert.deepEqual(
    rows.map((r) => r.map((s) => s.text).join("")),
    ["a   │  bb", "────┼────", "ccc │ d |"],
  );
});
