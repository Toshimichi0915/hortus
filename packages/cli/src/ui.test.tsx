import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { type AskEvent, type Ctx, createAgent, type Named, openSession, type Plugin, tool } from "@hortus/core";
import { record, scripted, type Turn, tempDir, tempHome, until } from "@hortus/core/testing";
import { Box, render, Text, useInput } from "ink";
import type { ComponentType } from "react";
import { z } from "zod";
import { type CliPlugin, useUi } from "./api.ts";
import { App } from "./app.tsx";
import { cliPieces } from "./builtin/index.ts";
import { createCli } from "./cli.ts";
import { terminal } from "./testing.ts";
import { dark } from "./themes.ts";
import { type EntryRenderer, linesRenderer, type ToolRenderer } from "./tools.tsx";

/** a promise the test resolves itself (`Promise.withResolvers` is past this lib's target) */
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** writes `k` to the fake terminal and waits for the frame it draws (every key here changes what's drawn) */
async function press(term: ReturnType<typeof terminal>, k: string) {
  const n = term.writes.length;
  term.stdin.write(k);
  await until(() => term.writes.length > n);
}

/**
 * The TUI on a real agent (the CLI's pieces, a scripted provider, `plugins` loaded as `extra`) in a fake terminal.
 * Rendered unless `draw` is false.
 */
async function tui(
  t: TestContext,
  {
    plugins = [],
    turns = [],
    config,
    draw = true,
    rows = 20,
  }: { plugins?: Named[]; turns?: Turn[]; config?: object; draw?: boolean; rows?: number } = {},
) {
  const restore = await tempHome(config && { config: { provider: "scripted", model: "scripted", ...config } });
  const provider = scripted(turns);
  const session = await openSession(null, await tempDir(t, "hortus-"));
  const cli = await createCli(session, (o) =>
    createAgent({
      ...o,
      pieces: cliPieces,
      extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }, ...plugins, ...(o.extra ?? [])],
    }),
  );
  const term = terminal(60, rows);
  const app = draw
    ? render(<App cli={cli} />, {
        stdin: term.stdin as never,
        stdout: term.stdout as never,
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
      })
    : undefined;
  // closed before HOME is restored: config.json saves still queued (/theme, /effort) land in this test's home
  t.after(async () => {
    app?.unmount();
    await cli.close();
    await restore();
  });
  // drawn, and the input's raw mode on (its effects, the App's own among them, have run)
  if (app) await until(() => term.raw.includes(true));
  return { cli, term, app, provider, session, screen: () => term.frame().join("\n") };
}

const askTool = (answers: unknown[], question: Partial<AskEvent> = {}) =>
  tool({
    name: "asker",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      const a = await ctx.ask({ question: "Proceed?", ...question });
      answers.push(a);
      return `answer: ${JSON.stringify(a)}`;
    },
  });

test("a handler answering synchronously shows no dialog and no attention; ctx.host is the TUI", async (t) => {
  const rec = record();
  const { cli } = await tui(t, {
    plugins: [
      { name: "policy", plugin: { on: { ask: (p) => p.resolve("auto") } } },
      { name: "rec", plugin: rec },
    ],
  });
  const seen: AskEvent[][] = [];
  cli.ui.subscribe((s) => seen.push(s.asks));
  assert.equal(await cli.agent.ctx.ask({ question: "ok?" }), "auto");
  assert.equal(
    seen.some((a) => a.length),
    false,
  );
  assert.equal(
    rec.events.some((e) => e.name === "attention"),
    false,
  );
  assert.deepEqual(
    { kind: cli.agent.ctx.host.kind, interactive: cli.agent.ctx.host.interactive },
    { kind: "tui", interactive: true },
  );
});

