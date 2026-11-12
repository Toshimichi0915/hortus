import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { AskEvent, Ctx, Named } from "@hortus/core";
import { scripted, type Turn, tempHome, until } from "@hortus/core/testing";
import { renderToString, Text } from "ink";
import { type Cli, type CliPlugin, createStore, type StoreApi, usePluginCtx, useStore } from "./api.ts";
import { renderApp, startCli } from "./testing.ts";
import { theme } from "./themes.ts";

/** The TUI as `hortus` starts it (`startCli`), drawn by `renderApp`. */
async function tui(t: TestContext, plugins: Named[] = [], turns: Turn[] = []) {
  const restore = await tempHome();
  const provider = scripted(turns);
  const cli = await startCli({
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }, ...plugins],
  });
  const ui = renderApp(cli);
  // closed before HOME is restored: config.json saves still queued (/theme) land in this test's home
  t.after(async () => {
    ui.app.unmount();
    await cli.close();
    await restore();
  });
  await sleep(50);
  return { cli, provider, ...ui };
}

/** A turn that answers once `release` is called, so the TUI stays busy meanwhile. */
function gate(text: string) {
  let release = () => {};
  const turn: Turn = () => new Promise((r) => (release = () => r({ text })));
  return { turn, release: () => release() };
}

test("startCli loads the cli:* pieces like hortus does: /theme runs", async (t) => {
  const { cli, screen } = await tui(t);
  assert.ok(cli.commands.some((c) => c.name === "theme"));
  cli.submit("/theme");
  await until(() => /dark/.test(screen()));
});

test("cli.keys sees keys before the prompt and can take them: a taken Esc doesn't abort, Alt+Enter inserts nothing", async (t) => {
  const seen: string[] = [];
  const plugin: CliPlugin = {
    cli: {
      keys: (input, key) => {
        seen.push(key.escape ? "esc" : key.return ? (key.meta ? "alt+enter" : "enter") : input);
        return key.escape || (key.return && key.meta) || input === "z";
      },
    },
  };
  const first = gate("done");
  const { cli, keys, provider } = await tui(t, [{ name: "keys", plugin }], [first.turn]);
  keys("a");
  await until(() => cli.ui.getState().input === "a");
  keys("z");
  await sleep(30);
  assert.equal(cli.ui.getState().input, "a");
  keys("\x1b\r");
  await sleep(30);
  assert.equal(cli.ui.getState().input, "a");
  cli.submit("go");
  await until(() => provider.requests.length === 1);
  keys("\x1b");
  await sleep(50);
  assert.equal(cli.ui.getState().busy, true, "the run wasn't aborted");
  first.release();
  await until(() => !cli.ui.getState().busy);
  assert.deepEqual(seen, ["a", "z", "alt+enter", "esc"]);
});

test("cli.submit wraps the built-in submit: a plugin sends while a turn runs, which the built-in refuses", async (t) => {
  let host: Cli | undefined;
  const plugin: CliPlugin = {
    cli: {
      init: (cli) => {
        host = cli;
      },
      submit: (value, Default, cli) => {
        if (!cli.ui.getState().busy || value.startsWith("/")) return Default(value);
        void cli.agent.ctx.send(value, { deliver: "steer" });
        cli.setInput("");
        return true;
      },
    },
  };
  const first = gate("working");
  const { cli, keys, provider } = await tui(t, [{ name: "steer", plugin }], [first.turn, { text: "steered" }]);
  assert.equal(host, cli);
  cli.submit("do X");
  await until(() => provider.requests.length === 1);
  keys("also Y");
  await until(() => cli.ui.getState().input === "also Y");
  keys("\r");
  await until(() => cli.ui.getState().input === "");
  first.release();
  await until(() => provider.requests.length === 2 && !cli.ui.getState().busy);
  const users = provider.requests[1]?.messages.flatMap((m) => (m.role === "user" ? [m.content] : []));
  assert.deepEqual(users, ["do X", "also Y"]);
});

test("cli.setInput places the caret; UiState.caret follows typing; cli.copy writes OSC 52 and shows the count", async (t) => {
  const { cli, keys, screen, writes } = await tui(t);
  cli.setInput("world", { caret: 0 });
  await sleep(20);
  keys("hello ");
  await until(() => cli.ui.getState().input === "hello world");
  assert.equal(cli.ui.getState().caret, 6);
  // the same text, the caret moved
  cli.setInput("hello world", { caret: 11 });
  await sleep(20);
  keys("!");
  await until(() => cli.ui.getState().input === "hello world!");
  cli.copy("abc");
  assert.ok(writes.some((w) => w.includes(`\x1b]52;c;${Buffer.from("abc").toString("base64")}\x07`)));
  await until(() => /Copied 3 chars/.test(screen()));
});

