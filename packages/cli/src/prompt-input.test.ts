import assert from "node:assert/strict";
import { test } from "node:test";
import { moveRow, posAt } from "./prompt-input.tsx";

test("moveRow keeps the column across lines and wrapped rows, clamped to the row", () => {
  const lines = [..."hello\nhi\nworld"];
  assert.equal(moveRow(lines, 4, 80, 1), 8); // "hel|lo" ↓ → end of "hi"
  assert.equal(moveRow(lines, 8, 80, 1), 11); // "hi|" ↓ → "wo|rld"
  assert.equal(moveRow(lines, 11, 80, -1), 8); // back up → end of "hi"
  assert.equal(moveRow(lines, 2, 80, -1), undefined); // top row
  assert.equal(moveRow(lines, 12, 80, 1), undefined); // bottom row
  // "abcdefgh" at width 5 wraps to "abcde" / "fgh" (the caret's trailing space joins the last row)
  const long = [..."abcdefgh"];
  assert.equal(moveRow(long, 8, 5, -1), 3); // end of "fgh" ↑ → "abc|de"
  assert.equal(moveRow(long, 4, 5, 1), 8); // "abcd|e" ↓ → end of "fgh"
});

test("posAt maps a visual row and column to a code point, clamped to the row", () => {
  const lines = [..."hello\nhi"];
  assert.equal(posAt(lines, 0, 80, 0, 2), 2); // "he|llo"
  assert.equal(posAt(lines, 0, 80, 0, 50), 5); // past "hello": its end
  assert.equal(posAt(lines, 0, 80, 1, 1), 7); // "h|i"
  assert.equal(posAt([..."abcdefgh"], 0, 5, 1, 1), 6); // wrapped "fgh": "f|gh"
  assert.equal(posAt(lines, 0, 80, 9, 0), 6); // below: the last row
});