test("asks race the dialog: a late handler closes it; answering in the dialog first aborts the handler", async (t) => {
  const rec = record();
  let late = true;
  const aborted: boolean[] = [];
  // the handler answers once the test lets it: after the dialog showed, or after the dialog answered
  let held = gate();
  const remote: Plugin = {
    on: {
      ask: async (p) => {
        await held.promise;
        aborted.push(p.signal.aborted);
        if (late) p.resolve("remote");
      },
    },
  };
  const { cli, term, screen } = await tui(t, {
    plugins: [
      { name: "remote", plugin: remote },
      { name: "rec", plugin: rec },
    ],
  });
  const asked = cli.agent.ctx.ask({ question: "Deploy?", options: [{ label: "yes" }, { label: "no" }] });
  await until(() => /Deploy\?/.test(screen()), 5000);
  assert.equal(rec.events.filter((e) => e.name === "attention").length, 1);
  held.resolve();
  assert.equal(await asked, "remote");
  await until(() => !/Deploy\?/.test(screen()));
  assert.doesNotMatch(screen(), /Deploy\?/);
  assert.equal(cli.ui.getState().asks.length, 0);

  // now the dialog answers first (↓ then Enter picks "no"), and the handler finds its signal aborted
  late = false;
  held = gate();
  const second = cli.agent.ctx.ask({ question: "Deploy?", options: [{ label: "yes" }, { label: "no" }] });
  await until(() => /Deploy\?/.test(screen()));
  await press(term, "\x1b[B");
  term.stdin.write("\r");
  assert.equal(await second, "no");
  held.resolve();
  await until(() => aborted.length === 2);
  assert.deepEqual(aborted, [false, true]);
});

test("asks raised while the TUI starts (init, session_open, cli.init) fail closed instead of blocking startup", async (t) => {
  const answers: unknown[] = [];
  const early = {
    on: {
      init: async (_: unknown, ctx: Ctx) => void answers.push(await ctx.ask({ question: "init?" })),
      session_open: async (_: unknown, ctx: Ctx) => void answers.push(await ctx.ask({ question: "open?" })),
    },
    cli: { init: async (_: unknown, ctx: Ctx) => void answers.push(await ctx.ask({ question: "cli init?" })) },
  } as CliPlugin;
  const { cli } = await tui(t, { plugins: [{ name: "early", plugin: early }] });
  assert.deepEqual(answers, [undefined, undefined, undefined]);
  // once started, asks show
  const asked = cli.agent.ctx.ask({ question: "later?" });
  assert.equal(cli.ui.getState().asks[0]?.question, "later?");
  cli.ui.getState().asks[0]?.resolve("yes");
  assert.equal(await asked, "yes");
});

test("two asks at once show one after the other, while other handlers see both at once", async (t) => {
  const seen: string[] = [];
  const { cli, term, screen } = await tui(t, {
    plugins: [{ name: "watch", plugin: { on: { ask: (p) => void seen.push(p.question) } } }],
  });
  const a = cli.agent.ctx.ask({ question: "First?", allowText: true });
  const b = cli.agent.ctx.ask({ question: "Second?", allowText: true });
  await until(() => seen.length === 2 && /First\?/.test(screen()), 5000);
  assert.deepEqual(seen, ["First?", "Second?"]);
  assert.match(screen(), /First\?/);
  assert.doesNotMatch(screen(), /Second\?/);
  await press(term, "one");
  term.stdin.write("\r");
  assert.equal(await a, "one");
  await until(() => /Second\?/.test(screen()));
  assert.match(screen(), /Second\?/);
  // Esc dismisses it
  term.stdin.write("\x1b");
  assert.equal(await b, undefined);
});

test("a secret ask masks what's typed, and the answer reaches no entry or session line", async (t) => {
  const answers: unknown[] = [];
  const { cli, term, screen, session } = await tui(t, {
    turns: [{ toolCalls: [{ id: "1", name: "asker", input: {} }] }, { text: "ok" }],
    plugins: [{ name: "tools", plugin: { tools: [askTool(answers, { question: "Token?", secret: true })] } }],
  });
  assert.equal(cli.submit("go"), true);
  await until(() => /Token\?/.test(screen()));
  await press(term, "hunter2");
  assert.match(screen(), /\*{7}/);
  assert.doesNotMatch(screen(), /hunter2/);
  term.stdin.write("\r");
  await until(() => answers.length === 1 && !cli.ui.getState().busy);
  assert.deepEqual(answers, ["hunter2"]);
  // the tool chose to return it (its result is the model's), but nothing the dialog did shows or saves it otherwise
  const entries = cli.ui.getState().entries.filter((e) => e.kind !== "tool");
  assert.equal(JSON.stringify(entries).includes("hunter2"), false);
  const lines = (await readFile(session.path ?? "", "utf8")).split("\n").filter((l) => !l.includes('"tool"'));
  assert.equal(lines.join("\n").includes("hunter2"), false);
});

