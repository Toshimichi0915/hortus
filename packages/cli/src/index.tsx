#!/usr/bin/env node
import { registerHooks } from "node:module";
import { stdout } from "node:process";
import { createAgent, type LoadOptions, listSessions, openSession, type SessionInfo } from "@hortus/core";
import { render } from "ink";
import { version } from "./api.ts";
import { App } from "./app.tsx";
import { cliPieces } from "./builtin/index.ts";
import { createCli, MOUSE_OFF, MOUSE_ON } from "./cli.ts";
import { applyFlags, flaggedSession, flagOptions, parseFlags, USAGE } from "./flags.ts";
import { printMode, rpcMode } from "./headless.ts";
import { SessionPicker } from "./session-picker.tsx";

// a plugin's react/ink/@hortus imports resolve from here, so its components run on our React and Ink (two Reacts break
// hooks). Every importer, not just ~/.hortus/plugins: a symlinked plugin's realpath lies outside it.
const shared = /^(react|ink|@hortus\/(core|cli))(\/|$)/;
registerHooks({ resolve: (s, c, next) => next(s, shared.test(s) ? { ...c, parentURL: import.meta.url } : c) });

// plugins can depend on "@hortus/cli" in their hortus.json; that's us. Our commands load like core's pieces.
const load: LoadOptions = { provided: { "@hortus/cli": version }, pieces: cliPieces };

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const flags = (() => {
  try {
    return parseFlags(process.argv.slice(2));
  } catch (e) {
    return fail(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
  }
})();
// stdout carries the answer or JSON lines: a plugin's console.log goes to stderr (set before any plugin loads)
if (flags.print || flags.rpc) console.log = console.info = console.debug = console.error;
const fromFlags = await flagOptions(flags).catch((e) => fail(`Loading --plugin failed: ${e.message}`));
if (flags.cwd) process.chdir(flags.cwd);
// the host's options, the flags', then the mode's (its observer last)
const makeAgent = (opts: LoadOptions) =>
  createAgent({ ...load, ...fromFlags, ...opts, extra: [...(fromFlags.extra ?? []), ...(opts.extra ?? [])] });

if (flags.print || flags.rpc) {
  const code = await (flags.print ? printMode : rpcMode)(flags, makeAgent).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  });
  // a tool may ignore its signal; stdout is flushed before exiting
  process.stdout.write("", () => process.exit(code));
} else {
  // `hortus -r <id>` resumes that session, `hortus -r` picks one from a list
  let resume: SessionInfo | undefined;
  if (flags.resume) {
    const sessions = await listSessions();
    if (typeof flags.resume === "string") {
      resume = sessions.find((s) => s.id === flags.resume);
      if (!resume) fail(`Session not found: ${flags.resume}`);
    } else {
      if (!sessions.length) fail("No sessions to resume");
      await render(<SessionPicker sessions={sessions} onPick={(s) => (resume = s)} />, {
        exitOnCtrlC: false,
      }).waitUntilExit();
      if (!resume) process.exit(0);
    }
  }
  const session = resume
    ? await openSession(resume.leafId)
    : await flaggedSession(flags.session).catch((e) => fail(e.message));
  await applyFlags(session, flags);
  const cli = await createCli(session, makeAgent);
  if (flags.prompt) cli.submit(flags.prompt);
  // report button presses, drags and wheel; always switched back off on exit
  stdout.write(MOUSE_ON);
  process.on("exit", () => stdout.write(MOUSE_OFF));
  await render(<App cli={cli} />, {
    alternateScreen: true,
    exitOnCtrlC: false,
    // lets the terminal report Shift+Enter apart from Enter
    kittyKeyboard: { mode: "auto" },
  }).waitUntilExit();
  await cli.close();
  // a turn may still be running (a tool, or a request that ignores the abort)
  process.exit(0);
}
