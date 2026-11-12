import assert from "node:assert/strict";
import { test } from "node:test";
import { Box, renderToString, Text } from "ink";
import { createStore } from "zustand/vanilla";
import { CliContext, type CliPlugin } from "./api.ts";
import { composeSlots, composeTools } from "./app.tsx";
import type { Cli } from "./cli.ts";
import { linesRenderer, type ToolView } from "./tools.tsx";

// just enough of a Cli for the built-in status bar to render
const cli = {
  ui: createStore(() => ({
    session: createStore(() => ({ messages: [] })),
    entries: [],
    live: { thinking: "", text: "" },
    busy: false,
    statuses: {},
    asks: [],
    input: "",
    expanded: false,
    theme: "dark",
  })),
} as unknown as Cli;

const render = (plugins: CliPlugin[], onError: (text: string) => void = assert.fail) => {
  const { statusBar: Bar } = composeSlots(plugins, onError);
  return renderToString(
    <CliContext value={cli}>
      <Bar />
    </CliContext>,
  ).split("\n");
};

const wrap = (name: string): CliPlugin => ({
  cli: {
    statusBar: ({ Default }) => (
      <Box flexDirection="column">
        <Text>{name}</Text>
        <Default />
      </Box>
    ),
  },
});

test("composeSlots wraps overrides in load order, each around the one it replaces", () => {
  const [b, a, builtin] = render([wrap("a"), {}, wrap("b")]);
  assert.deepEqual([b, a], ["b", "a"]);
  assert.match(builtin ?? "", /↑ 0\.0K ↓ 0\.0K/);
});

test("a throwing override falls back to the one it replaced and reports why", () => {
  const errors: string[] = [];
  const boom: CliPlugin = {
    cli: {
      statusBar: () => {
        throw new Error("boom");
      },
    },
  };
  assert.deepEqual(render([wrap("a"), boom], (e) => errors.push(e)).slice(0, 1), ["a"]);
  assert.deepEqual(errors, ["statusBar plugin failed, showing the one it replaced: boom"]);
});

const view = (name: string): ToolView => ({ call: { id: "1", name, input: { command: "ls" } }, width: 30 });
const draw = (tools: ReturnType<typeof composeTools>, v: ToolView) => {
  const { Render } = tools(v.call.name);
  return renderToString(
    <CliContext value={cli}>
      <Render {...v} />
    </CliContext>,
    { columns: v.width },
  );
};
// a component renderer adding a line above the one it replaced, without `text`
const above = (line: string): CliPlugin => ({
  cli: {
    tools: {
      bash: {
        // biome-ignore lint/correctness/noComponentHookFactories: one renderer per plugin, made once per test
        Render: ({ Default, ...v }) => (
          <Box flexDirection="column">
            <Text>{line}</Text>
            <Default {...v} />
          </Box>
        ),
      },
    },
  },
});

test("composeTools wraps a tool's built-in renderer in load order, and copies a renderer without text as it draws", () => {
  const tools = composeTools([above("a"), {}, above("b")], cli, assert.fail);
  assert.equal(draw(tools, view("bash")), "b\na\n$ ls");
  assert.equal(tools("bash").text(view("bash")), "b\na\n$ ls");
  // other tools keep their own renderer; one without any gets the generic one
  assert.equal(tools("read").text(view("read")), "read ");
  assert.equal(draw(tools, view("mcp__x__y")), 'mcp__x__y {"command":"ls"}');
  // a renderer's own text is used as is
  const own = linesRenderer(() => [[{ text: "drawn" }]]);
  const withText = composeTools([{ cli: { tools: { bash: { ...own, text: () => "copied" } } } }], cli, assert.fail);
  assert.equal(withText("bash").text(view("bash")), "copied");
  // a wrapper's text gets the one it replaced, e.g. to pass it a changed view
  const changed = composeTools(
    [
      {
        cli: {
          tools: {
            bash: { ...own, text: (v, Default) => Default({ ...v, call: { ...v.call, input: { command: "pwd" } } }) },
          },
        },
      },
    ],
    cli,
    assert.fail,
  );
  assert.equal(changed("bash").text(view("bash")), "$ pwd");
});

const throwingTool: CliPlugin = {
  cli: {
    tools: {
      bash: {
        Render: () => {
          throw new Error("boom");
        },
        text: () => {
          throw new Error("boom");
        },
      },
    },
  },
};

test("a throwing tool renderer falls back to the one it replaced, reported once however many blocks use it", () => {
  const errors: string[] = [];
  const tools = composeTools([above("a"), throwingTool], cli, (e) => errors.push(e));
  assert.equal(draw(tools, view("bash")), "a\n$ ls");
  assert.equal(draw(tools, view("bash")), "a\n$ ls");
  assert.equal(tools("bash").text(view("bash")), "a\n$ ls");
  assert.deepEqual(errors, ["bash renderer failed, showing the one it replaced: boom"]);
});