test("multi and allowText dialogs answer arrays and free text", async (t) => {
  const { cli, term, screen } = await tui(t);
  const multi = cli.agent.ctx.ask({
    question: "Which?",
    multi: true,
    options: [{ label: "a" }, { label: "b" }, { label: "c" }],
  });
  await until(() => /Which\?/.test(screen()));
  for (const key of [" ", "\x1b[B", "\x1b[B", " ", "\r"]) await press(term, key);
  assert.deepEqual(await multi, ["a", "c"]);
  // once a filter is typed, Space is part of it and Tab ticks
  const filtered = cli.agent.ctx.ask({
    question: "Which?",
    multi: true,
    options: [{ label: "red fox" }, { label: "red hen" }, { label: "blue" }],
  });
  await until(() => /red fox/.test(screen()));
  for (const key of ["red h", "\t", "\r"]) await press(term, key);
  assert.deepEqual(await filtered, ["red hen"]);
  const text = cli.agent.ctx.ask({ question: "Name?", options: [{ label: "default" }], allowText: true });
  await until(() => /Name\?/.test(screen()));
  await press(term, "mine");
  term.stdin.write("\r");
  assert.equal(await text, "mine");
});

test("cli.asks[kind] renders its kind's dialog; an unknown kind gets the generic one", async (t) => {
  const pick: CliPlugin = {
    cli: {
      asks: {
        color: ({ ask }) => {
          useInput((input) => {
            if (input === "r") ask.resolve("red");
          });
          return <Text>{`pick a color for ${(ask.data as { what: string }).what}`}</Text>;
        },
      },
    },
  };
  const { cli, term, screen } = await tui(t, { plugins: [{ name: "pick", plugin: pick }] });
  const a = cli.agent.ctx.ask({ kind: "color", question: "Color?", data: { what: "the bike shed" } });
  await until(() => /pick a color for the bike shed/.test(screen()), 5000);
  term.stdin.write("r");
  assert.equal(await a, "red");
  const b = cli.agent.ctx.ask({ kind: "nope", question: "Generic?", options: [{ label: "x" }] });
  await until(() => /Generic\?/.test(screen()), 5000);
  term.stdin.write("\r");
  assert.equal(await b, "x");
});

test("a plugin command runs from the / menu with a host ctx that can ask and send; commands run while busy", async (t) => {
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const plugin: Plugin = {
    commands: [
      {
        name: "deploy",
        args: "<env>",
        description: "Deploy",
        run: async (arg, ctx) => {
          const ok = await ctx.ask({ question: `Deploy ${arg}?`, options: [{ label: "yes" }, { label: "no" }] });
          if (ok === "yes") await ctx.send(`deployed ${arg}`);
          return `deploy ${arg}: ${ok}`;
        },
      },
    ],
  };
  const { cli, term, session, screen } = await tui(t, {
    turns: [
      async () => {
        await held;
        return { text: "done" };
      },
    ],
    plugins: [{ name: "ops", plugin }],
  });
  assert.equal(
    cli.agent.commands().some((c) => c.name === "deploy" && c.plugin === "ops"),
    true,
  );
  assert.equal(cli.submit("busy"), true);
  await until(() => cli.ui.getState().busy, 5000);
  // a plain prompt is refused while the turn runs; a command isn't
  assert.equal(cli.submit("another"), false);
  cli.setInput("/dep");
  await until(() => /\/deploy/.test(screen()));
  term.stdin.write("\t");
  await until(() => cli.ui.getState().input === "/deploy ", 5000);
  await press(term, "prod");
  term.stdin.write("\r");
  await until(() => /Deploy prod\?/.test(screen()), 5000);
  term.stdin.write("\r");
  await until(() => {
    const e = cli.ui.getState().entries.at(-1);
    return e?.kind === "info" && "text" in e && e.text.startsWith("deploy");
  }, 5000);
  const last = cli.ui.getState().entries.at(-1);
  assert.deepEqual(last && "text" in last && [last.kind, last.text], ["info", "deploy prod: yes"]);
  release();
  // the context send joined the session beside the turn
  await until(() => session.getState().messages.some((m) => m.role === "user" && m.content === "deployed prod"));
  assert.ok(session.getState().messages.some((m) => m.role === "user" && m.content === "deployed prod"));
});

