import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Agent, listSessions, openSession } from "@hortus/core";
import { type Cli, createCli } from "./cli.ts";
import { builtinCommands, type Command, findCommand, parseCommand } from "./commands.ts";

// like agent.resolve with an empty config whose defaults are p0/m0, and no key for "nokey"
const resolve = async ({ model = "m0", provider = "p0" }: { model?: string; provider?: string }) => {
  if (provider === "nokey") throw new Error("No API key for nokey. Add it to ~/.hortus/secrets.json");
  return { name: provider, model, provider: {} };
};

/** The transcript's last entry as "kind: text". */
const last = (cli: Cli) => {
  const e = cli.ui.getState().entries.at(-1);
  return `${e?.kind}: ${e?.text}`;
};

/** Submits `value` and returns the transcript's last entry once it's done. */
async function send(cli: Cli, value: string) {
  assert.equal(cli.submit(value), true);
  await sleep(20);
  return last(cli);
}

test("parseCommand splits one line into a name and, once a space follows it, an argument", () => {
  assert.deepEqual(parseCommand("/"), { name: "", arg: undefined });
  assert.deepEqual(parseCommand("/mo"), { name: "mo", arg: undefined });
  assert.deepEqual(parseCommand("/model "), { name: "model", arg: "" });
  assert.deepEqual(parseCommand("/model a b"), { name: "model", arg: "a b" });
  assert.equal(parseCommand("/model a\nb"), null);
  assert.equal(parseCommand("hi /model"), null);
  assert.equal(parseCommand("/etc/hosts is odd"), null);
});

test("/model sets the session's provider and model, which status follows; a rejected one changes nothing", async () => {
  const session = await openSession(null, await mkdtemp(join(tmpdir(), "hortus-")));
  const cli = await createCli(session, async () => ({ plugins: [], resolve }) as unknown as Agent);
  await sleep(10);
  assert.equal(await send(cli, "/model"), "info: Model: p0/m0");
  assert.equal(
    await send(cli, "/model ollama-cloud/deepseek-v4.1-flash:1017"),
    "info: Model set to ollama-cloud/deepseek-v4.1-flash:1017",
  );
  assert.deepEqual(session.getState(), { messages: [], provider: "ollama-cloud", model: "deepseek-v4.1-flash:1017" });
  // one entry holds both
  assert.equal((await readFile(session.path, "utf8")).trim().split("\n").length, 1);
  assert.equal(await send(cli, "/model"), "info: Model: ollama-cloud/deepseek-v4.1-flash:1017");
  // only the first "/" ends the provider
  assert.equal(
    await send(cli, "/model openrouter/anthropic/claude-x"),
    "info: Model set to openrouter/anthropic/claude-x",
  );
  const state = { messages: [], provider: "openrouter", model: "anthropic/claude-x" };
  assert.deepEqual(session.getState(), state);
  assert.equal(await send(cli, "/model nokey/m"), "error: No API key for nokey. Add it to ~/.hortus/secrets.json");
  assert.equal(await send(cli, "/model foo"), "error: Usage: /model <provider>/<model>");
  assert.deepEqual(session.getState(), state);
});

test("/model offers every provider's models, listed afresh each time", async () => {
  let calls = 0;
  const listModels = async () => {
    calls++;
    return [
      { provider: "ollama-cloud", id: "deepseek-v4.1-flash:1017" },
      { provider: "openrouter", id: "anthropic/claude-x" },
    ];
  };
  const cli = { agent: { listModels } } as unknown as Cli;
  const model = findCommand(builtinCommands, "model");
  const candidates = [
    { value: "ollama-cloud/deepseek-v4.1-flash:1017", label: "deepseek-v4.1-flash:1017", description: "ollama-cloud" },
    { value: "openrouter/anthropic/claude-x", label: "anthropic/claude-x", description: "openrouter" },
  ];
  assert.deepEqual(await model?.complete?.(cli), candidates);
  assert.deepEqual(await model?.complete?.(cli), candidates);
  assert.equal(calls, 2);
});

