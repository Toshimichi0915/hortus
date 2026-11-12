import assert from "node:assert/strict";
import { test } from "node:test";
import { theme } from "./entry.ts";
import stringWidth from "string-width";
import { cutCols, markdown, wrap, wrapSpans } from "./markdown.ts";

test("markdown strips markers into styled spans and keeps fenced code verbatim", () => {
  const md = "# Title\n- a **b _c_** `d` [e](http://x)\n```\n**raw**\n```\n> q\n---";
  assert.deepEqual(markdown(md, 3), [
    [{ color: theme.yellow, bold: true, text: "Title" }],
    [
      { color: theme.accent, text: "• " },
      { text: "a " },
      { bold: true, text: "b " },
      { bold: true, italic: true, text: "c" },
      { text: " " },
      { color: theme.accent, text: "d" },
      { text: " " },
      { color: theme.blue, underline: true, text: "e" },
      { color: theme.muted, text: " (http://x)" },
    ],
    [{ color: theme.muted, text: "```" }],
    [{ color: theme.green, text: "**raw**" }],
    [{ color: theme.muted, text: "```" }],
    [
      { color: theme.muted, text: "│ " },
      { color: theme.muted, text: "q" },
    ],
    [{ color: theme.muted, text: "───" }],
  ]);
  // snake_case and lone asterisks are not emphasis
  assert.deepEqual(markdown("a_b_c 2 * 3", 1), [[{ text: "a_b_c 2 * 3" }]]);
});

test("markdown renders setext headings, styles across lines and tables", () => {
  assert.deepEqual(markdown("Title\n===\n- x\n---", 2), [
    [{ color: theme.yellow, bold: true, text: "Title" }],
    [{ color: theme.accent, text: "• " }, { text: "x" }],
    [{ color: theme.muted, text: "──" }],
  ]);
  assert.deepEqual(markdown("a **b\nc** d\n> *q\n> r*", 1), [
    [{ text: "a " }, { bold: true, text: "b" }],
    [{ bold: true, text: "c" }, { text: " d" }],
    [
      { color: theme.muted, text: "│ " },
      { color: theme.muted, italic: true, text: "q" },
    ],
    [
      { color: theme.muted, text: "│ " },
      { color: theme.muted, italic: true, text: "r" },
    ],
  ]);
  const rows = markdown("| a | bb |\n|---|---:|\n| ccc | d \\| |", 80);
  assert.deepEqual(
    rows.map((r) => r.map((s) => s.text).join("")),
    ["a   │  bb", "────┼────", "ccc │ d |"],
  );
});

test("markdown shrinks a table wider than the pane and wraps its cells", () => {
  const rows = markdown("| a | long text here |\n|---|---|\n| b | x |", 10);
  assert.deepEqual(
    rows.map((r) => r.map((s) => s.text).join("")),
    ["a │ long  ", "  │ text  ", "  │ here  ", "──┼───────", "b │ x     "],
  );
});

test("wrapSpans splits styled spans into the rows wrap makes, as cutCols by columns would", () => {
  const spans = [{ text: "aaa " }, { text: "日本語", bold: true }, { text: "" }, { text: " bbb ccc", italic: true }];
  for (const width of [1, 3, 5, 7, 40]) {
    let col = 0;
    const expected = wrap(spans.map((s) => s.text).join(""), width).map((t) => {
      const from = col;
      col += stringWidth(t);
      return cutCols(spans, from, col);
    });
    assert.deepEqual(wrapSpans(spans, width), expected, `width ${width}`);
  }
  assert.deepEqual(wrapSpans([], 10), [[]]);
});