test("status events fill UiState.statuses (drawn by the status bar); notify adds a line per level", async (t) => {
  const { cli, screen } = await tui(t);
  await cli.agent.ctx.status("quota", "73% left");
  await cli.agent.ctx.notify("heads up", "warn");
  await cli.agent.ctx.notify("broken", "error");
  await cli.agent.ctx.notify("fyi");
  await until(() => /73% left/.test(screen()));
  assert.deepEqual(cli.ui.getState().statuses, { quota: { text: "73% left" } });
  assert.match(screen(), /73% left/);
  assert.deepEqual(
    cli.ui
      .getState()
      .entries.slice(-3)
      .map((e) => "text" in e && [e.kind, e.text]),
    [
      ["warn", "heads up"],
      ["error", "broken"],
      ["info", "fyi"],
    ],
  );
  await cli.agent.ctx.status("quota");
  assert.deepEqual(cli.ui.getState().statuses, {});
});

test("a prompt override that doesn't render Default gets Esc and the run goes on, and asks still show; the default prompt aborts", async (t) => {
  const keys: string[] = [];
  const own: CliPlugin = {
    cli: {
      prompt: () => {
        useInput((_, key) => {
          if (key.escape) keys.push("esc");
        });
        return <Text>my prompt</Text>;
      },
    },
  };
  // the turn runs until the test lets it finish, or it's aborted
  const finish = gate();
  const slow: Turn = async (req) => {
    await new Promise((r) => {
      finish.promise.then(r);
      req.signal?.addEventListener("abort", r);
    });
    return { text: req.signal?.aborted ? "" : "finished" };
  };
  const a = await tui(t, { turns: [slow], plugins: [{ name: "own", plugin: own }] });
  assert.match(a.screen(), /my prompt/);
  // an ask's dialog takes the takeover's place while it's pending
  const asked = a.cli.agent.ctx.ask({ question: "Shown?", options: [{ label: "yes" }] });
  await until(() => /Shown\?/.test(a.screen()));
  assert.match(a.screen(), /Shown\?/);
  assert.doesNotMatch(a.screen(), /my prompt/);
  a.term.stdin.write("\r");
  assert.equal(await asked, "yes");
  await until(() => /my prompt/.test(a.screen()));
  assert.match(a.screen(), /my prompt/);
  a.cli.submit("hi");
  await until(() => a.cli.ui.getState().busy);
  a.term.stdin.write("\x1b");
  await until(() => keys.length > 0);
  assert.deepEqual(keys, ["esc"]);
  // not aborted: once let go, the turn finishes
  finish.resolve();
  await until(() => !a.cli.ui.getState().busy);
  const texts = a.cli.ui.getState().entries.map((e) => ("text" in e ? e.text : ""));
  assert.ok(texts.includes("finished"));
  a.app?.unmount();

  const unfinished = gate();
  const b = await tui(t, {
    turns: [
      async (req) => {
        await new Promise((r) => {
          unfinished.promise.then(r);
          req.signal?.addEventListener("abort", r);
        });
        return { text: "" };
      },
    ],
  });
  b.cli.submit("hi");
  await until(() => b.cli.ui.getState().busy);
  b.term.stdin.write("\x1b");
  await until(() => !b.cli.ui.getState().busy);
  assert.match(b.cli.ui.getState().entries.at(-1)?.kind === "error" ? "Interrupted" : "", /Interrupted/);
});

const labelled = (slot: "aboveInput" | "transcript", label: string): CliPlugin => ({
  cli: {
    [slot]: ({ Default }: { Default: ComponentType }) => (
      <Box flexDirection="column">
        <Text>{label}</Text>
        <Default />
      </Box>
    ),
  },
});

test("aboveInput and transcript overrides compose in load order; a throwing one falls back via Guard", async (t) => {
  const boom: CliPlugin = {
    cli: {
      aboveInput: () => {
        throw new Error("boom");
      },
    },
  };
  const { cli, screen } = await tui(t, {
    plugins: [
      { name: "a", plugin: labelled("aboveInput", "panel-a") },
      { name: "b", plugin: labelled("aboveInput", "panel-b") },
      { name: "c", plugin: boom },
      { name: "t", plugin: labelled("transcript", "browser-view") },
    ],
  });
  const s = screen();
  assert.ok(s.indexOf("panel-b") < s.indexOf("panel-a"), "the later plugin is outermost");
  assert.match(s, /browser-view/);
  assert.ok(
    cli.ui
      .getState()
      .entries.some((e) => "text" in e && /aboveInput plugin failed, showing the one it replaced: boom/.test(e.text)),
  );
});

