import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { type Command, type Ctx, type Named, openSession, tool } from "@hortus/core";
import { scripted, type Turn, tempHome, until } from "@hortus/core/testing";
import { Text } from "ink";
import { z } from "zod";
import {
  type CliPlugin,
  type EntryRenderer,
  type TextEntry,
  type ToolRenderer,
  type ToolSibling,
  useBorderColor,
} from "./api.ts";
import { renderApp, startCli } from "./testing.ts";
import { dark } from "./themes.ts";

const fg = (hex: string) => `38;2;${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;
const bg = (hex: string) => fg(hex).replace(/^38/, "48");

/** The real TUI (`startCli`) with `plugins` and a scripted provider, drawn in color. */
async function tui(
  t: TestContext,
  { plugins = [], turns = [], rows = 16 }: { plugins?: Named[]; turns?: Turn[]; rows?: number } = {},
) {
  t.after(await tempHome({ config: { provider: "scripted", model: "scripted" } }));
  const cli = await startCli({
    extra: [{ name: "scripted", plugin: { providers: { scripted: scripted(turns) } } }, ...plugins],
  });
  t.after(() => cli.close());
  const ui = renderApp(cli, { columns: 60, rows, colors: true });
  t.after(() => ui.app.unmount());
  const plain = () =>
    stripVTControlCharacters(ui.screen())
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n");
  const wait = (cond: (s: string) => boolean) =>
    until(() => cond(plain()), 4000).catch((e) => {
      throw new Error(`${e.message}; screen:\n${plain()}`);
    });
  const idle = () => until(() => !cli.ui.getState().busy, 4000);
  return { cli, ui, plain, wait, idle };
}

test("statuses: colored by theme token, a run's kept per session, a host ctx's host-wide", async (t) => {
  let label = "CI green";
  const plugin: CliPlugin = { on: { run_start: (_, ctx) => ctx.status("ci", { text: label, color: "green" }) } };
  const { cli, ui, wait, idle } = await tui(t, {
    plugins: [{ name: "ci", plugin }],
    turns: [{ text: "a" }, { text: "b" }],
  });
  // a host ctx (kept from init, as mcp-adapter does) has no session: its status is the host's, whatever session shows
  await cli.agent.ctx.status("host", "HOST");
  assert.equal(cli.submit("go"), true);
  await idle();
  await wait((s) => /HOST · CI green/.test(s));
  assert.ok(ui.screen().includes(`${fg(dark.green)}CI green`), "drawn in the token's color");
  const first = cli.session;
  assert.ok(await cli.setSession(await openSession(null)));
  await wait((s) => !/CI green/.test(s) && /HOST/.test(s));
  await cli.agent.ctx.status("host", "HOST 2");
  label = "OTHER";
  assert.equal(cli.submit("go"), true);
  await idle();
  await wait((s) => /HOST 2 · OTHER/.test(s));
  // cleared for every session, not just the shown one
  await cli.agent.ctx.status("host");
  await wait((s) => !/HOST/.test(s));
  assert.ok(await cli.setSession(first, "resume"));
  await wait((s) => /CI green/.test(s) && !/OTHER|HOST/.test(s));
});

test("commands are listed anew: a plugin's commands function and enabled() take effect without a restart", async (t) => {
  const list: Command[] = [];
  let on = true;
  const seen: Ctx[] = [];
  const dyn: CliPlugin = {
    commands: (ctx) => {
      seen.push(ctx);
      return list;
    },
  };
  const { cli } = await tui(t, { plugins: [{ name: "dyn", plugin: dyn }] });
  assert.ok(!cli.commands.some((c) => c.name === "late"));
  list.push({ name: "late", description: "added later", enabled: () => on, run: () => "LATE RAN" });
  assert.ok(cli.commands.some((c) => c.name === "late"));
  assert.equal(seen.at(-1)?.plugin, "dyn");
  assert.equal(cli.submit("/late"), true);
  await until(() => cli.ui.getState().entries.some((e) => "text" in e && e.text === "LATE RAN"));
  on = false;
  assert.ok(!cli.commands.some((c) => c.name === "late"));
  assert.equal(cli.submit("/late"), false, "unknown now");
});

test("cli.complete gets the plugin's host ctx and cli", async (t) => {
  const got: string[] = [];
  const p: CliPlugin = {
    cli: {
      complete: (input, Default, cli, ctx) => {
        got.push(`${ctx.plugin}:${typeof cli.submit}`);
        return input.startsWith("@") ? [{ label: "@here", value: "@here " }] : Default(input);
      },
    },
  };
  const { ui, wait } = await tui(t, { plugins: [{ name: "comp", plugin: p }] });
  ui.keys("@");
  await wait((s) => /@here/.test(s));
  assert.ok(got.includes("comp:function"));
});

const quick = (name: string) =>
  tool({ name, description: "", inputSchema: z.object({}), execute: async () => `${name} out` });

test("tool renderers: tool:** wraps every tool's, chrome drops the background and padding, siblings carry results", async (t) => {
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const views: ToolSibling[][] = [];
  const p: CliPlugin = {
    tools: [
      quick("fast"),
      quick("bare"),
      tool({
        name: "slow",
        description: "",
        inputSchema: z.object({}),
        execute: async () => {
          await gate;
          return "slow out";
        },
      }),
    ],
    cli: {
      entries: {
        "tool:**": {
          // biome-ignore lint/correctness/noComponentHookFactories: made once per test
          Render: ({ Default, ...view }) => {
            if (view.call.name === "slow") views.push(view.siblings ?? []);
            return (
              <>
                <Text>** {view.call.name}</Text>
                <Default {...view} />
              </>
            );
          },
        } satisfies ToolRenderer,
        // biome-ignore lint/correctness/noComponentHookFactories: made once per test
        "tool:bare": { Render: () => <Text>BARE</Text>, chrome: () => ({ background: false, padding: false }) },
      },
    },
  };
  const { cli, ui, plain, wait, idle } = await tui(t, {
    plugins: [{ name: "p", plugin: p }],
    rows: 40,
    turns: [
      {
        toolCalls: [
          { id: "a", name: "fast", input: {} },
          { id: "b", name: "slow", input: {} },
        ],
      },
      { toolCalls: [{ id: "c", name: "bare", input: {} }] },
      { text: "done" },
    ],
  });
  cli.submit("go");
  // the slow call's block learns its sibling's result while it still runs
  await until(() => views.some((s) => s[0]?.result?.output === "fast out" && !s[1]?.result));
  const last = views.at(-1) ?? [];
  assert.deepEqual(
    last.map((s) => s.call.id),
    ["a", "b"],
    "in message order, itself included",
  );
  release();
  await idle();
  await wait((s) => /done/.test(s));
  const screen = plain();
  assert.match(screen, /\*\* fast\n/, "over the generic renderer");
  assert.match(screen, /\*\* bare\nBARE/, "over a tool's own renderer, without padding");
  // the generic blocks have their background; bare's line hasn't
  const bareLine =
    ui
      .screen()
      .split("\n")
      .find((l) => l.includes("BARE")) ?? "";
  assert.ok(ui.screen().includes(bg(dark.toolDone)));
  assert.ok(!bareLine.includes(bg(dark.toolDone)), bareLine);
});

test("cli.scroll moves the transcript to the top, by rows, and back to the bottom", async (t) => {
  const { cli, wait } = await tui(t);
  for (let i = 0; i < 40; i++) cli.push({ kind: "info", text: `line ${i}` });
  await wait((s) => /line 39/.test(s));
  cli.scroll("top");
  await wait((s) => /Session:/.test(s) && !/line 39/.test(s));
  cli.scroll(5);
  await wait((s) => !/Session:/.test(s) && !/line 39/.test(s));
  cli.scroll("bottom");
  await wait((s) => /line 39/.test(s));
});

test("cli.scroll('top') when everything fits doesn't pin: later lines still follow the bottom", async (t) => {
  const { cli, wait } = await tui(t);
  cli.push({ kind: "info", text: "first" });
  await wait((s) => /first/.test(s));
  cli.scroll("top");
  await sleep(50);
  for (let i = 0; i < 40; i++) cli.push({ kind: "info", text: `line ${i}` });
  await wait((s) => /line 39/.test(s));
});

test("prompt prefix and useBorderColor", async (t) => {
  const p: CliPlugin = {
    cli: {
      prompt: ({ Default }) => <Default prefix={<Text color={useBorderColor()}>$$ </Text>} />,
      aboveInput: () => <Text>BORDER {useBorderColor()}</Text>,
    },
  };
  const { cli, ui, wait } = await tui(t, { plugins: [{ name: "p", plugin: p }] });
  await wait((s) => /\$\$ /.test(s) && !/> /.test(s));
  await wait((s) => s.includes(`BORDER ${dark.border}`));
  assert.ok(ui.screen().includes(`${fg(dark.border)}$$`));
  cli.setEffort("high");
  await wait((s) => s.includes(`BORDER ${dark.thinkingHigh}`));
});

test("header heads the transcript; session plugin entries show live and on resume, in order; text entries carry their message", async (t) => {
  const p: CliPlugin = {
    on: {
      run_end: async (_, ctx) => {
        await ctx.session?.appendEntry("p:mark", { n: 1 });
      },
    },
    cli: {
      entries: {
        // biome-ignore lint/correctness/noComponentHookFactories: made once per test
        header: { Render: () => <Text>HEADER</Text> },
        "p:mark": {
          // biome-ignore lint/correctness/noComponentHookFactories: made once per test
          Render: ({ entry }) => <Text>MARK {String((entry.data as { n: number }).n)}</Text>,
        } satisfies EntryRenderer,
      },
    },
  };
  const { cli, wait, idle } = await tui(t, {
    plugins: [{ name: "p", plugin: p }],
    turns: [{ text: "hello there" }],
  });
  await wait((s) => s.split("\n")[0] === "HEADER");
  cli.submit("hi");
  await idle();
  await wait((s) => /hello there\n\nMARK 1/.test(s));
  const entries = cli.ui.getState().entries.filter((e): e is TextEntry => e.kind !== "tool");
  const user = entries.find((e) => e.kind === "user");
  const reply = entries.find((e) => e.kind === "assistant");
  assert.equal(user?.message?.role === "user" && user.message.content, "hi");
  assert.ok(user?.entryId && reply?.entryId);
  assert.equal(reply?.message?.role === "assistant" && reply.message.text, "hello there");
  // resumed: the entry comes back after the message written before it
  const resumed = await startCli({ session: await openSession(cli.session.leafId), extra: [{ name: "p", plugin: p }] });
  t.after(() => resumed.close());
  const kinds = resumed.ui
    .getState()
    .entries.map((e) => e.kind)
    .slice(1);
  assert.deepEqual(kinds, ["user", "assistant", "p:mark"]);
});

test("thinking entries carry when they started and ended, and live while streaming", async (t) => {
  const seen: { live?: boolean; startedAt?: number; endedAt?: number }[] = [];
  const p: CliPlugin = {
    cli: {
      entries: {
        thinking: {
          // biome-ignore lint/correctness/noComponentHookFactories: made once per test
          Render: ({ entry, Default, width }) => {
            seen.push({ live: entry.live, startedAt: entry.startedAt, endedAt: entry.endedAt });
            return <Default entry={entry} width={width} />;
          },
        } satisfies EntryRenderer,
      },
    },
  };
  const { cli, idle, wait } = await tui(t, {
    plugins: [{ name: "p", plugin: p }],
    turns: [
      async (_req, _ctx, cb) => {
        cb?.thinking?.("pondering");
        await sleep(150);
        return { text: "answer" };
      },
    ],
  });
  cli.submit("q");
  await idle();
  await wait((s) => /answer/.test(s));
  assert.ok(seen.some((s) => s.live === true && s.startedAt !== undefined && s.endedAt === undefined));
  const done = cli.ui.getState().entries.find((e): e is TextEntry => e.kind === "thinking");
  assert.ok(done?.startedAt !== undefined && done.endedAt !== undefined);
  assert.ok(done.endedAt - done.startedAt >= 100, String(done.endedAt - done.startedAt));
  assert.ok(!done.live);
});
