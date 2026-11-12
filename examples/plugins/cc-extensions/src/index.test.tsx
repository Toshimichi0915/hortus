import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "@hortus/cli";
import { renderApp, startCli } from "@hortus/cli/testing";
import { createAgent, hortusDir, newSession, openSession } from "@hortus/core";
import { scripted, type Turn, tempDir, tempHome, until } from "@hortus/core/testing";

const dir = fileURLToPath(new URL("..", import.meta.url));
const fg = (hex: string) => `38;2;${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;
const bg = (hex: string) => fg(hex).replace(/^38/, "48");

/** A temp project as the cwd, with `a.txt`. */
async function project(t: TestContext) {
  const cwd = await tempDir(t, "cc-proj-");
  writeFileSync(join(cwd, "a.txt"), "one\nold\nthree\n");
  const prev = process.cwd();
  process.chdir(cwd);
  t.after(() => process.chdir(prev));
  return cwd;
}

/** The real TUI with the plugin linked from its dir, answering with `turns`. */
async function tui(t: TestContext, turns: Turn[], { config = {}, columns = 110, rows = 50 } = {}) {
  t.after(
    await tempHome({
      plugins: { "cc-extensions": dir },
      config: { provider: "scripted", model: "scripted", ...config },
    }),
  );
  writeFileSync(join(hortusDir(), "cc-extensions.json"), JSON.stringify({ footerNerdIcons: false }));
  const provider = scripted(turns);
  const cli = await startCli({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  t.after(() => cli.close());
  const ui = renderApp(cli, { columns, rows, colors: true });
  t.after(() => ui.app.unmount());
  const plain = () =>
    stripVTControlCharacters(ui.screen())
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n");
  const wait = (cond: (s: string) => boolean, ms = 4000) =>
    until(() => cond(plain()), ms).catch((e) => {
      throw new Error(`${e.message}; screen:\n${plain()}`);
    });
  return { cli, ui, provider, plain, wait, last: () => ui.writes.at(-1) ?? "" };
}

test("tool cards, groups, diffs, thinking, run summary, footer and theme draw in Claude Code style", async (t) => {
  const cwd = await project(t);
  const usage = { input: 1000, output: 200, cacheRead: 600, cost: 0.02 };
  const { cli, ui, plain, wait, last } = await tui(
    t,
    [
      (_req, _ctx, cb) => {
        cb?.thinking?.("**Planning the change**\nlook at the files\nthen edit");
        return {
          toolCalls: [
            { id: "r", name: "read", input: { path: join(cwd, "a.txt") } },
            { id: "b", name: "bash", input: { command: "printf 'x\\ny\\n'" } },
          ],
          usage,
        };
      },
      {
        toolCalls: [
          { id: "w", name: "write", input: { path: "new.txt", content: "hello\nworld\n" } },
          { id: "e", name: "edit", input: { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] } },
        ],
        usage,
      },
      { text: "Done ① and ②.", usage },
    ],
    { config: { theme: "cc-dark" } },
  );
  const dark = cli.themes["cc-dark"];
  assert.ok(dark && cli.themes["cc-light"] && cli.themes["cc-dark-hc"] && cli.themes["cc-light-hc"]);
  assert.equal(dark.toolDone, "#0f2a24");
  assert.equal(dark.mdHeading, "#79c0ff");

  // the startup header, the ❯ before the input, and the footer's chips
  await wait((s) => /There are many agent harnesses, but this one is yours\./.test(s) && /██████/.test(s));
  await wait((s) => /│ ❯/.test(s) && /scripted\/scripted/.test(s));
  assert.match(plain(), /cc-proj-\w+/);

  cli.submit("do it");
  await wait((s) => /Done \(1\) and \(2\)\./.test(s) && /Ran 1 command/.test(s));
  const s = plain();
  // one message's read and bash: one group card, a row each
  assert.match(s, /✓ Read×1, Bash×1 {2}2 done/);
  assert.match(s, /├ ✓ Read a\.txt/);
  assert.match(s, /└ ✓ Bash printf 'x\\ny\\n' · \d+(ms|\.\ds)/);
  // write: created, its counts in the body; edit: its diff
  assert.match(s, /✓ Write new\.txt\n.*↳ diff \+2 -0 · created · ctrl\+o to show more/);
  assert.match(s, /✓ Edit a\.txt\n.*↳ diff \+1 -1\n\s+- old\n\s+\+ new/);
  // thinking: its summary title gives way to the duration once done; the last lines show
  assert.match(s, /Thought for \ds\n.*look at the files\n.*then edit/);
  // the turn's summary, and the rate after it
  assert.match(s, /│ Ran 1 command, read 1 file, edited 1 file, wrote 1 file/);
  assert.match(s, /scripted\/scripted · 60% · avg [\d.]+k? tok\/s \(TTFT: [\d.]+s\) · \$0\.06/);
  assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "one\nnew\nthree\n");
  // colors: the success check, the added diff line, the user message's background, all cc-dark's
  await until(() =>
    [fg("#50dc64"), fg(dark.toolDiffAdded ?? ""), bg(dark.userBackground ?? "")].every((c) => last().includes(c)),
  );

  // Ctrl+O: transcript mode, every card expanded; the input and footer give way to its hint; q leaves it
  ui.keys("\x0f");
  await wait((x) => /Showing detailed transcript/.test(x) && /├ Input/.test(x) && /└ Output/.test(x));
  assert.match(plain(), /│ command: printf/);
  assert.doesNotMatch(plain(), /scripted\/scripted/);
  assert.doesNotMatch(plain(), /❯/);
  ui.keys("q");
  await wait((x) => !/Showing detailed transcript/.test(x) && /❯/.test(x));
  assert.equal(cli.ui.getState().expanded, false);

  // compact: a line per message, edit/write titles keep their counts
  cli.submit("/ccstyle compact");
  await wait((x) => /Ran( for \d+s)?, Read×1, Bash×1/.test(x));
  assert.match(plain(), /✓ Write new\.txt \(\+2 -0\)/);
  assert.match(plain(), /✓ Edit a\.txt \(\+1 -1\)/);
  assert.doesNotMatch(plain(), /├ ✓ Read/);
  // off: hortus's own renderers
  cli.submit("/ccstyle off");
  await wait((x) => /read .*a\.txt/.test(x) && /\$ printf/.test(x));
  await until(() => JSON.parse(readFileSync(join(hortusDir(), "cc-extensions.json"), "utf8")).mode === "off");
});

test("@ completes other sessions; a reference adds that session's transcript as context", async (t) => {
  await project(t);
  t.after(await tempHome({ plugins: { "cc-extensions": dir } }));
  const old = newSession();
  await old.setName("auth refactor");
  await old.append([
    { role: "user", content: "rename the token helper" },
    { role: "assistant", text: "Renamed it to issueToken.", toolCalls: [] },
  ]);
  const provider = scripted([{ text: "ok" }]);
  const cli = await startCli({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  t.after(() => cli.close());
  const ui = renderApp(cli, { columns: 100, rows: 30 });
  t.after(() => ui.app.unmount());
  ui.keys("what did we do in @auth");
  await until(() => /\[Session\] auth refactor/.test(ui.screen()));
  ui.keys("\t");
  await until(() => cli.ui.getState().input === `what did we do in @session:[${old.id}] `);
  ui.keys("\r");
  await until(() => provider.requests.length === 1 && /Referenced 1 session/.test(ui.screen()));
  const sent = provider.requests[0]?.messages.map((m) => (m.role === "user" ? m.content : "")).join("\n") ?? "";
  assert.match(sent, /## Referenced hortus sessions/);
  assert.match(sent, /### auth refactor/);
  assert.match(sent, /User: rename the token helper\n\nAssistant: Renamed it to issueToken\./);
  assert.match(ui.screen(), /auth refactor/);
});

test("/context reports the context's parts; /ccstyle's panel and the working row", async (t) => {
  await project(t);
  let release = () => {};
  const { cli, ui, wait, provider } = await tui(t, [() => new Promise((r) => (release = () => r({ text: "fine" })))]);
  writeFileSync(join(hortusDir(), "AGENTS.md"), "Always answer in haiku. ".repeat(40));

  // headless (the harness alone): the command's plain text
  const agent = await createAgent({
    provided: { "@hortus/cli": version },
    extra: [{ name: "scripted", plugin: { providers: { scripted: scripted([]) } } }],
  });
  t.after(() => agent.close());
  const text = await agent
    .commands()
    .find((c) => c.name === "context")
    ?.run("");
  assert.match(
    text ?? "",
    /^Context usage · scripted\/scripted · \d+\/\? tokens\nSystem prompt: \d+ tokens\nMemory files: 2\d\d tokens/,
  );

  // the TUI: Claude Code's grid and the memory files
  cli.submit("/context");
  await wait(
    (s) => /Context Usage/.test(s) && /⛁ Memory files: 2\d\d tokens/.test(s) && /└ .*AGENTS\.md: 2\d\d tokens/.test(s),
  );

  // the panel: an ask listing the settings; picking one flips it, Esc closes
  cli.submit("/ccstyle");
  await wait((s) => /Claude Code style settings/.test(s) && /mode\s+on/.test(s));
  ui.keys("enableCustomFooter");
  await wait((s) => /enableCustomFooter\s+on/.test(s) && !/\bmode\s+on/.test(s));
  ui.keys("\r");
  // asked again, with the new value
  await wait((s) => /\bmode\s+on/.test(s));
  ui.keys("enableCustomFooter");
  await wait((s) => /enableCustomFooter\s+off/.test(s));
  ui.keys("\x1b");
  await wait((s) => /Claude Code style: enableCustomFooter=false/.test(s));
  assert.equal(JSON.parse(readFileSync(join(hortusDir(), "cc-extensions.json"), "utf8")).enableCustomFooter, false);

  // the working row while a turn runs
  cli.submit("go");
  await wait((s) => /Working\.\.\./.test(s));
  await until(() => provider.requests.length === 1);
  release();
  await wait((s) => /fine/.test(s) && !/Working\.\.\./.test(s));
  assert.equal(cli.ui.getState().busy, false);

  // /exit exits
  cli.submit("/exit");
  await until(() => cli.ui.getState().exiting);
});

test("a resumed session shows its compaction, skill and run summary lines", async (t) => {
  await project(t);
  t.after(await tempHome({ plugins: { "cc-extensions": dir } }));
  const session = newSession();
  const [, , skill] = await session.append([
    { role: "user", content: "old question" },
    { role: "assistant", text: "old answer", toolCalls: [] },
    { role: "user", content: '<skill name="review" location="/x/SKILL.md">\nbody\n</skill>\n\nthe diff' },
    { role: "assistant", text: "Reviewed.", toolCalls: [] },
  ]);
  await session.appendEntry("builtin:compaction:compaction", {
    summary: "we asked and answered",
    tokensBefore: 4321,
    firstKeptId: skill?.entryId,
  });
  const summary = { commands: 2, reads: 1, edits: 0, writes: 0, others: 0, failed: 0, durationMs: 5000 };
  await session.appendEntry("cc-extensions:agent-summary", summary);
  const cli = await startCli({ session: await openSession(session.leafId) });
  t.after(() => cli.close());
  const ui = renderApp(cli, { columns: 100, rows: 40 });
  t.after(() => ui.app.unmount());
  const plain = () => stripVTControlCharacters(ui.screen());
  await until(() => /Reviewed\./.test(plain())).catch(() => assert.fail(plain()));
  const s = plain();
  assert.match(s, /✓ Compacted from 4,321 tokens/);
  assert.match(s, /✓ Skill review/);
  assert.match(s, /Reviewed\.\n\n.*│ Ran 2 commands, read 1 file · 5s/);
  assert.doesNotMatch(s, /old answer/);
});
