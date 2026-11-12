/**
 * The hub: a standalone driver that relays an external chat gateway's conversations ("routes") to hortus sessions.
 * Each route points at one session. A session has one writer at a time: the TUI that has it open (the plugin in
 * index.ts attaches it over a unix socket), else a background `hortus --rpc --session <id>` worker the hub spawns.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { hortusBin } from "@hortus/cli";
import { hortusDir, listSessions, type Message, readSession, type SessionInfo } from "@hortus/core";

export const hubSocket = () => join(hortusDir(), "session-hub.sock");
const indexFile = () => join(hortusDir(), "session-hub.json");

export interface ChatMessage {
  route: string;
  text: string;
}

/** The chat side (WeChat's iLink in the original); the hub never polls or logs in itself. */
export interface Gateway {
  onMessage(handler: (m: ChatMessage) => void): void;
  send(route: string, text: string): Promise<void>;
}

export interface HubOptions {
  /** working dir of background workers, and the default allowed root */
  cwd?: string;
  /** TUI sessions whose cwd is under one of these are registered on attach (default: `[cwd]`) */
  roots?: string[];
  /** extra `hortus` flags for workers */
  args?: string[];
}

interface Indexed {
  /** stable public number, never reused */
  index: number;
  id: string;
}
interface HubIndex {
  next: number;
  sessions: Indexed[];
  routes: Record<string, number>;
}

/** a `{ response: "prompt" }` line: its run's `run_end` */
interface TurnEnd {
  messages?: Message[];
  error?: { message?: string };
}

interface Worker {
  child: ChildProcess;
  id: Promise<string>;
  exited: Promise<unknown>;
  running: boolean;
  /** prompts sent, by their RPC request id, until their `{ response: "prompt" }` */
  turns: Map<number, (end: TurnEnd) => void>;
  next: number;
}

/** a TUI owner, one per socket connection */
interface Owner {
  running: boolean;
  prompt(text: string): Promise<string>;
}

/** The reply to send for a run: its error, else its last assistant text. */
export function replyOf(messages: Message[] = [], error?: { message?: string }) {
  if (error) return `Error: ${error.message ?? String(error)}`;
  const a = [...messages].reverse().find((m) => m.role === "assistant" && m.text);
  return a?.role === "assistant" ? a.text : "(no reply)";
}

const MAX = 2000; // the gateway's per-message limit, in code points
const head = (s: string, n: number) =>
  [...s].length > n ? `${[...s].slice(0, n).join("")}\n[Question cut short.]` : s;
const tail = (s: string, n: number) => ([...s].length > n ? `…${[...s].slice(-n).join("")}` : s);
const HELP = `/new [--name <name>]   new session for this chat
/sessions              list sessions
/resume <#|name>       switch this chat to a session
/last [#|name]         the last exchange of a session (read only)
/stop [#|name]         stop a session's background worker
/status                hub status
/help                  this help`;