test("/new and /clear show a new session next to the old one, with config defaults, and later turns go to it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hortus-"));
  const old = await openSession(null, dir);
  await old.setModel("m1");
  await old.append([{ role: "user", content: "old" }]);
  const cli = await createCli(old, async () => ({ plugins: [], resolve, run: async () => {} }) as unknown as Agent);
  await sleep(10);
  assert.equal(cli.ui.getState().status?.model, "m1");
  for (const name of ["/new", "/clear"]) {
    const prev = cli.session;
    await send(cli, name);
    assert.notEqual(cli.session.path, prev.path);
    assert.equal(dirname(cli.session.path), dir);
    assert.deepEqual(
      cli.ui.getState().entries.map((e) => e.text),
      [`Session: ${cli.session.path} (0 messages)`],
    );
  }
  assert.equal(cli.ui.getState().status?.model, "m0");
  await send(cli, "hi");
  assert.deepEqual(cli.session.getState().messages, [{ role: "user", content: "hi" }]);
  assert.deepEqual(old.getState().messages, [{ role: "user", content: "old" }]);
});

test("/resume shows another session next to the shown one at its last entry, the latest by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hortus-"));
  const shown = await openSession(null, dir);
  const cli = await createCli(shown, async () => ({ plugins: [], resolve, run: async () => {} }) as unknown as Agent);
  assert.equal(await send(cli, "/resume"), "error: No sessions to resume");
  const old = await openSession(null, dir);
  await old.setModel("m1");
  await old.append([{ role: "user", content: "old\n  one" }]);
  await shown.append([{ role: "user", content: "shown" }]);
  const ids = new Map((await listSessions(dir)).map((s) => [s.path, s.id]));
  // not the shown one
  const candidates = (await findCommand(cli.commands, "resume")?.complete?.(cli)) ?? [];
  assert.deepEqual(
    candidates.map((c) => c.value),
    [ids.get(old.path)],
  );
  assert.match(candidates[0]?.label ?? "", /^\d{4}-\d\d-\d\d \d\d:\d\d {2}old one$/);
  await send(cli, "/resume");
  assert.deepEqual(
    cli.ui.getState().entries.map((e) => e.text),
    [`Session: ${old.path} (1 messages) · model: m1`, "\nold\n  one\n"],
  );
  await send(cli, `/resume ${ids.get(shown.path)}`);
  assert.equal(cli.session.path, shown.path);
  assert.equal(await send(cli, "/resume nope"), "error: Session not found: nope");
});

test("plugin commands run with their argument and replace built-ins by name; unknown names stay in the prompt", async () => {
  const session = await openSession(null, await mkdtemp(join(tmpdir(), "hortus-")));
  const commands: Command[] = [
    {
      name: "echo",
      description: "",
      run: async (arg) => {
        await sleep(10);
        return `echo ${arg}`;
      },
    },
    {
      name: "fail",
      description: "",
      run: () => {
        throw new Error("boom");
      },
    },
    { name: "model", description: "", run: () => "plugin model" },
  ];
  const plugins = [{ cli: { commands } }];
  const cli = await createCli(session, async () => ({ plugins, resolve }) as unknown as Agent);
  assert.deepEqual(
    cli.commands.map((c) => c.name),
    ["new", "model", "effort", "resume", "echo", "fail"],
  );
  assert.equal(await send(cli, "/echo  a b"), "info: echo a b");
  assert.equal(await send(cli, "/fail"), "error: boom");
  assert.equal(await send(cli, "/model x/y"), "info: plugin model");
  assert.equal(cli.submit("/nope x"), false);
  assert.equal(last(cli), "error: Unknown command: /nope");
});

test("a command can start a turn, and the session isn't swapped while one runs", async () => {
  const session = await openSession(null, await mkdtemp(join(tmpdir(), "hortus-")));
  const commands: Command[] = [{ name: "review", description: "", run: (_, cli) => void cli.submit("review this") }];
  const plugins = [{ cli: { commands } }];
  const cli = await createCli(session, async () => ({ plugins, resolve, run: () => sleep(40) }) as unknown as Agent);
  assert.equal(cli.submit("/review"), true);
  await sleep(10);
  assert.equal(cli.ui.getState().busy, true);
  assert.throws(() => cli.setSession(session), /while a turn is running/);
  await sleep(50);
  assert.deepEqual(session.getState().messages, [{ role: "user", content: "review this" }]);
});
