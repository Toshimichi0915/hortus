import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Agent,
  type AgentCommand,
  type Command,
  type Ctx,
  createAgent,
  type LoadOptions,
  listSessions,
  type Named,
  openSession,
  type Session,
} from "@hortus/core";
import { scripted, tempDir, tempHome, until } from "@hortus/core/testing";
import { cliOf } from "./api.ts";
import { cliPieces } from "./builtin/index.ts";
import { type Cli, createCli } from "./cli.ts";
import { findCommand, parseCommand } from "./commands.ts";

// the CLI's own commands, as an agent loaded with them lists its plugins
const plugins = cliPieces.map(({ name, plugin }) => ({ name, plugin }));
const builtinCommands = cliPieces.flatMap((p) => (p.plugin.commands as Command[] | undefined) ?? []);

/** `plugins`' commands as `agent.commands()` lists them, each run with a ctx of `ctx()`'s */
const bound = (plugins: Named[], ctx: () => Ctx): AgentCommand[] => [
  ...new Map(
    plugins.flatMap(({ name, plugin }) =>
      ((plugin.commands as Command[] | undefined) ?? []).map((c): [string, AgentCommand] => [
        c.name,
        {
          ...c,
          plugin: name,
          run: async (arg) => (await c.run(arg, ctx())) || undefined,
          complete: c.complete && (async () => (c.complete as NonNullable<Command["complete"]>)(ctx())),
        },
      ]),
    ),
  ).values(),
];

// like agent.resolve with an empty config whose defaults are p0/m0, and no key for "nokey"
const resolve = async ({ model = "m0", provider = "p0" }: { model?: string; provider?: string }) => {
  if (provider === "nokey") throw new Error("No API key for nokey. Add it to ~/.hortus/secrets.json");
  return { name: provider, model, provider: {} };
};

/**
 * A stand-in agent with the CLI's commands as plugins (plus `fields`): like core, it keeps the current session, and a
 * run with input appends it there and announces it to the CLI's observer, then waits `delay` ms.
 */
function fakeAgent(o: LoadOptions, fields: { plugins?: Named[]; ctx?: unknown } = {}, delay = 0) {
  let current: Session | undefined;
  const observer = o.extra?.[0]?.plugin;
  // like the host ctx: the TUI as its host, on the current session
  const ctx = () =>
    ({
      host: o.host,
      session: current,
      resolve: async (r: { model?: string; provider?: string } = {}) => {
        const s = current?.getState();
        const t = await resolve({ model: r.model ?? s?.model, provider: r.provider ?? s?.provider });
        return { provider: t.name, model: t.model, type: "fake", info: {} };
      },
    }) as unknown as Ctx;
  return {
    plugins,
    commands: () => bound(fields.plugins ?? plugins, ctx),
    resolve,
    setSession: async (s: Session) => {
      current = s;
      return true;
    },
    session: () => current,
    run: async (input?: string) => {
      if (input === undefined || !current) return undefined;
      const [m] = await current.append([{ role: "user", content: input }]);
      if (m) await observer?.on?.message?.(m, { session: current } as Ctx);
      await sleep(delay);
      return { source: "run", messages: [] };
    },
    // no plugin lists skills
    ctx: { emit: async () => {} },
    ...fields,
  } as unknown as Agent;
}

/** A session's user messages' texts. */
const texts = (s: Session) => s.getState().messages.map((m) => (m.role === "user" ? m.content : m.role));