test("the generic dialog filters its options as you type; its first key engages the ask, which was shown", async (t) => {
  const events: AskEvent[] = [];
  const watch: Named = { name: "watch", plugin: { on: { ask: (p) => void events.push(p) } } };
  const { cli, keys, screen } = await tui(t, [watch]);
  const options = ["alpha", "beta", "gamma", "delta"].map((label) => ({ label }));
  const asked = cli.agent.ctx.ask({ question: "Pick", options }, { detailed: true });
  await until(() => /gamma/.test(screen()));
  const [e] = events;
  assert.ok(e);
  let shown = false;
  let engaged = false;
  void e.shown.then(() => (shown = true));
  void e.engaged.then(() => (engaged = true));
  await sleep(10);
  assert.deepEqual([shown, engaged], [true, false]);
  keys("lt");
  await until(() => /filter: lt/.test(screen()) && !/gamma/.test(screen()));
  assert.equal(engaged, true);
  assert.match(screen(), /delta/);
  keys("\r");
  assert.deepEqual(await asked, { answer: "delta", by: "@hortus/cli", reason: "answered" });
});

test("a partial theme is merged over dark, role tokens fall back to its own generic ones, plugin tokens are kept", async (t) => {
  const plugin: CliPlugin = { cli: { themes: { part: { yellow: "#fe0000", myToken: "#123456" } } } };
  const { cli } = await tui(t, [{ name: "pack", plugin }]);
  cli.setTheme("part");
  assert.equal(theme.yellow, "#fe0000");
  assert.equal(theme.mdHeading, "#fe0000", "a role left out copies its generic token");
  assert.equal(theme.text, "#dee0e1", "a generic token left out is dark's");
  assert.equal(theme.myToken, "#123456");
  cli.setTheme("dark");
  assert.equal(theme.myToken, undefined, "a switch drops the previous theme's own tokens");
});

test("interactive fires once the TUI shows asks: a question held back at startup reaches the dialog", async (t) => {
  const seen: boolean[] = [];
  const plugin: CliPlugin = {
    on: {
      ready: (_, ctx) => void seen.push(ctx.host.interactive),
      interactive: async (_, ctx) => {
        seen.push(ctx.host.interactive);
        await ctx.ask({ question: "Trust this project?", options: [{ label: "Trust" }] });
      },
    },
  };
  const { screen } = await tui(t, [{ name: "trust", plugin }]);
  await until(() => /Trust this project\?/.test(screen()));
  assert.deepEqual(seen, [false, true]);
});

const storeOf = (ctx: Ctx) => {
  ctx.state.store ??= createStore(() => ({ n: 0 }));
  return ctx.state.store as StoreApi<{ n: number }>;
};
const seen: Ctx[] = [];
function Count() {
  const ctx = usePluginCtx();
  seen.push(ctx);
  return <Text>{`count=${useStore(storeOf(ctx), (s) => s.n)}`}</Text>;
}

test("a plugin's keys, submit and components get its host ctx: one ctx.state, a store in it re-renders them", async (t) => {
  const plugin: CliPlugin = {
    on: { init: (_, ctx) => void storeOf(ctx) },
    cli: {
      aboveInput: ({ Default }) => (
        <>
          <Count />
          <Default />
        </>
      ),
      keys: (input, _key, _cli, ctx) => {
        if (input !== "+") return false;
        storeOf(ctx).setState((s) => ({ n: s.n + 1 }));
        return true;
      },
      submit: (value, Default, _cli, ctx) => {
        if (value !== "reset") return Default(value);
        storeOf(ctx).setState({ n: 100 });
        return true;
      },
    },
  };
  const { cli, keys, screen } = await tui(t, [{ name: "counter", plugin }]);
  await until(() => screen().includes("count=0"));
  keys("+");
  await until(() => screen().includes("count=1"));
  keys("+");
  await until(() => screen().includes("count=2"));
  assert.equal(cli.ui.getState().input, "");
  assert.equal(cli.submit("reset"), true);
  await until(() => screen().includes("count=100"));
  assert.equal(seen[0]?.state, cli.agent.ctxOf?.("counter").state);
  assert.throws(() => renderToString(<Count />), /usePluginCtx only works/);
});
