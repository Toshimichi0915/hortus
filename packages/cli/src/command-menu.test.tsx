import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Candidate, Command } from "./commands.ts";

// colors (and so inverse) are off when stdout isn't a terminal; forced before ink loads chalk
process.env.FORCE_COLOR = "1";
const { renderToString } = await import("ink");
const { CommandMenu, suggest } = await import("./command-menu.tsx");

const run = () => {};
const model: Command = { name: "model", args: "[provider/model]", description: "Switch the model", run };
const commands: Command[] = [
  model,
  { name: "provider", args: "<name>", description: "Switch the provider", run },
  { name: "new", aliases: ["clear"], description: "Start a new session", run },
  { name: "resume", description: "Resume a session", run },
  { name: "theme", description: "Pick a theme", complete: () => [], run },
];
const models: Candidate[] = [
  { value: "openai/gpt-5", label: "gpt-5", description: "openai" },
  {
    value: "ollama-cloud/deepseek-v4.1-flash:1017-thinking",
    label: "deepseek-v4.1-flash:1017-thinking",
    description: "ollama-cloud",
  },
  { value: "ollama-cloud/deepseek-v4.1-flash:1017", label: "deepseek-v4.1-flash:1017", description: "ollama-cloud" },
  { value: "ollama-cloud/gpt-oss:120b" },
];
model.complete = () => models;
const loaded = new Map([[model, models]]);
const values = (input: string) => suggest(commands, input, loaded)?.map((s) => s.value);

test("names: substring of a name or alias, ignoring case, best rank first, then alphabetical", () => {
  // canonical names; one with an argument leaves room to type it
  assert.deepEqual(values("/"), ["/model ", "/new", "/provider ", "/resume", "/theme "]);
  assert.deepEqual(suggest(commands, "/mod", loaded)?.[0], {
    label: "/model [provider/model]",
    description: "Switch the model",
    value: "/model ",
  });
  // the alias that matched is what's shown and filled
  assert.deepEqual(suggest(commands, "/cl", loaded), [
    { label: "/clear", description: "Start a new session", value: "/clear" },
  ]);
  // prefix before substring
  assert.deepEqual(values("/R"), ["/resume", "/clear", "/provider "]);
  assert.deepEqual(values("/new"), ["/new"]);
  assert.deepEqual(values("/nope"), []);
  // an alias another command is named after runs that one, so only it shows
  const clear: Command = { name: "clear", description: "Clear the screen", run };
  assert.deepEqual(suggest([...commands, clear], "/cl", loaded), [
    { label: "/clear", description: "Clear the screen", value: "/clear" },
  ]);
});

test("arguments: the command's candidates containing what's typed, filled in as the whole input", () => {
  const deepseek = suggest(commands, "/model deepseek", loaded);
  assert.deepEqual(deepseek?.[1], {
    label: "deepseek-v4.1-flash:1017",
    description: "ollama-cloud",
    value: "/model ollama-cloud/deepseek-v4.1-flash:1017",
  });
  assert.equal(deepseek?.length, 2);
  // an exact match goes first, so Enter on a filled value submits it
  assert.deepEqual(values("/model ollama-cloud/deepseek-v4.1-flash:1017"), [
    "/model ollama-cloud/deepseek-v4.1-flash:1017",
    "/model ollama-cloud/deepseek-v4.1-flash:1017-thinking",
  ]);
  // complete's order within a rank; the label defaults to the value
  assert.deepEqual(values("/model GPT"), ["/model openai/gpt-5", "/model ollama-cloud/gpt-oss:120b"]);
  assert.equal(suggest(commands, "/model gpt-oss", loaded)?.[0]?.label, "ollama-cloud/gpt-oss:120b");
  assert.equal(values("/model ")?.length, 4);
  // the label counts too: a model named m0 ranks above models whose provider merely has an m
  const named = new Map([[model, [{ value: "ollama-cloud/x" }, { value: "other/m0", label: "m0" }]]]);
  assert.deepEqual(
    suggest(commands, "/model m", named)?.map((s) => s.value),
    ["/model other/m0", "/model ollama-cloud/x"],
  );
  // but an exact value beats a label equal to it, so Enter on a filled value submits rather than refilling
  const routed = new Map([
    [
      model,
      [
        { value: "openrouter/openai/gpt-5", label: "openai/gpt-5" },
        { value: "openai/gpt-5", label: "gpt-5" },
      ],
    ],
  ]);
  assert.equal(suggest(commands, "/model openai/gpt-5", routed)?.[0]?.value, "/model openai/gpt-5");
  assert.equal(suggest(commands, "/model gpt-5", routed)?.[0]?.value, "/model openai/gpt-5");
});

test("no rows without a one-line command whose candidates exist; undefined while they load", () => {
  assert.equal(suggest(commands, "/model deep", new Map()), undefined);
  for (const input of ["", "hi /model", "/model deepseek\n", "/model\ndeepseek", "/new now", "/nope x"])
    assert.deepEqual(suggest(commands, input, loaded), [], input);
});

test("the menu shows five rows around the inverse selection, descriptions in a column, Loading… until known", () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ label: `/${"c".repeat(i + 1)}`, description: "d", value: "" }));
  const lines = renderToString(<CommandMenu rows={rows} at={5} />).split("\n");
  const text = lines.map((l) => stripVTControlCharacters(l).trim());
  assert.deepEqual(
    text.map((t) => t.split(" ")[0]),
    ["/ccc", "/cccc", "/ccccc", "/cccccc", "/ccccccc"],
  );
  assert.deepEqual(new Set(text.map((t) => t.indexOf("d"))), new Set([10]));
  assert.deepEqual(
    lines.map((l) => l.includes("\x1b[7m")),
    [false, false, false, true, false],
  );
  assert.equal(stripVTControlCharacters(renderToString(<CommandMenu rows={undefined} at={0} />)).trim(), "Loading…");
});
