import assert from "node:assert/strict";
import { test } from "node:test";
import { Box, renderToString, Text } from "ink";
import { createStore } from "zustand/vanilla";
import { CliContext, type CliPlugin } from "./api.ts";
import { composeSlots } from "./app.tsx";
import type { Cli } from "./cli.ts";

// just enough of a Cli for the built-in status bar to render
const cli = {
  ui: createStore(() => ({
    session: createStore(() => ({ messages: [] })),
    entries: [],
    live: { thinking: "", text: "" },
    turn: [],
    busy: false,
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
