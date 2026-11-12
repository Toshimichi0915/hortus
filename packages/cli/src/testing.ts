/** Helpers for tests of CLI plugins: `@hortus/cli/testing`. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { createAgent, type LoadOptions, openSession, type Session } from "@hortus/core";
import { render } from "ink";
import { createElement } from "react";
import { hortusBin, version } from "./api.ts";
import { App } from "./app.tsx";
import { cliPieces } from "./builtin/index.ts";
import { type Cli, createCli } from "./cli.ts";

export { hortusBin } from "./api.ts";
export { App, composeAsks, composeEntries, composeSlots, composeTools } from "./app.tsx";
export { createCli } from "./cli.ts";

/**
 * `createCli` as `hortus` itself sets it up: the `cli:*` pieces (`/theme`, `/model`...), `provided: { "@hortus/cli" }`,
 * then `opts` (its `extra` before the TUI's observer), on `session` (default a new one).
 */
export async function startCli({ session, ...opts }: LoadOptions & { session?: Session } = {}): Promise<Cli> {
  return createCli(session ?? (await openSession(null)), (o) =>
    createAgent({
      provided: { "@hortus/cli": version },
      ...opts,
      ...o,
      pieces: [...cliPieces, ...(opts.pieces ?? [])],
      extra: [...(opts.extra ?? []), ...(o.extra ?? [])],
    }),
  );
}

// Ink's chalk: colors are off when stdout isn't a terminal, and FORCE_COLOR only counts before chalk loads
const chalk: { level: number } = (await import(createRequire(import.meta.resolve("ink")).resolve("chalk"))).default;

/**
 * Draws `cli`'s App into a fake `terminal` (`debug`, no Ctrl+C exit, console left alone); `colors: true` turns on
 * truecolor until it's unmounted (Ink draws none without a real terminal), to check what colors are drawn.
 * Unmount it when done (`t.after(() => ui.app.unmount())`).
 */
export function renderApp(cli: Cli, { columns = 60, rows = 20, colors = false } = {}) {
  const term = terminal(columns, rows);
  const level = chalk.level;
  if (colors) chalk.level = 3;
  const app = render(createElement(App, { cli }), {
    stdin: term.stdin as never,
    stdout: term.stdout as never,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  const restore = () => {
    chalk.level = level;
  };
  if (colors) app.waitUntilExit().then(restore, restore);
  return {
    ...term,
    app,
    /** the last frame, as one string */
    screen: () => term.frame().join("\n"),
    /** writes keys (raw terminal input, e.g. "\r", "\x1b[B") */
    keys: (k: string) => void term.stdin.write(k),
  };
}

/**
 * A terminal for Ink's `render` (`{ stdin, stdout, debug: true }`): keys written to `stdin`, raw-mode switches in `raw`,
 * every write in `writes`, and the last frame drawn (debug mode draws whole frames), trimmed per line.
 */
export function terminal(columns = 60, rows = 20) {
  const raw: boolean[] = [];
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (on: boolean) => raw.push(on),
    ref: () => {},
    unref: () => {},
  });
  let frame = "";
  const writes: string[] = [];
  const stdout = Object.assign(
    new Writable({
      write: (chunk, _enc, done) => {
        frame = String(chunk);
        writes.push(frame);
        done();
      },
    }),
    { columns, rows, isTTY: true },
  );
  return { stdin, stdout, raw, writes, frame: () => frame.split("\n").map((l) => l.trimEnd()) };
}

/**
 * Spawns `hortus ...args` (`HOME` as it is now, e.g. a `tempHome`), killed after test `t` if still running. `lines` are
 * its stdout's JSON lines so far (`--json`, `--rpc`), `next(pred)` waits for one (from the first not yet taken by an
 * earlier `next`), `send(obj)` writes one to its stdin, `exit` resolves with its exit code.
 */
export function spawnHortus(t: { after(fn: () => unknown): void }, args: string[], { cwd }: { cwd?: string } = {}) {
  const child = spawn(process.execPath, [hortusBin, ...args], { env: { ...process.env }, cwd, stdio: "pipe" });
  const exit = once(child, "close").then(([code, signal]) => (code ?? signal) as number | string);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exit;
    }
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  // biome-ignore lint/suspicious/noExplicitAny: JSON lines of any shape
  const lines: any[] = [];
  let waiters: (() => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (l) => {
    stdout += `${l}\n`;
    try {
      lines.push(JSON.parse(l));
    } catch {}
    for (const w of waiters) w();
  });
  let taken = 0;
  return {
    child,
    lines,
    exit,
    stdout: () => stdout,
    stderr: () => stderr,
    send: (obj: unknown) => void child.stdin.write(`${JSON.stringify(obj)}\n`),
    // biome-ignore lint/suspicious/noExplicitAny: JSON lines of any shape
    next: (pred: (line: any) => boolean, ms = 10000): Promise<any> =>
      new Promise((resolve, reject) => {
        const check = () => {
          const i = lines.findIndex((l, n) => n >= taken && pred(l));
          if (i < 0) return false;
          taken = i + 1;
          waiters = waiters.filter((w) => w !== tick);
          clearTimeout(timer);
          resolve(lines[i]);
          return true;
        };
        const tick = () => void check();
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== tick);
          reject(new Error(`next: no such line in ${ms}ms; stderr: ${stderr}`));
        }, ms);
        if (!check()) waiters.push(tick);
      }),
  };
}