test("cli.suspend leaves the alternate screen and raw mode while fn runs, and restores both (also when it throws)", async (t) => {
  t.after(await tempHome());
  const session = await openSession(null, await tempDir(t, "hortus-"));
  const cli = await createCli(session, (o) => createAgent({ ...o, pieces: cliPieces }));
  const term = terminal(60, 20);
  const app = render(<App cli={cli} />, {
    stdin: term.stdin as never,
    stdout: term.stdout as never,
    patchConsole: false,
    exitOnCtrlC: false,
    alternateScreen: true,
    interactive: true,
  });
  t.after(() => app.unmount());
  // the App's effects (attaching Ink's terminal to the cli) ran with the input's raw mode
  await until(() => term.raw.includes(true));
  const marks = () => term.writes.join("");
  for (const fail of [false, true]) {
    term.writes.length = 0;
    term.raw.length = 0;
    const during: string[] = [];
    const run = cli.suspend(() => {
      during.push(marks());
      if (fail) throw new Error("child failed");
      return "ok";
    });
    if (fail) await assert.rejects(run, /child failed/);
    else assert.equal(await run, "ok");
    const before = during[0] ?? "";
    assert.ok(before.includes("\x1b[?1049l"), "left the alternate screen");
    assert.ok(before.includes("\x1b[?1002l"), "mouse reporting off");
    const after = marks().slice(before.length);
    assert.ok(after.includes("\x1b[?1049h"), "back on the alternate screen");
    assert.ok(after.includes("\x1b[?1002h"), "mouse reporting on");
    assert.deepEqual(term.raw, [false, true]);
  }
});

test("cli.setInput changes the prompt's text; submitting clears it", async (t) => {
  const { cli, screen } = await tui(t, { turns: [{ text: "hi back" }] });
  cli.setInput("drafted by a plugin");
  await until(() => /> drafted by a plugin/.test(screen()));
  assert.equal(cli.submit(cli.ui.getState().input), true);
  await until(() => !cli.ui.getState().busy && !/> drafted/.test(screen()));
  assert.equal(cli.ui.getState().input, "");
  assert.doesNotMatch(screen(), /> drafted/);
});

test("cli.entries renders text kinds, plugin messages by <plugin>:<type>, tool:* for unknown tools; cli.push isn't saved", async (t) => {
  const tag = (label: string): EntryRenderer => ({
    // biome-ignore lint/correctness/noComponentHookFactories: made once per test
    Render: ({ Default, ...v }) => (
      <Box flexDirection="column">
        <Text>{label}</Text>
        <Default {...v} />
      </Box>
    ),
  });
  const note: EntryRenderer = {
    // biome-ignore lint/correctness/noComponentHookFactories: made once per test
    Render: ({ entry }) => <Text>{`NOTE ${entry.text} ${JSON.stringify(entry.meta?.details)}`}</Text>,
    text: ({ entry }) => `NOTE ${entry.text}`,
  };
  // biome-ignore lint/correctness/noComponentHookFactories: made once per test
  const banner: EntryRenderer = { Render: ({ entry }) => <Text>{`BANNER ${entry.text}`}</Text> };
  const card: ToolRenderer = {
    // biome-ignore lint/correctness/noComponentHookFactories: made once per test
    Render: ({ call }) => <Text>{`CARD ${call.name}`}</Text>,
    text: ({ call }) => `CARD ${call.name}`,
  };
  const renders: CliPlugin = {
    cli: {
      entries: {
        user: tag("USER"),
        assistant: tag("ASSISTANT"),
        thinking: tag("THINKING"),
        "x:note": note,
        "x:banner": banner,
        "tool:*": card,
      },
    },
  };
  const { cli, screen, session } = await tui(t, {
    turns: [
      { toolCalls: [{ id: "1", name: "mcp__srv__lookup", input: {} }] },
      (_req, _ctx, callbacks) => {
        callbacks?.thinking?.("pondering");
        return { text: "answer" };
      },
    ],
    plugins: [{ name: "x", plugin: renders }],
    rows: 40,
  });
  await cli.agent.ctx.send({ content: "noted", meta: { plugin: "x", type: "note", details: 7 } });
  await cli.agent.ctx.send({ content: "hidden", meta: { plugin: "x", type: "note", display: false } });
  await cli.agent.ctx.send({ content: "unrendered", meta: { plugin: "x", type: "other" } });
  // display: true shows one no plugin renders, with the built-in plugin-message look
  await cli.agent.ctx.send({ content: "displayed", meta: { plugin: "x", type: "other", display: true } });
  cli.push({ kind: "x:banner", text: "welcome" });
  cli.submit("question");
  await until(() => !cli.ui.getState().busy && /ASSISTANT\n.*answer/.test(screen()));
  const s = screen();
  assert.match(s, /NOTE noted 7/);
  assert.doesNotMatch(s, /hidden|unrendered/);
  assert.match(s, /displayed/);
  assert.match(s, /BANNER welcome/);
  assert.match(s, /USER\n.*\n.*question/);
  assert.match(s, /ASSISTANT\n.*answer/);
  assert.match(s, /THINKING\n.*pondering/);
  assert.match(s, /CARD mcp__srv__lookup/);
  assert.equal((await readFile(session.path ?? "", "utf8")).includes("welcome"), false);
});

