import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { stdout } from "node:process";
import { createAgent, type LoadOptions, listSessions, loadSecrets, openSession, type SessionInfo } from "@phi/core";
import { render } from "ink";
import { App } from "./app.tsx";
import { createCli } from "./cli.ts";
import { SessionPicker } from "./session-picker.tsx";

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
// `phi -r <id>` resumes that session, `phi -r` picks one from a list
const [flag, id, ...rest] = process.argv.slice(2);
const fail = (message: string) => {
  console.error(message);
  process.exit(1);
};
if ((flag && flag !== "-r") || rest.length) fail("usage: phi [-r [session_id]]");
let resume: SessionInfo | undefined;
if (flag) {
  const sessions = await listSessions();
  if (id) {
    resume = sessions.find((s) => s.id === id);
    if (!resume) fail(`Session not found: ${id}`);
  } else {
    if (!sessions.length) fail("No sessions to resume");
    await render(<SessionPicker sessions={sessions} onPick={(s) => (resume = s)} />, {
      exitOnCtrlC: false,
    }).waitUntilExit();
    if (!resume) process.exit(0);
  }
}
const session = await openSession(resume?.leafId ?? null);
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
