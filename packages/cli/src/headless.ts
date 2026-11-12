import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  Agent,
  AskEvent,
  Ctx,
  Host,
  LoadOptions,
  Message,
  Plugin,
  RunEnd,
  RunOptions,
  Session,
} from "@hortus/core";
import { applyFlags, type Flags, flaggedSession } from "./flags.ts";

/** JSON for a line: errors as `{ name, message }`, sessions as `{ id, path? }`; functions, signals and promises left out. */
const replacer = (_: string, v: unknown) => {
  if (v instanceof Error) return { name: v.name, message: v.message };
  if (v instanceof AbortSignal || v instanceof Promise) return undefined;
  if (v && typeof v === "object" && "leafId" in v && "getState" in v) {
    const { id, path } = v as Session;
    return { id, ...(path && { path }) };
  }
  return v;
};

/** Writes `line` to stdout as one JSON line (a payload that can't be serialized is left out). */
function writeLine(line: Record<string, unknown>) {
  let text: string;
  try {
    text = JSON.stringify(line, replacer);
  } catch {
    const { payload: _, ...rest } = line;
    text = JSON.stringify({ ...rest, unserializable: true }, replacer);
  }
  process.stdout.write(`${text}\n`);
}

/** The event line of `name`: `{ event, payload, run }` (`run` is the ctx's `RunInfo`, absent outside a run). */
const eventLine = (event: string, payload: unknown, ctx?: Ctx) => writeLine({ event, payload, run: ctx?.run });

/** A plugin seeing every event (its `on` is a proxy), `handle` choosing what to do with each. */
const everyEvent = (handle: (name: string, payload: unknown, ctx: Ctx) => unknown): Plugin => ({
  on: new Proxy({}, { get: (_, name) => (p: unknown, ctx: Ctx) => handle(String(name), p, ctx) }),
});

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

/** What both modes share: the session from the flags (`check` may refuse it before the flags write to it), and `LoadOptions` reporting errors as `json` lines or to stderr. */
async function setup(f: Flags, json: boolean, check?: (messages: Message[]) => void) {
  const session = await flaggedSession(f.session, f.parent);
  await applyFlags(session, f, check);
  const onError = json
    ? (plugin: string, e: Error) => writeLine({ error: e.message, plugin })
    : (plugin: string, e: Error) => console.error(`[${plugin}] ${e.message}`);
  return { session, onError };
}

/**
 * `hortus -p [prompt]`: one run on the flagged session, no TUI (host `headless`, not interactive: asks resolve
 * undefined); without a prompt, on the session as it is, which must have something to answer: its last message a
 * user message (a retry, or `--seed`'s), tool results, or an assistant's unanswered tool calls. Prints the answer (or, `--json`, every event as a line), then closes the agent. Exit code: 0 on a
 * finished run, 1 on an error (or an abort not the user's), 130 on SIGINT (the run aborted, its completed messages
 * saved, and the agent closed).
 */
export async function printMode(f: Flags, makeAgent: (o: LoadOptions) => Promise<Agent>): Promise<number> {
  const { session, onError } = await setup(f, f.json, (messages) => {
    const last = messages.at(-1);
    if (!f.prompt && (!last || (last.role === "assistant" && !last.toolCalls.length)))
      throw new Error(
        "-p needs a prompt, or a session with something to answer (its last message isn't a final reply)",
      );
  });
  const observer: Plugin = f.json
    ? everyEvent((name, p, ctx) => eventLine(name, p, ctx))
    : {
        on: {
          notify: ({ text, level }) => console.error(`${level}: ${text}`),
          status: ({ key, text }) => console.error(`${key}: ${text ?? ""}`),
        },
      };
  const abort = new AbortController();
  let interrupted = false;
  // runs plugins queue after it (`deliver: "after"`), started with its signal
  const runs = new Set<Promise<unknown>>();
  const agent = await makeAgent({
    extra: [{ name: "@hortus/cli", plugin: observer }],
    onError,
    host: { kind: "headless", interactive: false },
    onWake: (start) => {
      const p: Promise<unknown> = start({ signal: abort.signal })
        .catch((e) => onError("host", asError(e)))
        .finally(() => runs.delete(p));
      runs.add(p);
    },
  });
  process.once("SIGINT", () => {
    interrupted = true;
    abort.abort();
    // a second one doesn't wait
    process.once("SIGINT", () => process.exit(130));
  });
  let code = 0;
  try {
    await agent.setSession(session);
    const end = await agent.run(f.prompt, { signal: abort.signal });
    // an abort not the user's (nor `ctx.exit()`'s) is a failure
    if (end?.aborted && !interrupted && end.aborted.reason !== "exit") code = 1;
    // a run ending wakes the next before it settles, so this sees every one queued
    while (runs.size) await Promise.all(runs);
    const last = session.getState().messages.at(-1);
    if (!f.json && last?.role === "assistant" && last.text) process.stdout.write(`${last.text}\n`);
  } catch (e) {
    onError("host", asError(e));
    code = 1;
  }
  await agent.close();
  return interrupted ? 130 : code;
}

