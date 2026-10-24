import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { stdout } from "node:process";
import { createAgent, type LoadOptions, loadSecrets, openSession } from "@phi/core";
import { render } from "ink";
import { App } from "./app.tsx";
import { createCli } from "./cli.ts";

// a plugin's react/ink/@phi imports resolve from here, so its components run on our React and Ink (two Reacts break
// hooks). Every importer, not just ~/.phi/plugins: a symlinked plugin's realpath lies outside it.
const shared = /^(react|ink|@phi\/(core|cli))(\/|$)/;
registerHooks({ resolve: (s, c, next) => next(s, shared.test(s) ? { ...c, parentURL: import.meta.url } : c) });

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
// plugins can depend on "@phi/cli" in their phi.json; that's us
const load: LoadOptions = { provided: { "@phi/cli": version } };

// the names configured in secrets.json (for /provider)
const providers = Object.keys(await loadSecrets());
const session = await openSession(null);
const cli = await createCli(session, providers, (observer) => createAgent({ ...load, extra: [observer] }));
// report button presses, drags and wheel (1002) in SGR encoding (1006); always switched back off on exit
stdout.write("\x1b[?1002h\x1b[?1006h");
process.on("exit", () => stdout.write("\x1b[?1002l\x1b[?1006l"));
await render(<App cli={cli} />, {
  alternateScreen: true,
  exitOnCtrlC: false,
  // lets the terminal report Shift+Enter apart from Enter
  kittyKeyboard: { mode: "auto" },
}).waitUntilExit();
// the alternate screen is gone on exit, so leave the conversation in normal scrollback
for (const e of cli.ui.getState().entries)
  console.log(`${e.kind !== "info" && e.kind !== "error" ? "\n" : ""}${e.text}`);
