import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { renderApp, startCli } from "@hortus/cli/testing";
import { scripted, tempHome } from "@hortus/core/testing";

const dir = fileURLToPath(new URL("..", import.meta.url));
const fg = (hex: string) => `38;2;${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;
const bg = (hex: string) => fg(hex).replace(/^38/, "48");

async function until(check: () => void, ms = 3000) {
  for (const end = Date.now() + ms; ; await sleep(10))
    try {
      return check();
    } catch (e) {
      if (Date.now() > end) throw e;
    }
}

test("the pack's Pi themes register, map onto hortus tokens, and /theme recolors the drawn TUI", async (t) => {
  t.after(
    await tempHome({
      config: { provider: "scripted", model: "scripted", theme: "cyber-mint" },
      plugins: { themes: dir },
    }),
  );
  const provider = scripted([{ text: "# Plan\n\nsee [docs](https://x.dev)" }]);
  const cli = await startCli({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  const names = ["arctic-aurora", "crimson-noir", "cyber-mint", "ember-sunset", "enchanted-forest", "halcyon-rivet"];
  for (const n of names) assert.ok(cli.themes[n], `${n} registered`);
  // cyber-mint.json, its vars resolved; "" (terminal default) stays ""
  const mint = cli.themes["cyber-mint"];
  const noir = cli.themes["crimson-noir"];
  assert.ok(mint && noir);
  assert.deepEqual(
    [mint.text, mint.border, mint.borderIdle, mint.green, mint.blue, mint.userBackground, mint.toolDone],
    ["", "#55a399", "#1f403b", "#34d399", "#60a5fa", "#0b211e", "#0b3328"],
  );
  // Pi's role tokens are hortus's (headings no longer in warning yellow), and its others are kept for plugins
  assert.ok(mint.mdHeading && mint.mdHeading !== mint.yellow);
  assert.ok(mint.thinkingHigh && mint.selectedBg && mint.syntaxKeyword);
  assert.equal(cli.ui.getState().theme, "cyber-mint");

  const ui = renderApp(cli, { colors: true });
  t.after(() => ui.app.unmount());
  const last = () => ui.writes.at(-1) ?? "";
  await until(() => assert.ok(ui.writes[0]?.includes(fg(mint.border ?? "")), "config.theme draws the first frame"));

  cli.submit("hi");
  await until(() => assert.match(last(), /docs/));
  // the user message's background, the heading and the markdown link, in cyber-mint
  await until(() =>
    assert.ok(
      [bg(mint.userBackground ?? ""), fg(mint.mdHeading ?? ""), fg(mint.mdLink ?? "")].every((c) => last().includes(c)),
    ),
  );

  cli.submit("/theme crimson-noir");
  await until(() => {
    const out = last();
    assert.ok(out.includes(fg(noir.border ?? "")), "prompt border");
    assert.ok(out.includes(bg(noir.userBackground ?? "")), "user message background");
    assert.ok(out.includes(fg(noir.mdHeading ?? "")), "heading");
    assert.ok(
      !out.includes(fg(mint.border ?? "")) && !out.includes(bg(mint.userBackground ?? "")),
      "no cyber-mint left",
    );
  });
  await until(() =>
    assert.equal(JSON.parse(readFileSync(join(homedir(), ".hortus", "config.json"), "utf8")).theme, "crimson-noir"),
  );
});