export async function startHub(gateway: Gateway, { cwd = process.cwd(), roots = [cwd], args = [] }: HubOptions = {}) {
  const idx: HubIndex = await readFile(indexFile(), "utf8")
    .then((t) => JSON.parse(t))
    .catch(() => ({ next: 1, sessions: [], routes: {} }));
  const save = () => writeFile(indexFile(), JSON.stringify(idx, null, 2));
  const workers = new Map<string, Worker>();
  const owners = new Map<string, Owner>();
  const queues = new Map<string, Promise<unknown>>();

  const spawnWorker = (session: string, name?: string): Worker => {
    const child = spawn(
      process.execPath,
      [hortusBin, "--rpc", "--session", session, ...(name ? ["--name", name] : []), ...args],
      { cwd, stdio: ["pipe", "pipe", "ignore"] as const },
    );
    const exited = once(child, "close");
    let opened!: (id: string) => void;
    const id = new Promise<string>((resolve, reject) => {
      opened = resolve;
      exited.then(() => reject(new Error("The worker exited before opening its session")));
    });
    id.catch(() => {});
    const w: Worker = { child, exited, running: false, id, turns: new Map(), next: 0 };
    createInterface({ input: child.stdout }).on("line", (l) => {
      // biome-ignore lint/suspicious/noExplicitAny: JSON lines of any shape
      let m: { event?: string; payload?: any; response?: string; id?: number } & TurnEnd;
      try {
        m = JSON.parse(l);
      } catch {
        return;
      }
      if (m.event === "session_open") opened(m.payload.session.id);
      if (m.response === "prompt" && m.id !== undefined) {
        w.turns.get(m.id)?.(m);
        w.turns.delete(m.id);
      }
    });
    exited.then(() => {
      for (const [id, x] of workers) if (x === w) workers.delete(id);
      for (const turn of w.turns.values()) turn({ error: { message: "the session's worker exited" } });
    });
    return w;
  };

  const stopWorker = async (w: Worker, abort = false) => {
    if (abort) w.child.stdin?.write(`${JSON.stringify({ type: "abort" })}\n`);
    w.child.stdin?.end(); // --rpc exits once its runs are done
    const kill = setTimeout(() => w.child.kill(), 5000);
    await w.exited;
    clearTimeout(kill);
  };

  const runOnWorker = async (w: Worker, text: string) => {
    w.running = true;
    const id = ++w.next;
    const end = new Promise<TurnEnd>((r) => w.turns.set(id, r));
    w.child.stdin?.write(`${JSON.stringify({ type: "prompt", text, id })}\n`);
    const e = await end;
    w.running = false;
    return replyOf(e.messages, e.error);
  };

  const prompt = (s: Indexed, text: string) => {
    const owner = owners.get(s.id);
    if (owner) return owner.prompt(text);
    const w = workers.get(s.id) ?? spawnWorker(s.id);
    workers.set(s.id, w);
    return runOnWorker(w, text);
  };

  const create = async (route: string, name?: string) => {
    const w = spawnWorker("new", name);
    const s = { index: idx.next++, id: await w.id };
    workers.set(s.id, w);
    idx.sessions.push(s);
    idx.routes[route] = s.index;
    await save();
    return s;
  };

  const current = (route: string) => idx.sessions.find((s) => s.index === idx.routes[route]);
  const busy = (s: Indexed) => !!(owners.get(s.id)?.running || workers.get(s.id)?.running);
  const mode = (s: Indexed) => (owners.has(s.id) ? "TUI" : workers.has(s.id) ? "background" : "saved");
  const infos = async () => new Map((await listSessions()).map((i) => [i.id, i]));
  const title = (i?: SessionInfo) => {
    const t = i?.title.replace(/\s+/g, " ").trim();
    if (!t) return "(no messages)";
    return [...t].length > 32 ? `${[...t].slice(0, 32).join("")}...` : t;
  };

  /** a session by public index or unique title; none: the route's current one */
  const select = async (route: string, sel?: string) => {
    if (!sel) {
      const s = current(route);
      if (!s) throw new Error("This chat has no session yet: send a message or /new");
      return s;
    }
    if (/^\d+$/.test(sel)) {
      const s = idx.sessions.find((x) => x.index === Number(sel));
      if (!s) throw new Error(`No session #${sel}`);
      return s;
    }
    const all = await infos();
    const found = idx.sessions.filter((s) => all.get(s.id)?.title === sel);
    if (found.length !== 1)
      throw new Error(found.length ? `More than one session is called "${sel}"` : `No session "${sel}"`);
    return found[0] as Indexed;
  };

  const lastExchange = async (s: Indexed) => {
    const info = (await infos()).get(s.id);
    const messages = info ? (await readSession(info.path)).messages : [];
    const q = messages.length - 1 - [...messages].reverse().findIndex((m) => m.role === "user" && !m.meta);
    const user = q < messages.length ? messages[q] : undefined;
    const answer = [...messages.slice(q + 1)].reverse().find((m) => m.role === "assistant" && m.text);
    return {
      info,
      question: user?.role === "user" ? user.content : undefined,
      answer: answer?.role === "assistant" ? answer.text : undefined,
    };
  };

  const commands: Record<string, (route: string, args: string[]) => Promise<string>> = {
    help: async () => HELP,
    new: async (route, a) => {
      const n = a.indexOf("--name");
      const name = n >= 0 ? a[n + 1] : undefined;
      if (n >= 0 && !name) throw new Error("Usage: /new [--name <name>]");
      const s = await create(route, name);
      return `New session #${s.index}${name ? ` ${name}` : ""} (background). This chat now talks to it.`;
    },
    sessions: async (route) => {
      if (!idx.sessions.length) return "No sessions yet.";
      const all = await infos();
      const rows = idx.sessions.map((s) => {
        const mark = s.index === idx.routes[route] ? " (current)" : "";
        return `| ${s.index} | ${title(all.get(s.id))}${mark} | ${mode(s)} | ${busy(s) ? "running" : "idle"} |`;
      });
      return ["| # | Title | Mode | State |", "|---|---|---|---|", ...rows].join("\n");
    },
    resume: async (route, [sel]) => {
      if (!sel) throw new Error("Usage: /resume <#|name>");
      const s = await select(route, sel);
      idx.routes[route] = s.index;
      await save();
      const head = `Switched to session #${s.index} ${title((await infos()).get(s.id))}.`;
      if (busy(s)) return `${head} It is running.`;
      const { answer } = await lastExchange(s);
      return answer ? `${head}\nLast reply:\n${tail(answer, 800)}` : head;
    },
    last: async (route, [sel]) => {
      const s = await select(route, sel);
      const { info, question, answer } = await lastExchange(s);
      return [
        `Session #${s.index} ${title(info)} · ${mode(s)}`,
        ...(busy(s) ? ["⚠ The session is running; this is what is saved so far."] : []),
        "",
        "You:",
        question ? head(question, 1200) : "(nothing yet)",
        answer && [...answer].length > 3800 ? "AI (the end):" : "AI:",
        answer ? tail(answer, 3800) : "No reply yet.",
        "",
        sel ? `Send /resume ${s.index} to switch to it.` : "Send anything to go on.",
      ].join("\n");
    },
    stop: async (route, [sel]) => {
      const s = await select(route, sel);
      if (owners.has(s.id)) throw new Error(`Session #${s.index} is open in a TUI: stop it there`);
      const w = workers.get(s.id);
      if (!w) return `Session #${s.index} has no worker running.`;
      await stopWorker(w, true);
      return `Stopped session #${s.index}.`;
    },
    status: async (route) => {
      const s = current(route);
      return [
        `Hub online · ${idx.sessions.length} sessions · ${workers.size} background, ${owners.size} in a TUI`,
        `This chat: ${s ? `#${s.index} ${title((await infos()).get(s.id))} · ${mode(s)}` : "no session"}`,
      ].join("\n");
    },
  };

  const reply = async (route: string, text: string) => {
    const cps = [...text];
    for (let i = 0; i < cps.length; i += MAX) await gateway.send(route, cps.slice(i, i + MAX).join(""));
  };

  const handle = async ({ route, text }: ChatMessage) => {
    const t = text.trim();
    if (t.startsWith("/")) {
      // fail closed: only the hub's own commands, never hortus's or a shell's
      const [name = "", ...a] = [...t.slice(1).matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? "");
      const c = Object.hasOwn(commands, name) ? commands[name] : undefined;
      return reply(route, c ? await c(route, a) : `Unknown command: /${name}. Send /help for the list.`);
    }
    return reply(route, await prompt(current(route) ?? (await create(route)), t));
  };

  gateway.onMessage((m) => {
    // one at a time per chat, in order
    const q = (queues.get(m.route) ?? Promise.resolve())
      .then(() => handle(m))
      .catch((e) => reply(m.route, `Error: ${e instanceof Error ? e.message : e}`))
      .catch(() => {});
    queues.set(m.route, q);
  });

  // TUI owners (index.ts) over a unix socket: JSON lines, requests `{ id, type, sessionId, cwd? }` → `{ id, ok, reason? }`
  const inRoots = (dir: string) =>
    roots.some((r) => {
      const rel = relative(r, dir);
      return !rel.startsWith("..") && !isAbsolute(rel);
    });
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    const write = (o: unknown) => sock.write(`${JSON.stringify(o)}\n`);
    const pending = new Map<number, (text: string) => void>();
    let n = 0;
    const owner: Owner = {
      running: false,
      prompt: async (text) => {
        owner.running = true;
        const pid = ++n;
        const answer = new Promise<string>((r) => pending.set(pid, r));
        write({ type: "prompt", pid, text });
        const t = await answer;
        owner.running = false;
        return t;
      },
    };
    const request = async (m: { type: string; sessionId: string; cwd?: string }) => {
      const other = owners.get(m.sessionId);
      if (m.type === "can_switch")
        return other && other !== owner
          ? { ok: false, reason: "The session is open in another TUI: resuming it here would make two writers." }
          : { ok: true };
      if (m.type === "detach") {
        if (other === owner) owners.delete(m.sessionId);
        return { ok: true };
      }
      if (m.type !== "attach") return { ok: false, reason: `Unknown request: ${m.type}` };
      if (other && other !== owner) return { ok: false, reason: "The session is open in another TUI." };
      let s = idx.sessions.find((x) => x.id === m.sessionId);
      if (!s) {
        if (!m.cwd || !inRoots(m.cwd)) return { ok: false };
        s = { index: idx.next++, id: m.sessionId };
        idx.sessions.push(s);
        await save();
      }
      // the background writer goes first, then the TUI takes over
      const w = workers.get(s.id);
      if (w) await stopWorker(w);
      owners.set(s.id, owner);
      return { ok: true, index: s.index };
    };
    createInterface({ input: sock }).on("line", async (l) => {
      let m: { id?: number; type?: string; pid?: number; text?: string; sessionId?: string; cwd?: string };
      try {
        m = JSON.parse(l);
      } catch {
        return;
      }
      if (m.type === "reply" && m.pid !== undefined) {
        pending.get(m.pid)?.(m.text ?? "");
        pending.delete(m.pid);
      } else if (m.type && m.sessionId)
        write({ id: m.id, ...(await request(m as { type: string; sessionId: string })) });
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      sockets.delete(sock);
      for (const [id, o] of owners) if (o === owner) owners.delete(id);
      for (const r of pending.values()) r("The TUI closed before the session answered.");
    });
  });

  // one hub at a time: a live socket means another hub runs; a dead one is left over from a crash
  const live = await new Promise<boolean>((r) => {
    const c = connect(hubSocket())
      .on("connect", () => r(!!c.end()))
      .on("error", () => r(false));
  });
  if (live) throw new Error("A session hub is already running");
  await rm(hubSocket(), { force: true });
  server.listen(hubSocket());
  await once(server, "listening");

  return {
    /** stops taking TUI connections, ends every worker (after its run), and removes the socket */
    close: async () => {
      server.close();
      for (const s of sockets) s.destroy();
      await Promise.all([...workers.values()].map((w) => stopWorker(w)));
      await rm(hubSocket(), { force: true });
    },
  };
}