test("Ctrl+O flips expanded for every tool block; partial input reaches a renderer; empty siblings leave no rows", async (t) => {
  const views: { expanded?: boolean; partial?: string }[] = [];
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const cards: CliPlugin = {
    cli: {
      entries: {
        // the first call of a batch draws the whole group; the others draw nothing
        "tool:*": linesRenderer(({ call, siblings = [], expanded, partial }) => {
          views.push({ expanded, ...(partial !== undefined && { partial }) });
          if (siblings[0] && siblings[0].call.id !== call.id) return [];
          return [[{ text: `GROUP ${siblings.map((s) => s.call.name).join("+")} ${expanded ? "open" : "shut"}` }]];
        }),
      },
    },
  };
  const streaming: Turn = async (_req, _ctx, callbacks) => {
    callbacks?.toolInput?.({ id: "1", name: "a", partial: '{"q":' });
    await held;
    return {
      toolCalls: [
        { id: "1", name: "a", input: {} },
        { id: "2", name: "b", input: {} },
      ],
    };
  };
  const noop = (name: string) => tool({ name, description: "", inputSchema: z.object({}), execute: async () => "" });
  const { cli, term, screen } = await tui(t, {
    turns: [streaming, { text: "end" }],
    plugins: [
      { name: "cards", plugin: cards },
      { name: "tools", plugin: { tools: [noop("a"), noop("b")] } },
    ],
  });
  cli.submit("go");
  await until(() => views.some((v) => v.partial === '{"q":'));
  release();
  await until(() => !cli.ui.getState().busy && /GROUP a\+b shut/.test(screen()) && /^end$/m.test(screen()));
  const rows = screen().split("\n");
  const at = rows.findIndex((r) => r.includes("GROUP a+b shut"));
  assert.ok(at >= 0);
  // the group's block, its bottom background row, then the gap before the reply: no rows for b's empty block
  assert.deepEqual(rows.slice(at + 1, at + 4), ["", "", "end"]);
  await press(term, "\x0f");
  await until(() => /GROUP a\+b open/.test(screen()));
  assert.match(screen(), /GROUP a\+b open/);
  assert.equal(cli.ui.getState().expanded, true);
});

