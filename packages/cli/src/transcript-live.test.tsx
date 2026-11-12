import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Box, type DOMElement, render, Text, useBoxMetrics } from "ink";
import { useRef, useState } from "react";
import { type Entry, toolEntry } from "./entry.ts";
import { builtinTools, genericTool, type ToolBlock } from "./tools.tsx";
import { Transcript } from "./transcript.tsx";

/** A terminal for Ink: keys written to `stdin`, and the last frame drawn (debug mode draws whole frames). */
function terminal(columns: number, rows: number) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  const stdout = Object.assign(
    new Writable({
      write: (chunk, _enc, done) => {
        frame = String(chunk);
        done();
      },
    }),
    { columns, rows, isTTY: true },
  );
  return { stdin, stdout, frame: () => frame.split("\n").map((l) => l.trimEnd()) };
}

let mounts = 0;
/** each counter block's laid-out height, by its `n`: 0 while it's hidden (Ink neither lays out nor draws it) */
const laidOut = new Map<number, number>();
// a block holding state of its own: mounted once, it keeps its count; remounted, it would count again
const counter: ToolBlock = {
  Render: ({ call }) => {
    const [n] = useState(() => ++mounts);
    const ref = useRef<DOMElement>(null);
    const { height } = useBoxMetrics(ref);
    const i = (call.input as { n: number }).n;
    laidOut.set(i, height);
    return (
      <Box ref={ref}>
        <Text>{`counter ${i} mount ${n}`}</Text>
      </Box>
    );
  },
  text: ({ call }) => `counter ${String((call.input as { n: number }).n)}`,
};
const tools = (name: string) => (name === "counter" ? counter : (builtinTools[name] ?? genericTool));

/** Retries `check` (assertions) until it passes, or rethrows its last failure after `ms`: Ink draws asynchronously. */
async function until(check: () => void, ms = 3000) {
  for (const end = Date.now() + ms; ; await sleep(10))
    try {
      return check();
    } catch (e) {
      if (Date.now() > end) throw e;
    }
}

test("blocks off screen stay mounted, and the pane scrolls over their measured heights", async () => {
  // 20 blocks of 5 rows (background, header, blank, output, background) or 3 (background, line, background)
  const entries: Entry[] = Array.from({ length: 20 }, (_, i) =>
    i % 2
      ? toolEntry({ id: `${i}`, name: "counter", input: { n: i } }, { id: `${i}`, output: "" })
      : toolEntry({ id: `${i}`, name: "bash", input: { command: `echo ${i}` } }, { id: `${i}`, output: `${i}` }),
  );
  const term = terminal(40, 12);
  const app = render(
    <Box height={12} flexDirection="column">
      <Transcript entries={entries} tools={tools} onWheelBelow={() => {}} onCopy={() => {}} />
    </Box>,
    { stdin: term.stdin as never, stdout: term.stdout as never, debug: true, patchConsole: false },
  );
  try {
    // follows the bottom: the last block (19, a counter) ends the pane; above it the gap row and block 18
    await until(() => {
      assert.deepEqual(term.frame().slice(-8), ["$ echo 18", "", "18", "", "", "", "counter 19 mount 10", ""]);
      assert.equal(laidOut.get(19), 1);
      assert.equal(laidOut.get(1), 0, "a block off screen is hidden");
    });
    assert.equal(mounts, 10, "every counter block mounted once");

    // to the top, half a pane per PageUp; the rows add up, so it lands exactly on the first block
    term.stdin.write("\x1b[5~".repeat(30));
    await until(() => {
      assert.deepEqual(term.frame().slice(0, 6), ["", "$ echo 0", "", "0", "", ""]);
      assert.equal(term.frame()[7], "counter 1 mount 1", "the first counter block wasn't remounted");
      assert.deepEqual([laidOut.get(1), laidOut.get(19)], [1, 0]);
    });
    assert.equal(mounts, 10);
  } finally {
    app.unmount();
  }
});

test("a block that grows when its result arrives is measured again, so the pane still ends at its last row", async () => {
  const call = { id: "1", name: "bash", input: { command: "seq 3" } };
  const filler = Array.from({ length: 5 }, (_, i) =>
    toolEntry({ id: `f${i}`, name: "bash", input: { command: "true" } }),
  );
  const term = terminal(40, 8);
  const view = (entries: Entry[]) => (
    <Box height={8} flexDirection="column">
      <Transcript entries={entries} tools={tools} onWheelBelow={() => {}} onCopy={() => {}} />
    </Box>
  );
  const running = toolEntry(call);
  const app = render(view([...filler, running]), {
    stdin: term.stdin as never,
    stdout: term.stdout as never,
    debug: true,
    patchConsole: false,
  });
  try {
    await until(() => assert.deepEqual(term.frame().slice(-3), ["", "$ seq 3", ""]));
    // the same entry (same id) with its result, as cli.ts replaces it
    app.rerender(view([...filler, { ...running, result: { id: "1", output: "1\n2\n3\n" } }]));
    await until(() => assert.deepEqual(term.frame().slice(-7), ["", "$ seq 3", "", "1", "2", "3", ""]));
  } finally {
    app.unmount();
  }
});
