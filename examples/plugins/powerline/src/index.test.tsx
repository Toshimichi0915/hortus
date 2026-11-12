import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "@hortus/cli";
import { renderApp, startCli } from "@hortus/cli/testing";
import { createAgent, hortusDir, openSession } from "@hortus/core";
import { scripted, type Turn, tempDir, tempHome, until } from "@hortus/core/testing";
import { recentPrompts } from "./index.tsx";
import { icons, layout, PRESETS, type SegmentContext } from "./segments.ts";

const dir = fileURLToPath(new URL("..", import.meta.url));
process.env.POWERLINE_NERD_FONTS = "0";

/** A git repo with one untracked file, as the cwd (the path and git segments read it). */
function repo(t: TestContext) {
  const prev = process.cwd();
  const cwd = mkdtempSync(join(tmpdir(), "powerline-proj-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  writeFileSync(join(cwd, "new.txt"), "x");
  process.chdir(cwd);
  t.after(() => process.chdir(prev));
}

/** The real TUI with the plugin loaded from its dir, `powerline.json` = `config`, answering with `turns`. */
async function tui(t: TestContext, config: object, turns: Turn[], fetch?: typeof globalThis.fetch) {
  t.after(await tempHome({ plugins: { powerline: dir } }));
  writeFileSync(join(hortusDir(), "powerline.json"), JSON.stringify({ welcome: false, ...config }));
  writeFileSync(join(hortusDir(), "AGENTS.md"), "be nice");
  mkdirSync(join(hortusDir(), "powerline", "vibes"), { recursive: true });
  writeFileSync(join(hortusDir(), "powerline", "vibes", "pirate.txt"), "Hoisting the sails...\n");
  const provider = scripted(turns);
  const cli = await startCli({ fetch, extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  const { app, screen, keys, ...term } = renderApp(cli, { columns: 140, rows: 30 });
  t.after(() => app.unmount());
  const wait = (cond: () => boolean, ms?: number) =>
    until(cond, ms).catch((e) => {
      throw new Error(`${e.message}; input ${JSON.stringify(cli.ui.getState().input)}, screen:\n${screen()}`);
    });
  return { cli, term, provider, screen, wait, keys };
}

/** A turn that answers once `release` is called, so the TUI stays busy meanwhile. */
function gate(answer: Turn & object) {
  let release = () => {};
  const turn: Turn = () => new Promise((r) => (release = () => r(answer as never)));
  return { turn, release: () => release() };
}

test("the bar shows model, thinking, path, git, context, cache, cost and statuses, and moves below the input", async (t) => {
  repo(t);
  const run = gate({ text: "done", usage: { input: 1500, output: 300, cacheRead: 1000, cost: 0.12 } });
  const { cli, screen, wait } = await tui(
    t,
    {
      customItems: [{ id: "ci", statusKey: "ci-status", prefix: "CI", position: "left" }],
      vibe: { theme: "pirate", mode: "file" },
    },
    [run.turn],
  );
  await cli.agent.ctx.status("ci-status", "green");
  await cli.agent.ctx.status("lsp", "lsp ok");
  await cli.agent.ctx.status("note", "[heads up]");

  cli.submit("fix it");
  // the working message shows while the turn runs
  await wait(() => screen().includes("Hoisting the sails..."));
  run.release();
  await wait(() => !cli.ui.getState().busy && /\$0\.12/.test(screen()));
  await wait(() => /⎇ main \?1/.test(screen()));
  const lines = screen().split("\n");
  const bar = lines.find((l) => l.includes("think:auto")) ?? "";
  assert.match(
    bar,
    /^ scripted \| think:auto \| dir powerline-proj-\w+ \| ⎇ main \?1 \| ◫ 1\.8k\/0 \(0\.0%\) \| cache in: 1\.0k \| \$0\.12 \| CI · green/,
  );
  // notification statuses above the editor, others in the bar, the last prompt under the editor
  assert.ok(lines.some((l) => l === " [heads up]"));
  assert.ok(lines.some((l) => l.includes("lsp ok")));
  assert.ok(lines.some((l) => l === " ↳ fix it"));
  assert.doesNotMatch(screen(), /Hoisting the sails/);
  // the bar sits above the input box (placement above)
  const at = lines.findIndex((l) => l.includes("think:auto"));
  assert.match(lines[at + 2] ?? "", /╭/);

  // placement below: under the input box
  await cli.submit("/powerline placement below");
  await wait(() => /╰.*\n.*think:auto/.test(screen()));
});

test("Alt+S stashes the draft and restores it; the stash shows in the bar and its history is saved", async (t) => {
  const { cli, screen, keys, term, wait } = await tui(t, {}, []);
  keys("draft one");
  await wait(() => cli.ui.getState().input === "draft one");
  keys("\x1bs");
  await wait(() => cli.ui.getState().input === "" && /Text stashed/.test(screen()));
  assert.match(screen(), / stash/);
  keys("\x1bs");
  await wait(() => cli.ui.getState().input === "draft one" && /Stash restored/.test(screen()));
  const saved = JSON.parse(readFileSync(join(hortusDir(), "powerline", "stash-history.json"), "utf8"));
  assert.deepEqual(saved.history, ["draft one"]);

  // Ctrl+Alt+C copies the editor (OSC 52); the input box never sees it (as Ctrl+C: clear)
  keys("\x1b\x03");
  await wait(() => /Copied editor text/.test(screen()));
  assert.equal(cli.ui.getState().input, "draft one");
  assert.ok(term.writes.some((w) => w.includes(`\x1b]52;c;${Buffer.from("draft one").toString("base64")}`)));

  // /stash-history offers the stashed prompt and inserts it
  cli.setInput("");
  cli.submit("/stash-history");
  await wait(() => /Prompt history/.test(screen()));
  keys("\r"); // Stashed prompts
  await wait(() => /#1 draft one/.test(screen()));
  keys("\r");
  await wait(() => /Stashed prompt/.test(screen()));
  keys("\r"); // Insert
  await wait(() => cli.ui.getState().input === "draft one");
});

test("while a turn runs, Enter steers it and Alt+Enter queues a follow-up after it", async (t) => {
  const first = gate({ text: "working" });
  const { cli, provider, keys, wait } = await tui(t, {}, [first.turn, { text: "steered" }, { text: "later" }]);
  cli.submit("do X");
  await wait(() => provider.requests.length === 1);
  keys("also Y");
  await wait(() => cli.ui.getState().input === "also Y");
  keys("\r");
  await wait(() => cli.ui.getState().input === "");
  keys("then Z");
  await wait(() => cli.ui.getState().input === "then Z");
  keys("\x1b\r");
  await wait(() => cli.ui.getState().input === "");
  first.release();
  await wait(() => provider.requests.length === 3 && !cli.ui.getState().busy);
  const users = (i: number) =>
    provider.requests[i]?.messages.flatMap((m) => (m.role === "user" ? [m.content] : [])) ?? [];
  // the steer joined the running turn: its second request
  assert.deepEqual(users(1), ["do X", "also Y"]);
  // the follow-up ran after it ended
  assert.deepEqual(users(2), ["do X", "also Y", "then Z"]);
});

test("auto follow-up asks Jev (stubbed) and queues a message it says can wait", async (t) => {
  process.env.TYPESAFE_API_KEY = "test-key";
  t.after(() => delete process.env.TYPESAFE_API_KEY);
  const sent: { auth: string | null; body: { state: { new_message: string; current_task: string } } }[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    sent.push({ auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    return Response.json({ answers: { route: { choice: "follow_up", confidence: 0.95 } } });
  };
  const first = gate({ text: "working" });
  const { cli, provider, keys, wait } = await tui(t, { autoFollowUp: true }, [first.turn, { text: "weather" }], fetch);
  cli.submit("refactor it");
  await wait(() => provider.requests.length === 1);
  keys("what's the weather?");
  await wait(() => cli.ui.getState().input === "what's the weather?");
  keys("\r");
  await wait(() => sent.length === 1);
  assert.equal(sent[0]?.auth, "Bearer test-key");
  assert.equal(sent[0]?.body.state.new_message, "what's the weather?");
  assert.equal(sent[0]?.body.state.current_task, "refactor it");
  first.release();
  await wait(() => provider.requests.length === 2 && !cli.ui.getState().busy);
  // not steered into the first run's turn: one request each
  assert.equal(provider.requests[0]?.messages.length, 1);
  assert.equal(provider.requests[1]?.messages.at(-1)?.role, "user");
});

test("sendDelayMs holds a prompt: Esc takes it back, Enter sends it after the delay", async (t) => {
  const { cli, provider, screen, keys, wait } = await tui(t, { sendDelayMs: 300 }, [{ text: "hi" }]);
  keys("hello");
  await wait(() => cli.ui.getState().input === "hello");
  keys("\r");
  await wait(() => /sending in 1s · esc to edit · enter to send now {2}hello/.test(screen()));
  keys("\x1b");
  await wait(() => cli.ui.getState().input === "hello" && !/sending in/.test(screen()));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(provider.requests.length, 0);
  keys("\r");
  await wait(() => provider.requests.length === 1, 3000);
  const last = provider.requests[0]?.messages.at(-1);
  assert.equal(last?.role === "user" && last.content, "hello");
});

test("the welcome shows at start with what a run would load, and a key dismisses it", async (t) => {
  const { cli, screen, keys, wait } = await tui(t, { welcome: true }, []);
  await wait(() => /Welcome back!/.test(screen()));
  assert.match(screen(), /scripted/);
  assert.match(screen(), /\d+ context files?/);
  assert.match(screen(), /Press any key to continue \(\d+s\)/);
  keys("x");
  await wait(() => !/Welcome back!/.test(screen()) && cli.ui.getState().input === "x");
});

test("/reply quotes a message by id prefix into the editor", async (t) => {
  const { cli, wait, keys } = await tui(t, {}, [{ text: "the answer\nis 42" }]);
  cli.submit("question");
  await wait(() => !cli.ui.getState().busy && cli.session.getState().messages.length === 2);
  const id = cli.session.getState().messages[1]?.entryId ?? "";
  await cli.agent
    .commands()
    .find((c) => c.name === "reply")
    ?.run(id.slice(0, 12));
  await wait(() => cli.ui.getState().input.startsWith("Quoted"));
  const quote = `Quoted previous assistant message ${id} for reference only:\n\n> the answer\n> is 42\n\nMy reply:\n`;
  assert.equal(cli.ui.getState().input, quote);
  // the caret sits after the quote, before what was drafted
  cli.setInput("my draft");
  await cli.agent
    .commands()
    .find((c) => c.name === "reply")
    ?.run(id.slice(0, 12));
  await wait(() => cli.ui.getState().input === `${quote}my draft`);
  keys("so: ");
  await wait(() => cli.ui.getState().input === `${quote}so: my draft`);
});

test("while a turn runs, Esc takes a held steer back without aborting the run", async (t) => {
  const first = gate({ text: "working" });
  const { cli, provider, keys, wait } = await tui(t, { sendDelayMs: 5000 }, [first.turn, { text: "after" }]);
  // not typed, so not held
  void cli.agent.ctx.send("do X", { deliver: "steer" });
  await wait(() => provider.requests.length === 1 && cli.ui.getState().busy);
  keys("wait");
  await wait(() => cli.ui.getState().input === "wait");
  keys("\r");
  await wait(() => cli.ui.getState().input === "");
  keys("\x1b");
  await wait(() => cli.ui.getState().input === "wait");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(cli.ui.getState().busy, true, "not aborted");
  first.release();
  await wait(() => !cli.ui.getState().busy);
  assert.equal(provider.requests.length, 1);
  assert.doesNotMatch(
    cli.ui
      .getState()
      .entries.map((e) => (e.kind === "error" ? e.text : ""))
      .join(),
    /Interrupted/,
  );
});

test("/powerline and /vibe work through agent.commands() and save their settings", async (t) => {
  t.after(await tempHome({ plugins: { powerline: dir } }));
  const provider = scripted([{ text: "1. Hoisting the sails...\n2. Charting course...\n3. Swabbing decks" }]);
  const agent = await createAgent({
    provided: { "@hortus/cli": version },
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }],
  });
  const run = (name: string, arg: string) => {
    const c = agent.commands().find((c) => c.name === name);
    assert.ok(c);
    return c.run(arg);
  };
  const config = () => JSON.parse(readFileSync(join(hortusDir(), "powerline.json"), "utf8"));
  assert.equal(await run("powerline", "minimal"), "Preset set to: minimal");
  assert.equal(await run("powerline", "placement toggle"), "Powerline placement set to: below");
  assert.deepEqual(config(), { preset: "minimal", placement: "below" });
  assert.match((await run("powerline", "nope")) ?? "", /Available presets: default, minimal/);

  assert.match((await run("vibe", "generate pirate 3")) ?? "", /Generated 3 vibes for "pirate"/);
  assert.match(
    provider.requests[0]?.messages[0]?.role === "user" ? provider.requests[0].messages[0].content : "",
    /Generate 3 unique/,
  );
  assert.equal(
    readFileSync(join(hortusDir(), "powerline", "vibes", "pirate.txt"), "utf8"),
    "Hoisting the sails...\nCharting course...\nSwabbing decks...",
  );
  assert.equal(await run("vibe", "mode file"), "Vibe mode set to: file");
  assert.equal(await run("vibe", "pirate"), "Vibe set to: pirate");
  assert.equal(await run("vibe", ""), "Vibe: pirate | Mode: file | Model: auto | File: 3 vibes");
  assert.deepEqual(config().vibe, { mode: "file", theme: "pirate" });
});

test("the layout overflows onto the secondary row, dropping or wrapping what doesn't fit", () => {
  const c = {
    thinking: "high",
    cwd: "/home/u/proj",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    contextTokens: null,
    contextWindow: 0,
    git: { branch: "main", staged: 1, unstaged: 0, untracked: 0 },
    gitHost: null,
    statuses: { a: "alpha", b: "beta" },
    hidden: new Set<string>(),
    custom: new Map(),
    options: {},
    colors: {},
    icons: icons({}),
    startTime: Date.now(),
    rate: () => 1,
  } satisfies SegmentContext;
  const text = (spans: { text: string }[]) => spans.map((s) => s.text).join("");
  const ids = ["thinking", "path", "git", "extension_statuses"] as const;
  const opts = { separator: "pipe" as const, padding: 1, wrap: false };
  const wide = layout(c, PRESETS.default, [...ids], 80, opts);
  assert.equal(text(wide.top), " think:high | dir proj | ⎇ main +1 | alpha · beta ");
  const narrow = layout(c, PRESETS.default, [...ids], 24, opts);
  assert.equal(text(narrow.top), " think:high | dir proj ");
  assert.deepEqual(narrow.secondary.map(text), [" ⎇ main +1 "]);
  const wrapped = layout(c, PRESETS.default, [...ids], 24, { ...opts, wrap: true });
  assert.deepEqual(wrapped.secondary.map(text), [" ⎇ main +1 ", " alpha · beta "]);
  // high thinking is drawn in the rainbow, one color per letter
  assert.ok(new Set(wide.top.filter((s) => /[a-z]/.test(s.text) && s.text.length === 1).map((s) => s.color)).size > 3);
});

test("/cd sets the session's cwd; recent project prompts are only the sessions that ran there", async (t) => {
  t.after(await tempHome({ plugins: { powerline: dir } }));
  const here = await tempDir(t, "powerline-cd-");
  const provider = scripted([{ text: "a" }, { text: "b" }]);
  const agent = await createAgent({
    provided: { "@hortus/cli": version },
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }],
  });
  const other = await openSession(null);
  await agent.run("elsewhere", { session: other });
  const session = await openSession(null);
  await agent.setSession(session);
  const cd = agent.commands().find((c) => c.name === "cd");
  assert.equal(await cd?.run(here), `Working directory: ${here}`);
  assert.equal(session.getState().cwd, here);
  await assert.rejects(async () => cd?.run(join(here, "missing")), /Not a directory/);
  await agent.run("in here");
  assert.equal(agent.ctx.cwd, here);
  assert.deepEqual(await recentPrompts(here), ["in here"]);
  assert.deepEqual(await recentPrompts(process.cwd()), ["elsewhere"]);
});
