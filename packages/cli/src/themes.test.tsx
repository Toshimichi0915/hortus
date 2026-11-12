import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { scripted, tempHome } from "@hortus/core/testing";
import type { CliPlugin } from "./api.ts";
import { renderApp, startCli } from "./testing.ts";
import { dark } from "./themes.ts";

/** Retries `check` until it passes, or rethrows its last failure after `ms`: Ink draws asynchronously. */
async function until(check: () => void, ms = 3000) {
  for (const end = Date.now() + ms; ; await sleep(10))
    try {
      return check();
    } catch (e) {
      if (Date.now() > end) throw e;
    }
}

test("config.theme colors the very first frame, and /theme redraws the prompt and the ask dialog without a key", async (t) => {
  const restore = await tempHome({ config: { provider: "scripted", model: "scripted", theme: "blue" } });
  const blue = { ...dark, border: "#0000fe", accent: "#0000fd" };
  const red = { ...dark, border: "#fe0000", accent: "#fd0000" };
  const pack: CliPlugin = { cli: { themes: { blue, red } }, providers: { scripted: scripted([]) } };
  const cli = await startCli({ extra: [{ name: "pack", plugin: pack }] });
  const term = renderApp(cli, { colors: true });
  // closed before HOME is restored: the setTheme saves still queued land in this test's home
  t.after(async () => {
    term.app.unmount();
    await cli.close();
    await restore();
  });
  const fg = (hex: string) => `38;2;${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;
  const last = () => term.writes.at(-1) ?? "";
  await until(() => assert.ok(term.writes[0]?.includes(fg(blue.border)), "the first frame's prompt border is blue's"));
  cli.setTheme("red");
  await until(() => assert.ok(last().includes(fg(red.border)), "the prompt border redraws in red"));
  const asked = cli.agent.ctx.ask({ question: "Deploy?", options: [{ label: "yes" }] });
  await until(() => assert.ok(last().includes(fg(red.accent)) && last().includes("Deploy?")));
  cli.setTheme("blue");
  await until(() => assert.ok(last().includes(fg(blue.accent)), "the open dialog redraws in blue"));
  cli.ui.getState().asks[0]?.resolve(undefined);
  assert.equal(await asked, undefined);
  cli.setTheme("dark");
});

test("role tokens color what they name: a heading in mdHeading, the prompt border in the effort's thinking<Level>", async (t) => {
  const restore = await tempHome();
  const roles = { mdHeading: "#00fe01", thinkingHigh: "#0000fc", border: "#fe0002" };
  const cli = await startCli({
    extra: [
      {
        name: "pack",
        plugin: { cli: { themes: { roles } }, providers: { scripted: scripted([{ text: "# Title" }]) } } as CliPlugin,
      },
    ],
  });
  cli.setTheme("roles");
  const ui = renderApp(cli, { colors: true });
  t.after(async () => {
    ui.app.unmount();
    await cli.close();
    await restore();
  });
  const fg = (hex: string) => `38;2;${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;
  const last = () => ui.writes.at(-1) ?? "";
  await until(() => assert.ok(last().includes(fg(roles.border)), "auto effort: border"));
  cli.submit("hi");
  await until(() => assert.ok(last().includes("Title") && last().includes(fg(roles.mdHeading))));
  cli.setEffort("high");
  await until(() => assert.ok(last().includes(fg(roles.thinkingHigh)) && !last().includes(fg(roles.border))));
  cli.setTheme("dark");
});

test("a selection is drawn on selectedBg, or inverted when that's the background under it or empty", async (t) => {
  const restore = await tempHome();
  const same = { ...dark, selectedBg: dark.userBackground };
  const none = { ...dark, selectedBg: "" };
  const pack: CliPlugin = { cli: { themes: { same, none } }, providers: { scripted: scripted([{ text: "ok" }]) } };
  const cli = await startCli({ extra: [{ name: "pack", plugin: pack }] });
  const ui = renderApp(cli, { colors: true });
  t.after(async () => {
    ui.app.unmount();
    await cli.close();
    await restore();
  });
  const bg = (hex: string) => `48;2;${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;
  const last = () => ui.writes.at(-1) ?? "";
  cli.submit("hello");
  await until(() => assert.match(ui.screen(), /ok/));
  const y = ui.frame().findIndex((l) => l.includes("hello")) + 1;
  // drag over "ell" of the user message
  ui.keys(`\x1b[<0;3;${y}M\x1b[<32;5;${y}M`);
  assert.notEqual(dark.selectedBg, dark.userBackground);
  await until(() => assert.ok(last().includes(bg(dark.selectedBg)), "dark: on its own selectedBg"));
  for (const name of ["same", "none"]) {
    cli.setTheme(name);
    await until(() => assert.ok(last().includes("\x1b[7m") && !last().includes(bg(dark.selectedBg)), name));
  }
  cli.setTheme("dark");
});