/** One `--rpc` command, as read from a stdin line; its reply, if any, carries its `id`. */
type Command = { id?: string | number } & (
  | { type: "prompt"; text: string; deliver?: "context" | "steer" | "after" }
  | { type: "abort" }
  | { type: "answer"; askId: string; answer: string | string[] | null }
  | { type: "engage"; askId: string }
  | { type: "command"; name: string; arg?: string }
  | { type: "set_session"; session: string }
  | { type: "exit" }
);

/**
 * `hortus --rpc`: long-lived. Reads JSON-line commands on stdin (`{ type: "prompt", text, deliver?, id? }`, answered
 * once the run it started or joined ends, `abort`, `answer { askId, answer }`, `engage { askId }`,
 * `command { name, arg? }`, `set_session { session: <id> | "new" | "memory" | "key:<key>" }` (under `--parent`'s children, as `--session`), `exit`; any may carry an `id`) and writes every
 * event on stdout as `{ event, payload, run }`, an ask as `{ event: "ask", payload: { askId, ... } }`. A command's
 * reply is one line `{ response: <its type>, id?, ... }` (a prompt's: its `run_end`); a failed command's is
 * `{ response, id?, error: { name, message } }`. Bare `{ error: <message>, plugin? }` lines are errors no command asked
 * for (a plugin's, the host's, a line that isn't a JSON object). It is one more `ask` handler: interactive
 * (host `rpc`) while stdin is open; when stdin closes, its pending asks settle unanswered and it exits once the runs
 * are done. Resolves with the exit code (0; 130 on SIGINT).
 */
