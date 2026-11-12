import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString, Text } from "ink";
import { isValidElement, type ReactNode } from "react";
import { theme } from "./entry.ts";
import { builtinTools, genericTool, type ToolBlock, type ToolView } from "./tools.tsx";

const tool = (name: string) => builtinTools[name] ?? genericTool;
const text = (view: ToolView) => tool(view.call.name).text(view);
const drawn = (view: ToolView) => {
  const { Render } = tool(view.call.name);
  return renderToString(<Render {...view} />, { columns: view.width });
};

test("built-in blocks show a pi-style header and a tail/head preview", () => {
  const bash = { id: "1", name: "bash", input: { command: "seq 8" } };
  assert.equal(text({ call: bash, width: 40 }), "$ seq 8");
  assert.equal(
    text({ call: bash, result: { id: "1", output: "1\n2\n3\n4\n5\n6\n7\n8\n" }, width: 40 }),
    "$ seq 8\n\n... (3 earlier lines)\n4\n5\n6\n7\n8",
  );
  // while running: the live output builtin:bash streams, without colour codes
  assert.equal(text({ call: bash, details: { output: "\x1b[32m1\x1b[0m\n2\n" }, width: 40 }), "$ seq 8\n\n1\n2");
  // a progress bar shows its last state, \r\n ends a line, and other control characters are dropped, live or finished
  const bar = "10%\r50%\r100%\r\nok\x07\bx\r\n";
  assert.equal(text({ call: bash, details: { output: bar }, width: 40 }), "$ seq 8\n\n100%\nokx");
  assert.equal(text({ call: bash, result: { id: "1", output: bar }, width: 40 }), "$ seq 8\n\n100%\nokx");
  const read = { id: "2", name: "read", input: { path: "a.ts", offset: 5, limit: 3 } };
  assert.equal(text({ call: read, result: { id: "2", output: "x" }, width: 40 }).split("\n")[0], "read a.ts:5-7");
  const edit = { id: "3", name: "edit", input: { path: "b.ts", edits: [{ oldText: "a", newText: "b" }] } };
  assert.equal(text({ call: edit, width: 40 }), "edit b.ts\n\n- a\n+ b");
  const other = { id: "4", name: "mcp__s__t", input: { q: 1 } };
  assert.equal(text({ call: other, result: { id: "4", output: "out" }, width: 40 }), 'mcp__s__t {"q":1}\n\nout');
});

// Ink drops a drawn line's trailing spaces (and so does copying, see `blockLines`)
const trimmed = (s: string) => s.replace(/ +$/gm, "");

test("a built-in block's text is exactly what it draws, wrapped lines and wide characters included", () => {
  const views: ToolView[] = [
    { call: { id: "1", name: "bash", input: { command: "echo the quick brown fox jumps over" } }, width: 12 },
    {
      call: { id: "2", name: "read", input: { path: "日本語のファイル名.ts" } },
      result: { id: "2", output: "x" },
      width: 9,
    },
    { call: { id: "3", name: "write", input: { path: "a", content: "averyveryverylongword\n\nend" } }, width: 7 },
  ];
  for (const view of views) {
    assert.ok(text(view).split("\n").length > 2, "the case wraps");
    assert.equal(drawn(view), trimmed(text(view)));
  }
});

/** [text, color] of every leaf `<Text>` an element tree renders, calling hortus's own components on the way. */
function spans(node: ReactNode): [string, string | undefined][] {
  if (!isValidElement<{ children?: ReactNode; color?: string }>(node)) return [];
  const { type, props } = node;
  if (type === Text && typeof props.children === "string")
    return props.children.trim() ? [[props.children, props.color]] : [];
  if (typeof type === "function" && type !== Text) return spans((type as (p: unknown) => ReactNode)(props));
  return [props.children].flat(Number.POSITIVE_INFINITY).flatMap((c) => spans(c as ReactNode));
}

test("edit blocks color removed lines red and added lines green", () => {
  const { Render } = builtinTools.edit as ToolBlock;
  const call = { id: "1", name: "edit", input: { path: "a", edits: [{ oldText: "x", newText: "y" }] } };
  assert.deepEqual(spans(<Render call={call} width={20} />), [
    ["edit a", theme.text],
    ["- x", theme.red],
    ["+ y", theme.green],
  ]);
});