test("theme packs register themes; config.theme picks one; /theme switches live", async (t) => {
  const red = { ...dark, accent: "#ff0000" };
  const packs: Named[] = [
    { name: "pack1", plugin: { cli: { themes: { red, blue: { ...dark, accent: "#0000ff" } } } } as CliPlugin },
    { name: "pack2", plugin: { cli: { themes: { green: { ...dark, accent: "#00ff00" } } } } as CliPlugin },
  ];
  const { cli } = await tui(t, { plugins: packs, config: { theme: "blue" }, draw: false });
  // applied before createCli returns, so the first frame is drawn in it (themes.test.tsx checks the colors drawn)
  assert.deepEqual(Object.keys(cli.themes).sort(), ["blue", "dark", "green", "red"]);
  assert.equal(cli.ui.getState().theme, "blue");
  const { theme } = await import("./themes.ts");
  assert.equal(theme.accent, "#0000ff");
  const config = join(process.env.HOME ?? "", ".hortus", "config.json");
  const savedTheme = () => {
    try {
      return JSON.parse(readFileSync(config, "utf8")).theme;
    } catch {
      return undefined;
    }
  };
  assert.equal(cli.submit("/theme red"), true);
  await until(() => cli.ui.getState().theme === "red" && savedTheme() === "red");
  assert.equal(cli.ui.getState().theme, "red");
  assert.equal(theme.accent, "#ff0000");
  const saved = JSON.parse(await readFile(config, "utf8"));
  assert.equal(saved.theme, "red");
  const count = cli.ui.getState().entries.length;
  assert.equal(cli.submit("/theme nope"), true);
  await until(() => cli.ui.getState().entries.length > count);
  const last = cli.ui.getState().entries.at(-1);
  assert.match(last && "text" in last ? last.text : "", /Unknown theme: nope/);
  cli.setTheme("dark");
});

test("no color literal is left outside the theme definitions", async () => {
  const { readdir } = await import("node:fs/promises");
  const dir = new URL("../src/", import.meta.url);
  for (const f of await readdir(dir, { recursive: true })) {
    if (!/\.tsx?$/.test(f) || f === "themes.ts" || f.includes(".test.")) continue;
    assert.doesNotMatch(await readFile(new URL(f, dir), "utf8"), /#[0-9a-fA-F]{6}\b/, f);
  }
});

test("a cli.complete wrapper adds @file rows and keeps the / command rows from Default", async (t) => {
  const files: CliPlugin = {
    cli: {
      complete: (input, Default) => {
        const m = input.match(/@(\S*)$/);
        if (!m) return Default(input);
        return ["src/a.ts", "src/b.ts"]
          .filter((f) => f.includes(m[1] ?? ""))
          .map((f) => ({ label: f, value: input.replace(/@\S*$/, `@${f} `) }));
      },
    },
  };
  const { cli, term, screen } = await tui(t, { plugins: [{ name: "files", plugin: files }] });
  cli.setInput("look at @b");
  await until(() => /src\/b\.ts/.test(screen()));
  assert.match(screen(), /src\/b\.ts/);
  term.stdin.write("\t");
  await until(() => cli.ui.getState().input !== "look at @b");
  assert.equal(cli.ui.getState().input, "look at @src/b.ts ");
  cli.setInput("/the");
  await until(() => /\/theme \[name\]/.test(screen()));
  assert.match(screen(), /\/theme \[name\]/);
});

test("ctx.exit leaves the TUI, and closing runs session_close('exit'), session_closed, then close", async (t) => {
  const rec = record();
  const { cli, app } = await tui(t, { plugins: [{ name: "rec", plugin: rec }] });
  cli.agent.ctx.exit();
  await app?.waitUntilExit();
  await cli.close();
  const names = rec.events.map((e) => e.name);
  assert.deepEqual(names.slice(names.indexOf("session_close")), ["session_close", "session_closed", "close"]);
  const close = rec.events.find((e) => e.name === "session_close")?.payload as { reason: string } | undefined;
  assert.equal(close?.reason, "exit");
});

void useUi;

test("cli:compaction: /compact draws the summary as one line, and a resumed session starts with it", async (t) => {
  const { cli, screen, session } = await tui(t, {
    turns: [{ text: "x".repeat(800) }, { text: "b" }, { text: "## Goal\nShip the parser\n" }],
    config: { compaction: { keepRecent: 100 } },
  });
  for (const text of ["one", "two"]) {
    assert.equal(cli.submit(text), true);
    await until(() => !cli.ui.getState().busy);
  }
  assert.equal(cli.submit("/compact"), true);
  await until(() => /◆ compacted Ship the parser/.test(screen()));
  const resumed = await openSession(session.leafId as string, dirname(session.path as string));
  assert.equal(await cli.setSession(resumed, "resume"), true);
  await until(() => cli.ui.getState().entries.some((e) => e.kind === "builtin:compaction:summary"));
  assert.deepEqual(
    cli.ui
      .getState()
      .entries.map((e) => e.kind)
      .filter((k) => k !== "info"),
    ["builtin:compaction:summary", "assistant", "user", "assistant"],
  );
});