export async function rpcMode(f: Flags, makeAgent: (o: LoadOptions) => Promise<Agent>): Promise<number> {
  const { session, onError } = await setup(f, true);
  // interactive once the agent is up and while stdin is open
  const host: Host = { kind: "rpc", interactive: false, ui: true };
  /** asks written to the client, by id, each with what lets go of it */
  const asks = new Map<string, { ask: AskEvent; done: () => void }>();
  const ask = (p: AskEvent, ctx: Ctx) => {
    if (!host.interactive || p.signal.aborted) return;
    const askId = randomUUID();
    const { signal, resolve, answered, show, shown, engage, engaged, ...fields } = p;
    eventLine("ask", { askId, ...fields }, ctx);
    void answered.then(({ answer, ...rest }) =>
      eventLine("answered", { askId, ...rest, ...(!p.secret && answer !== undefined && { answer }) }, ctx),
    );
    // in front of someone now: e.g. an autopilot's countdown starts
    show();
    return new Promise<void>((done) => {
      asks.set(askId, { ask: p, done });
      signal.addEventListener(
        "abort",
        () => {
          asks.delete(askId);
          done();
        },
        { once: true },
      );
    });
  };
  const observer = everyEvent((name, p, ctx) => (name === "ask" ? ask(p as AskEvent, ctx) : eventLine(name, p, ctx)));
  /** aborted by `abort`: every run started here */
  const controllers = new Set<AbortController>();
  const runs = new Set<Promise<unknown>>();
  const track = (start: (o: RunOptions) => Promise<RunEnd | undefined>) => {
    const c = new AbortController();
    controllers.add(c);
    const p = start({ signal: c.signal })
      .catch((e) => onError("host", asError(e)))
      .finally(() => {
        controllers.delete(c);
        runs.delete(p);
      });
    runs.add(p);
    return p;
  };
  let exit!: (code: number) => void;
  const exited = new Promise<number>((r) => (exit = r));
  const agent = await makeAgent({
    extra: [{ name: "@hortus/cli", plugin: observer }],
    onError,
    host,
    onWake: (start) => void track((o) => start(o)),
    onExit: () => exit(0),
  });
  await agent.setSession(session);

  /** the reply to `c`: `{ response: <its type>, id?, ...fields }` */
  const reply = (c: Command, fields: object = {}) =>
    writeLine({ response: c.type, ...(c.id !== undefined && { id: c.id }), ...fields });
  const DELIVER = ["context", "steer", "after"];
  const handle = async (c: Command) => {
    switch (c.type) {
      case "prompt": {
        if (c.deliver !== undefined && !DELIVER.includes(c.deliver))
          throw new Error(`deliver needs one of ${DELIVER.join(", ")}`);
        // the run it started (or steered) has ended: its run_end
        if (c.deliver) reply(c, await agent.ctx.send(c.text, { deliver: c.deliver, source: "user" }));
        else
          void track((o) =>
            agent.run(c.text, o).then(
              (end) => {
                reply(c, end);
                return end;
              },
              (error) => {
                reply(c, { error: asError(error) });
                return undefined;
              },
            ),
          );
        return;
      }
      case "abort":
        for (const a of controllers) a.abort();
        return;
      case "answer":
      case "engage": {
        const a = asks.get(c.askId);
        if (!a) throw new Error(`No such ask: ${c.askId} (answered already?)`);
        if (c.type === "engage") a.ask.engage();
        else a.ask.resolve(c.answer ?? undefined);
        return;
      }
      case "command": {
        const cmd = agent.commands().find((x) => x.name === c.name || x.aliases?.includes(c.name));
        if (!cmd) throw new Error(`Unknown command: /${c.name}`);
        const text = await cmd.run(c.arg ?? "");
        reply(c, { name: c.name, ...(text && { text }) });
        return;
      }
      case "set_session": {
        const s = await flaggedSession(c.session, f.parent);
        // nothing written yet: created just now (`new`, or a `key:` not used before)
        const ok = await agent.setSession(s, s.leafId === null ? "new" : "resume");
        reply(c, { session: s.id, ok });
        return;
      }
      case "exit":
        exit(0);
        return;
      default:
        throw new Error(`Unknown command type: ${(c as { type?: unknown }).type}`);
    }
  };
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let c: Command;
    try {
      c = JSON.parse(line);
    } catch {
      // not echoed: it may be a secret answer, or huge
      return writeLine({ error: "Not JSON" });
    }
    if (!c || typeof c !== "object") return writeLine({ error: "Not a command object" });
    handle(c).catch((error) => reply(c, { error: asError(error), ...(c.type === "command" && { name: c.name }) }));
  });
  lines.on("close", async () => {
    // no client left: its asks settle unanswered (another handler may still answer), then exit once runs are done
    host.interactive = false;
    host.ui = false;
    for (const { done } of asks.values()) done();
    asks.clear();
    while (runs.size) await Promise.all(runs);
    exit(0);
  });
  process.once("SIGINT", () => {
    for (const a of controllers) a.abort();
    exit(130);
    process.once("SIGINT", () => process.exit(130));
  });
  host.interactive = true;
  // a client is attached: questions held back at startup can be asked now
  void agent.ctx.emit("interactive", {});
  if (f.prompt) void handle({ type: "prompt", text: f.prompt });
  const code = await exited;
  lines.close();
  await agent.close();
  return code;
}
