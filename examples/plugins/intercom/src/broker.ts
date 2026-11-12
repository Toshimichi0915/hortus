/**
 * The intercom broker: a standalone process (`node broker.js <dir>`) on the unix socket `<dir>/broker.sock` that keeps
 * the roster of connected sessions and routes messages between them. The first client that finds no broker spawns it
 * (detached); it exits `IDLE_MS` after the last session leaves, unless its mailbox still holds messages. A second broker
 * started meanwhile finds the socket answering and exits, so the socket itself is the spawn lock.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { type FromBroker, type IntercomMessage, lines, type SessionInfo, type ToBroker, write } from "./protocol.ts";

const IDLE_MS = Number(process.env.HORTUS_INTERCOM_BROKER_IDLE_MS) || 5000;
const MAIL_TTL = 24 * 60 * 60 * 1000;

interface Conn {
  sock: Socket;
  info?: SessionInfo;
}
interface Mail {
  /** the target's id when it was queued */
  to: SessionInfo;
  from: SessionInfo;
  message: IntercomMessage;
  at: number;
}

const conns = new Set<Conn>();
/** named sessions that disconnected: still addressable by `send`, which queues for them */
const gone = new Map<string, { info: SessionInfo; at: number }>();
let mail: Mail[] = [];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
const live = (scope?: string) =>
  [...conns].filter((c): c is Conn & { info: SessionInfo } => !!c.info && c.info.scope === scope);
const label = (s: SessionInfo) => s.name ?? s.id.slice(0, 8);

/** The session `to` names among `pool`: by id, name, id prefix, then name prefix; ambiguity is an error. */
function pick(pool: SessionInfo[], to: string | undefined, cwd: string | undefined): SessionInfo | string | undefined {
  const here = cwd === undefined ? pool : pool.filter((s) => s.cwd === cwd);
  if (to === undefined) {
    if (here.length > 1) return `${here.length} sessions are in ${cwd}: name one with "to"`;
    return here[0];
  }
  for (const match of [
    (s: SessionInfo) => s.id === to,
    (s: SessionInfo) => s.name === to,
    (s: SessionInfo) => s.id.startsWith(to),
    (s: SessionInfo) => !!s.name?.startsWith(to),
  ]) {
    const found = here.filter(match);
    if (found.length === 1) return found[0];
    if (found.length > 1)
      return `"${to}" is ambiguous: ${found.map((s) => `${label(s)} (${s.id.slice(0, 8)})`).join(", ")}; use the session id`;
  }
}

function prune() {
  const now = Date.now();
  mail = mail.filter((m) => now - m.at < MAIL_TTL);
  for (const [id, g] of gone) if (now - g.at > MAIL_TTL && !mail.some((m) => m.to.id === id)) gone.delete(id);
}

function deliverMail(c: Conn & { info: SessionInfo }) {
  const mine = (m: Mail) =>
    m.to.scope === c.info.scope &&
    (m.to.id === c.info.id || (!!m.to.name && m.to.name === c.info.name && m.to.cwd === c.info.cwd));
  for (const m of mail.filter(mine)) send(c.sock, { type: "message", from: m.from, message: m.message });
  mail = mail.filter((m) => !mine(m));
}

const send = (sock: Socket, msg: FromBroker) => write(sock, msg);

