import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyEdits, bashTool, editTool, readTool, truncate } from "./tools.ts";

const bom = String.fromCharCode(0xfeff);
const run = (t: { execute: (input: never) => Promise<unknown> }, input: unknown) => t.execute(input as never);

test("applyEdits matches exactly, rejects missing/duplicate/overlapping, falls back to fuzzy", () => {
  assert.equal(
    applyEdits(
      "a\nb\nc\n",
      [
        { oldText: "b", newText: "B" },
        { oldText: "c", newText: "C" },
      ],
      "f",
    ),
    "a\nB\nC\n",
  );
  assert.throws(() => applyEdits("x", [{ oldText: "y", newText: "" }], "f"), /Could not find the exact text/);
  assert.throws(() => applyEdits("x x", [{ oldText: "x", newText: "y" }], "f"), /Found 2 occurrences/);
  assert.throws(
    () =>
      applyEdits(
        "abc",
        [
          { oldText: "ab", newText: "" },
          { oldText: "bc", newText: "" },
        ],
        "f",
      ),
    /overlap/,
  );
  assert.throws(() => applyEdits("x", [{ oldText: "x", newText: "x" }], "f"), /No changes made/);
  // trailing spaces and smart quotes ignored; untouched lines keep their trailing whitespace
  assert.equal(
    applyEdits("keep  \nsay “hi”  \nkeep2  ", [{ oldText: 'say "hi"', newText: "bye" }], "f"),
    "keep  \nbye\nkeep2  ",
  );
  // a fuzzy edit doesn't normalize the lines of exact edits
  assert.equal(
    applyEdits(
      'a = "（注）—１"\nb = “x”\nc = 1\n',
      [
        { oldText: "a", newText: "A" },
        { oldText: 'b = "x"', newText: 'b = "y"' },
        { oldText: "c = ", newText: "C = " },
      ],
      "f",
    ),
    'A = "（注）—１"\nb = "y"\nC = 1\n',
  );
});

test("truncate keeps head or tail within the line limit", () => {
  const text = Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join("\n");
  const head = truncate(text);
  assert.equal(head.shown, 2000);
  assert.ok(head.content.startsWith("l1\n") && head.content.endsWith("l2000"));
  assert.ok(truncate(text, true).content.startsWith("l501\n"));
  assert.equal(truncate("a\nb\n").truncated, false);
});

test("read pages with offset/limit; edit keeps CRLF and BOM; bash reports exit codes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hortus-"));
  const f = join(dir, "f.txt");
  await writeFile(f, "1\n2\n3\n4");
  assert.equal(
    await run(readTool, { path: f, offset: 2, limit: 2 }),
    "2\n3\n[1 more lines in file. Use offset=4 to continue.]",
  );
  await assert.rejects(run(readTool, { path: f, offset: 9 }), /beyond end of file/);

  await writeFile(f, `${bom}a\r\nb\r\n`);
  await run(editTool, { path: f, edits: [{ oldText: "a\nb", newText: "x\ny" }] });
  assert.equal(await readFile(f, "utf8"), `${bom}x\r\ny\r\n`);

  assert.equal(await run(bashTool, { command: "echo hi; echo err >&2" }), "hi\nerr\n");
  await assert.rejects(run(bashTool, { command: "echo out; exit 3" }), /out\n\nCommand exited with code 3/);
  await assert.rejects(run(bashTool, { command: "sleep 5", timeout: 0.2 }), /timed out after 0.2 seconds/);
});