/** The transcript's last entry as "kind: text". */
const last = (cli: Cli) => {
  const e = cli.ui.getState().entries.at(-1);
  return `${e?.kind}: ${e?.kind === "tool" ? e.call.name : e?.text}`;
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

test("/model sets the session's provider and model, which status follows; a rejected one changes nothing", async (t) => {
  const session = await openSession(null, await tempDir(t, "hortus-"));
  const cli = await createCli(session, async (o) => fakeAgent(o));
  await sleep(10);
  assert.equal(await send(cli, "/model"), "info: Model: p0/m0");
  assert.equal(
    await send(cli, "/model ollama-cloud/deepseek-v4.1-flash:1017"),
    "info: Model set to ollama-cloud/deepseek-v4.1-flash:1017",
  );
  const settings = () => {
    const { model, provider } = session.getState();
    return { model, provider };
  };
  assert.deepEqual(settings(), { provider: "ollama-cloud", model: "deepseek-v4.1-flash:1017" });
  // one entry holds both
  assert.equal((await readFile(session.path ?? "", "utf8")).trim().split("\n").length, 1);
  assert.equal(await send(cli, "/model"), "info: Model: ollama-cloud/deepseek-v4.1-flash:1017");
  // only the first "/" ends the provider
  assert.equal(
    await send(cli, "/model openrouter/anthropic/claude-x"),
    "info: Model set to openrouter/anthropic/claude-x",
  );
  const state = { provider: "openrouter", model: "anthropic/claude-x" };
  assert.deepEqual(settings(), state);
  assert.equal(await send(cli, "/model nokey/m"), "error: No API key for nokey. Add it to ~/.hortus/secrets.json");
  assert.equal(await send(cli, "/model foo"), "error: Usage: /model <provider>/<model>");
  assert.deepEqual(settings(), state);
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
  const ctx = { listModels } as unknown as Ctx;
  const model = findCommand(builtinCommands, "model");
  const candidates = [
    { value: "ollama-cloud/deepseek-v4.1-flash:1017", label: "deepseek-v4.1-flash:1017", description: "ollama-cloud" },
    { value: "openrouter/anthropic/claude-x", label: "anthropic/claude-x", description: "openrouter" },
  ];
  assert.deepEqual(await model?.complete?.(ctx), candidates);
  assert.deepEqual(await model?.complete?.(ctx), candidates);
  assert.equal(calls, 2);
});

test("/new and /clear show a new session next to the old one, with config defaults, and later turns go to it", async (t) => {
  const dir = await tempDir(t, "hortus-");
  const old = await openSession(null, dir);
  await old.setModel("m1");
  await old.append([{ role: "user", content: "old" }]);
  const cli = await createCli(old, async (o) => fakeAgent(o));
  await until(() => cli.ui.getState().status?.model === "m1", 5000);
  for (const name of ["/new", "/clear"]) {
    const prev = cli.session;
    await send(cli, name);
    assert.notEqual(cli.session.path, prev.path);
    assert.equal(dirname(cli.session.path ?? ""), dir);
    assert.deepEqual(
      cli.ui.getState().entries.map((e) => (e.kind === "tool" ? e.call.name : e.text)),
      [`Session: ${cli.session.path} (0 messages)`],
    );
  }
  assert.equal(cli.ui.getState().status?.model, "m0");
  await send(cli, "hi");
  assert.deepEqual(texts(cli.session), ["hi"]);
  assert.deepEqual(texts(old), ["old"]);
});

test("/resume shows another session next to the shown one at its last entry, the latest by default", async (t) => {
  const dir = await tempDir(t, "hortus-");
  const shown = await openSession(null, dir);
  const cli = await createCli(shown, async (o) => fakeAgent(o));
  assert.equal(await send(cli, "/resume"), "error: No sessions to resume");
  const old = await openSession(null, dir);
  await old.setModel("m1");
  await old.append([{ role: "user", content: "old\n  one" }]);
  await shown.append([{ role: "user", content: "shown" }]);
  const ids = new Map((await listSessions(dir)).map((s) => [s.path, s.id]));
  // not the shown one
  const candidates = (await findCommand(cli.commands, "resume")?.complete?.()) ?? [];
  assert.deepEqual(
    candidates.map((c) => c.value),
    [ids.get(old.path ?? "")],
  );
  assert.match(candidates[0]?.label ?? "", /^\d{4}-\d\d-\d\d \d\d:\d\d {2}old one$/);
  await send(cli, "/resume");
  assert.deepEqual(
    cli.ui.getState().entries.map((e) => (e.kind === "tool" ? e.call.name : e.text)),
    [`Session: ${old.path} (1 messages) · model: m1`, "\nold\n  one\n"],
  );
  await send(cli, `/resume ${ids.get(shown.path ?? "")}`);
  assert.equal(cli.session.path, shown.path);
  assert.equal(await send(cli, "/resume nope"), "error: Session not found: nope");
});

test("plugin commands run with their argument and replace built-ins by name; unknown names stay in the prompt", async (t) => {
  const session = await openSession(null, await tempDir(t, "hortus-"));
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
  const cli = await createCli(session, async (o) =>
    fakeAgent(o, { plugins: [...plugins, { name: "p", plugin: { commands } }] }),
  );
  assert.deepEqual(
    cli.commands.map((c) => c.name),
    ["new", "model", "effort", "resume", "theme", "echo", "fail"],
  );
  assert.equal(await send(cli, "/echo  a b"), "info: echo a b");
  assert.equal(await send(cli, "/fail"), "error: boom");
  assert.equal(await send(cli, "/model x/y"), "info: plugin model");
  assert.equal(cli.submit("/nope x"), false);
  assert.equal(last(cli), "error: Unknown command: /nope");
});

test("a command can start a turn, and the session isn't swapped while one runs", async (t) => {
  const session = await openSession(null, await tempDir(t, "hortus-"));
  const commands: Command[] = [
    { name: "review", description: "", run: (_, ctx) => void cliOf(ctx).submit("review this") },
  ];
  const cli = await createCli(session, async (o) =>
    fakeAgent(o, { plugins: [{ name: "p", plugin: { commands } }] }, 40),
  );
  assert.equal(cli.submit("/review"), true);
  await sleep(10);
  assert.equal(cli.ui.getState().busy, true);
  await assert.rejects(cli.setSession(session), /while a turn is running/);
  await sleep(50);
  assert.deepEqual(texts(session), ["review this"]);
});

test("a skill runs as /skills:<name> and /<name>, without shadowing a command, and plugins' changes show up", async (t) => {
  const dir = await tempDir(t, "hortus-");
  const session = await openSession(null, dir);
  const path = join(dir, "SKILL.md");
  await writeFile(path, "---\ndescription: Review code\n---\nReview carefully.\n");
  let list = [
    { name: "review", description: "Review code", path },
    { name: "model", description: "shadowed", path },
  ];
  // the skills event, as core fires it for listSkills(agent.ctx)
  const ctx = { emit: async (_: string, p: { skills: unknown[] }) => void p.skills?.push(...list) };
  const cli = await createCli(session, async (o) => fakeAgent(o, { ctx }));
  await sleep(10);
  const body = `<skill name="review" location="${path}">\nReferences are relative to ${dir}.\n\nReview carefully.\n</skill>`;
  // the transcript shows the skill's name; the model gets its instructions
  assert.equal(await send(cli, "/skills:review src"), "user: \n[skill] review\n\nsrc\n");
  assert.equal(await send(cli, "/review"), "user: \n[skill] review\n");
  assert.deepEqual(texts(session), [`${body}\n\nsrc`, body]);
  assert.equal(findCommand(cli.commands, "model")?.name, "model");
  list = [];
  assert.equal(await send(cli, "hi"), "user: \nhi\n");
  assert.equal(cli.submit("/review"), false);
});

test("/model and /effort work on a host without the TUI, through the host ctx's session and resolve", async (t) => {
  t.after(await tempHome());
  const base = scripted([]);
  // a model that takes only "low"
  const provider = {
    create: () => ({ ...base.create({} as never, {} as never), info: async () => ({ efforts: ["low" as const] }) }),
  };
  const agent = await createAgent({
    pieces: cliPieces,
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }],
  });
  t.after(() => agent.close());
  const session = await openSession(null, await tempDir(t, "hortus-"));
  await agent.setSession(session);
  assert.equal(agent.ctx.host.kind, "headless");
  const run = (name: string, arg: string) => findCommand(agent.commands(), name)?.run(arg);
  assert.equal(await run("model", ""), "Model: scripted/scripted");
  assert.equal(await run("model", "scripted/other"), "Model set to scripted/other");
  assert.deepEqual([session.getState().provider, session.getState().model], ["scripted", "other"]);
  await assert.rejects(Promise.resolve(run("model", "nokey/m")), /No API key for nokey/);
  assert.deepEqual(
    (await findCommand(agent.commands(), "effort")?.complete?.())?.map((c) => c.value),
    ["auto", "low"],
  );
  assert.equal(await run("effort", "low"), "Effort set to low");
  assert.equal(session.getState().effort, "low");
  assert.equal(await run("effort", ""), "Effort: low");
  await assert.rejects(Promise.resolve(run("effort", "high")), /other doesn't support effort high/);
  assert.equal(await run("effort", "auto"), "Effort set to auto");
  assert.equal(session.getState().effort, undefined);
});