function handle(c: Conn, msg: ToBroker) {
  const reply = (r: Omit<Extract<FromBroker, { type: "reply" }>, "type" | "reqId">) =>
    send(c.sock, { type: "reply", reqId: msg.reqId, ...r });
  if (msg.type === "register") {
    const s = msg.session;
    const holder = [...conns].find((o) => o !== c && o.info?.id === s.id && o.info.scope === s.scope);
    if (holder?.info && holder.info.pid !== s.pid && alive(holder.info.pid))
      return reply({
        code: "E_SESSION_HELD",
        error: `Session ${s.id} is held by process ${holder.info.pid} in ${holder.info.cwd}`,
      });
    if (holder) {
      holder.info = undefined;
      holder.sock.destroy();
    }
    if (c.info && c.info.id !== s.id && c.info.name) gone.set(c.info.id, { info: c.info, at: Date.now() });
    c.info = s;
    gone.delete(s.id);
    reply({});
    return deliverMail(c as Conn & { info: SessionInfo });
  }
  const me = c.info;
  if (!me) return reply({ error: "Not registered" });
  if (msg.type === "presence") {
    c.info = { ...me, ...msg.patch, id: me.id, scope: me.scope };
    return reply({});
  }
  if (msg.type === "list") return reply({ sessions: live(me.scope).map((l) => l.info) });
  if (msg.type === "send") {
    prune();
    const peers = live(me.scope);
    const ghosts = msg.requireConnected
      ? []
      : [...gone.values()]
          .map((g) => g.info)
          .filter((g) => g.scope === me.scope && !peers.some((l) => l.info.id === g.id));
    // by cwd alone, "the sole peer there" never means this session
    const pool = peers.map((l) => l.info).filter((s) => msg.to !== undefined || s.id !== me.id);
    const target = pick(pool, msg.to, msg.cwd) ?? pick(ghosts, msg.to, msg.cwd);
    if (typeof target === "string") return reply({ error: target });
    if (!target)
      return reply({
        error: msg.to ? `Session not found: ${msg.to}` : `No session is connected in ${msg.cwd}`,
      });
    if (target.id === me.id) return reply({ error: "That is this session" });
    const to = peers.find((l) => l.info.id === target.id);
    if (to) {
      send(to.sock, { type: "message", from: me, message: msg.message });
      return reply({ target, delivery: "socket_delivered" });
    }
    mail.push({ to: target, from: me, message: msg.message, at: Date.now() });
    return reply({ target, delivery: "queued" });
  }
  if (msg.type === "cancel") {
    const queued = mail.find((m) => m.message.id === msg.messageId && m.from.id === me.id);
    if (queued) {
      mail = mail.filter((m) => m !== queued);
      return reply({ status: "cancelled" });
    }
    // already delivered: the receiver gets a visible cancellation request (every live session it may have reached)
    for (const l of live(me.scope)) if (l !== c) send(l.sock, { type: "cancel", from: me, messageId: msg.messageId });
    return reply({ status: "cancellation_requested" });
  }
}

let idle: NodeJS.Timeout | undefined;
function checkIdle() {
  clearTimeout(idle);
  if (conns.size === 0 && mail.length === 0) idle = setTimeout(shutdown, IDLE_MS);
  // ponytail: queued mail keeps the broker up until it expires (24h), checked hourly
  else if (conns.size === 0)
    idle = setTimeout(
      () => {
        prune();
        checkIdle();
      },
      60 * 60 * 1000,
    );
}

const dir = process.argv[2] ?? process.cwd();
const sockPath = join(dir, "broker.sock");
const pidPath = join(dir, "broker.pid");
const server = createServer((sock) => {
  const c: Conn = { sock };
  conns.add(c);
  checkIdle();
  lines(sock, (m) => handle(c, m as ToBroker));
  sock.on("error", () => {});
  sock.on("close", () => {
    conns.delete(c);
    if (c.info?.name) gone.set(c.info.id, { info: c.info, at: Date.now() });
    checkIdle();
  });
});

function shutdown() {
  server.close();
  rmSync(sockPath, { force: true });
  rmSync(pidPath, { force: true });
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

mkdirSync(dir, { recursive: true, mode: 0o700 });
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EADDRINUSE") throw e;
  // a broker answering there wins; a socket file nobody answers is stale
  const probe = connect(sockPath);
  probe.on("connect", () => process.exit(0));
  probe.on("error", () => {
    rmSync(sockPath, { force: true });
    server.listen(sockPath);
  });
});
server.on("listening", () => {
  writeFileSync(pidPath, String(process.pid));
  checkIdle();
});
server.listen(sockPath);
