/**
 * pi-intercom for hortus: direct 1:1 messages between hortus sessions on this machine, through a local broker
 * (broker.ts) that the first session spawns. Each agent registers its current session (its id, `/alias` name, cwd,
 * model and live status); the `intercom` tool lists peers and sends, asks (waiting for the reply as its result),
 * replies and hands over; incoming messages become plugin messages that start or steer a run.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type AskEvent,
  type CliPlugin,
  cliOf,
  type EntryRenderer,
  linesRenderer,
  PromptInput,
  type Span,
  theme,
  useTheme,
  useUi,
} from "@hortus/cli";
import { type Command, contextTokens, type Ctx, hortusDir, type Session, stateOf, tool } from "@hortus/core";
import { Box, Text } from "ink";
import { useState } from "react";
import { z } from "zod";
import {
  type Attachment,
  type FromBroker,
  type IntercomMessage,
  lines,
  type Reply,
  type SessionInfo,
  type ToBroker,
  write,
} from "./protocol.ts";

declare module "@hortus/core" {
  interface Events {
    /** before a session registers: a plugin that owns its routing address sets `id` (else the session's id) */
    intercom_identity: { session: Session; id?: string };
    /**
     * the outbox: another plugin sends through this session's intercom (confirmed like the tool's sends; with no UI to
     * confirm, it fails closed); `result` is set once the emit resolves
     */
    intercom_send: {
      plugin: string;
      to: string;
      message: string;
      result?: { ok: boolean; messageId?: string; error?: string; code?: string };
    };
  }
}

export interface Config {
  enabled: boolean;
  /** ask before ordinary and inferred sends, in an interactive host */
  confirmSend: boolean;
  /** which incoming messages start (or steer) a run: the others only join the context */
  inboundTrigger: "always" | "replies" | "never";
  /**
   * while a run goes on in an interactive host: "steer" (default) delivers at once; "human-first" holds incoming messages
   * and steers one in at a turn's end only when no person's input is waiting (`ctx.pending()`), the rest once idle
   */
  busyDelivery: "steer" | "human-first";
  /** incoming messages say how to reply */
  replyHint: boolean;
  /** appended to the live status ("thinking · researching") */
  status?: string;
  /** a fixed intercom id instead of the session's */
  stableId?: string;
}

/** a received message */
interface Inbound {
  from: SessionInfo;
  message: IntercomMessage;
  at: number;
}

interface Conn {
  sock: Socket;
  call(m: DistributiveOmit<ToBroker, "reqId">): Promise<Reply>;
}
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface State {
  /** the host ctx from `init`: it follows the current session */
  ctx: Ctx;
  config: Config;
  conn?: Promise<Conn>;
  sock?: Socket;
  /** what this agent registered */
  info?: SessionInfo;
  /** the pool (`HORTUS_INTERCOM_SCOPE_ID`, `/intercom-pool`) */
  scope?: string;
  /** another process holds this session's id: no reconnecting until it's released */
  held?: string;
  closed?: boolean;
  retry: number;
  /** received messages by id (the latest 200), for replies by `replyTo` */
  inbox: Map<string, Inbound>;
  /** inbound asks not answered yet */
  pending: Map<string, Inbound>;
  /** "human-first": messages held while a run goes on */
  queued: Inbound[];
  /** this session's own ask, waiting for its reply */
  waiting?: { id: string; to: string; done(r: Inbound): void };
  /** the message that started or joined the running run, so `reply` knows whom it answers */
  turn?: { runId: string; inbound: Inbound; replied?: boolean };
  running: boolean;
  /** running top-level tool calls, by id */
  tools: Map<string, string>;
  unsubscribe?: () => void;
}

const st = (ctx: Ctx) =>
  stateOf(ctx, "st", (): State => {
    throw new Error("intercom: its state is made in init");
  });
const dir = () => join(hortusDir(), "intercom");
const label = (s: Pick<SessionInfo, "id" | "name">) => s.name || s.id.slice(0, 8);
const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function loadConfig(): { config: Config; error?: string } {
  const defaults: Config = {
    enabled: true,
    confirmSend: false,
    inboundTrigger: "always",
    busyDelivery: "steer",
    replyHint: true,
  };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir(), "config.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { config: defaults };
    return { config: { ...defaults, inboundTrigger: "never" }, error: `intercom config.json: ${errorText(e)}` };
  }
  const parsed = z
    .object({
      enabled: z.boolean().optional(),
      confirmSend: z.boolean().optional(),
      inboundTrigger: z.enum(["always", "replies", "never"]).optional(),
      busyDelivery: z.enum(["steer", "human-first"]).optional(),
      replyHint: z.boolean().optional(),
      status: z.string().optional(),
      stableId: z.string().optional(),
    })
    .safeParse(raw);
  // an invalid config fails closed: nothing triggers runs until it's fixed
  if (!parsed.success)
    return { config: { ...defaults, inboundTrigger: "never" }, error: `intercom config.json: ${parsed.error.message}` };
  return { config: { ...defaults, ...parsed.data } };
}

// ---- the broker connection ----

const dial = (path: string) =>
  new Promise<Socket>((ok, fail) => {
    const sock = connect(path);
    sock.once("connect", () => ok(sock));
    sock.once("error", fail);
  });

function connection(s: State): Promise<Conn> {
  s.conn ??= open(s).catch((e) => {
    s.conn = undefined;
    throw e;
  });
  return s.conn;
}

async function open(s: State): Promise<Conn> {
  const path = join(dir(), "broker.sock");
  let sock = await dial(path).catch(() => undefined);
  if (!sock) {
    spawn(process.execPath, [fileURLToPath(new URL("./broker.js", import.meta.url)), dir()], {
      detached: true,
      stdio: "ignore",
    }).unref();
    for (const end = Date.now() + 5000; !sock; sock = await dial(path).catch(() => undefined)) {
      if (Date.now() > end) throw new Error("The intercom broker didn't start");
      await sleep(50);
    }
  }
  const live = sock;
  s.sock = live;
  const calls = new Map<number, (r: Reply) => void>();
  let n = 0;
  lines(live, (m) => {
    const msg = m as FromBroker;
    if (msg.type === "reply") {
      calls.get(msg.reqId)?.(msg);
      calls.delete(msg.reqId);
    } else if (msg.type === "message") void inbound(s, { from: msg.from, message: msg.message, at: Date.now() });
    else void cancelRequested(s, msg.from, msg.messageId);
  });
  live.on("error", () => {});
  live.on("close", () => {
    for (const r of calls.values()) r({ type: "reply", reqId: 0, error: "The intercom broker went away" });
    if (s.sock !== live) return;
    s.sock = undefined;
    s.conn = undefined;
    reconnect(s);
  });
  return {
    sock: live,
    call: (m) =>
      new Promise((r) => {
        calls.set(++n, r);
        write(live, { ...m, reqId: n });
      }),
  };
}

/** after the broker went away: register again (respawning it) with backoff, unless closed or held */
function reconnect(s: State) {
  if (s.closed || s.held) return;
  const delay = Math.min(30000, 500 * 2 ** s.retry++);
  setTimeout(() => void register(s).catch(() => reconnect(s)), delay).unref();
}

async function call(s: State, m: DistributiveOmit<ToBroker, "reqId">) {
  if (s.held) throw new Error(`Intercom is off for this session: ${s.held}`);
  if (!s.info) await register(s);
  const r = await (await connection(s)).call(m);
  if (r.error) throw new Error(r.error);
  return r;
}

function statusText(s: State) {
  const tools = [...s.tools.values()];
  const live = tools.length ? `tool:${tools.at(-1)}` : s.running ? "thinking" : "idle";
  return s.config.status ? `${live} · ${s.config.status}` : live;
}

async function modelOf(ctx: Ctx) {
  try {
    return (await ctx.resolve()).model;
  } catch {
    return "";
  }
}

/** registers the agent's current session (again: after `/new`, a pool switch or a reconnect) */
async function register(s: State) {
  const { ctx } = s;
  const session = ctx.session;
  if (!session || !s.config.enabled || s.closed) return;
  const claim: { session: Session; id?: string } = { session };
  await ctx.emit("intercom_identity", claim);
  const info: SessionInfo = {
    id: claim.id || process.env.HORTUS_INTERCOM_STABLE_ID || s.config.stableId || session.id,
    name: session.getState().name,
    cwd: ctx.cwd,
    model: session.getState().model ?? (await modelOf(ctx)),
    pid: process.pid,
    startedAt: s.info?.startedAt ?? Date.now(),
    status: statusText(s),
    scope: s.scope,
    contextPct: s.info?.contextPct,
  };
  s.info = info;
  const r = await (await connection(s)).call({ type: "register", session: info });
  if (r.code === "E_SESSION_HELD") {
    s.held = r.error;
    await ctx.notify(`Intercom: ${r.error}. Close it, then start this session again.`, "warn");
    await session.appendEntry(`${ctx.plugin}:session_held`, { reason: r.error, at: Date.now() });
    return;
  }
  if (r.error) throw new Error(r.error);
  s.retry = 0;
}

function presence(s: State, patch: Partial<SessionInfo>) {
  if (!s.info) return;
  s.info = { ...s.info, ...patch };
  void s.conn?.then((c) => c.call({ type: "presence", patch })).catch(() => {});
}

// ---- messages ----

function body(m: IntercomMessage) {
  const parts = [m.text];
  for (const a of m.attachments ?? []) {
    const head = `--- ${a.type}: ${a.name}${a.language ? ` (${a.language})` : ""} ---`;
    parts.push(
      a.type === "snippet" ? `${head}\n\`\`\`${a.language ?? ""}\n${a.content}\n\`\`\`` : `${head}\n${a.content}`,
    );
  }
  return parts.join("\n\n");
}

async function inbound(s: State, r: Inbound) {
  const { ctx } = s;
  if (s.waiting && r.message.replyTo === s.waiting.id) {
    s.waiting.done(r);
    await ctx.session
      ?.appendEntry(`${ctx.plugin}:received`, { from: r.from, message: r.message, asReply: true })
      .catch(() => {});
    return;
  }
  s.inbox.set(r.message.id, r);
  if (s.inbox.size > 200) s.inbox.delete(s.inbox.keys().next().value as string);
  if (r.message.expectsReply) s.pending.set(r.message.id, r);
  // human-first: a person's input goes first; held until a turn's end with none waiting, or idle
  if (s.config.busyDelivery === "human-first" && ctx.host.interactive && (ctx.busy() || s.queued.length)) {
    s.queued.push(r);
    return;
  }
  await sendInbound(s, r);
}

/** `r` as a plugin message: starting or steering a run (its trigger), else joining the context. */
function sendInbound(s: State, r: Inbound) {
  const { ctx } = s;
  // steered into a running run, the reply must name the message: that run's own trigger may be another one
  const hint = !s.config.replyHint
    ? ""
    : `\n\nTo reply, use the intercom tool: ${
        ctx.busy()
          ? `intercom({ action: "reply", replyTo: ${JSON.stringify(r.message.id)}, message: "..." })`
          : `intercom({ action: "reply", message: "..." })`
      }`;
  const trigger =
    s.config.inboundTrigger === "always" || (s.config.inboundTrigger === "replies" && !!r.message.replyTo);
  return ctx
    .send(
      {
        content: `**From ${label(r.from)}** (${tilde(r.from.cwd)})${hint}\n\n${body(r.message)}`,
        meta: { plugin: ctx.plugin, type: "message", details: r, display: true },
      },
      { deliver: trigger ? "steer" : "context" },
    )
    .then(
      () => {},
      () => {}, // closing
    );
}

async function cancelRequested(s: State, from: SessionInfo, messageId: string) {
  const got = s.inbox.get(messageId);
  if (got?.from.id !== from.id) return;
  s.pending.delete(messageId);
  await s.ctx
    .send(
      {
        content: `**${label(from)}** asked to cancel its message ${messageId}: stop acting on it unless you're done.`,
        meta: { plugin: s.ctx.plugin, type: "cancel", details: { from, messageId }, display: true },
      },
      { deliver: "steer" },
    )
    .catch(() => {});
}

const matches = (to: string | undefined, cwd: string | undefined, s: SessionInfo) =>
  to !== undefined
    ? s.id === to || s.name === to || s.id.startsWith(to) || !!s.name?.startsWith(to)
    : cwd !== undefined && s.cwd === cwd;

interface Outgoing {
  to?: string;
  cwd?: string;
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  /** an ask's id (it waits for the reply) */
  askId?: string;
  /** whether the caller supplied `replyTo` (no confirmation then) */
  explicitReply?: boolean;
}

/** sends one message (after `confirmSend`), records it, and settles the ask it answers */
async function deliver(s: State, ctx: Ctx, o: Outgoing) {
  if (s.config.confirmSend && !o.explicitReply && !o.askId && ctx.host.interactive) {
    const ok = await ctx.ask({
      question: `Send this intercom message to ${o.to ?? o.cwd}?\n\n${o.text}`,
      options: [{ label: "Send" }, { label: "Cancel" }],
    });
    if (ok !== "Send") throw new Error("The user cancelled the send");
  }
  const message: IntercomMessage = {
    id: o.askId ?? randomUUID(),
    timestamp: Date.now(),
    text: o.text,
    ...(o.attachments?.length ? { attachments: o.attachments } : {}),
    ...(o.replyTo ? { replyTo: o.replyTo } : {}),
    ...(o.askId ? { expectsReply: true } : {}),
  };
  const r = await call(s, {
    type: "send",
    ...(o.to !== undefined ? { to: o.to } : {}),
    ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
    message,
    ...(o.askId ? { requireConnected: true } : {}),
  });
  const target = r.target as SessionInfo;
  if (o.replyTo) {
    s.pending.delete(o.replyTo);
    if (s.turn?.inbound.message.id === o.replyTo) s.turn.replied = true;
  }
  await ctx.session?.appendEntry(`${ctx.plugin}:sent`, { to: target, message, delivery: r.delivery });
  return { target, message, queued: r.delivery === "queued" };
}

const sentText = (d: Awaited<ReturnType<typeof deliver>>, what = "Message") =>
  d.queued
    ? `${label(d.target)} is not connected: the message (${d.message.id}) waits for it to reconnect`
    : `${what} sent to ${label(d.target)} (${d.message.id})`;

/** the inbound ask a send to `to`/`cwd` answers: the only pending one from there */
function inferReply(s: State, to?: string, cwd?: string) {
  const from = [...s.pending.values()].filter((p) => matches(to, cwd, p.from));
  return from.length === 1 ? from[0] : undefined;
}

const askTimeout = () => Number(process.env.HORTUS_INTERCOM_ASK_TIMEOUT_MS) || 10 * 60 * 1000;

async function ask(s: State, ctx: Ctx, o: Outgoing) {
  if (s.waiting) throw new Error(`Already waiting for ${s.waiting.to} to reply: one ask at a time`);
  const id = randomUUID();
  let done!: (r: Inbound) => void;
  const reply = new Promise<Inbound>((r) => {
    done = r;
  });
  s.waiting = { id, to: o.to ?? o.cwd ?? "?", done };
  let timer: NodeJS.Timeout | undefined;
  try {
    const d = await deliver(s, ctx, { ...o, askId: id });
    s.waiting.to = label(d.target);
    const failed = new Promise<never>((_, fail) => {
      timer = setTimeout(
        () => fail(new Error(`No reply from ${label(d.target)} within ${askTimeout() / 1000}s to message ${id}`)),
        askTimeout(),
      );
      ctx.signal.addEventListener("abort", () => fail(new Error("Aborted while waiting for the reply")), {
        once: true,
      });
    });
    const r = await Promise.race([reply, failed]);
    return `Reply from ${label(r.from)}: ${body(r.message)}`;
  } finally {
    clearTimeout(timer);
    s.waiting = undefined;
  }
}

/** the inbound message `reply` answers */
function replyTarget(s: State, ctx: Ctx, to?: string, replyTo?: string): Inbound {
  if (replyTo) {
    const r = s.inbox.get(replyTo);
    if (!r) throw new Error(`No received message ${replyTo}`);
    return r;
  }
  const turn = s.turn?.runId === ctx.run?.id ? s.turn : undefined;
  if (turn && (to === undefined || matches(to, undefined, turn.inbound.from))) return turn.inbound;
  const asks = [...s.pending.values()].filter((p) => to === undefined || matches(to, undefined, p.from));
  const [only] = asks;
  if (asks.length === 1 && only) return only;
  if (asks.length === 0) throw new Error(to ? `No pending ask from ${to}` : "Nothing to reply to: no pending asks");
  throw new Error(`${asks.length} asks are pending: pass "to" or "replyTo" (see intercom({ action: "pending" }))`);
}

const ago = (t: number) => `${Math.round((Date.now() - t) / 1000)}s ago`;

function row(x: SessionInfo, me: SessionInfo | undefined) {
  const self = x.id === me?.id;
  const model = [x.model, x.contextPct !== undefined ? `${x.contextPct}% ctx` : ""].filter(Boolean).join(" · ");
  const tags = [self ? "self" : "", !self && x.cwd === me?.cwd ? "same cwd" : "", x.status ?? ""].filter(Boolean);
  return `• ${x.name || "(unnamed)"} (${x.id.slice(0, 8)}) — ${tilde(x.cwd)}${model ? ` (${model})` : ""}${tags.length ? ` [${tags.join(", ")}]` : ""}`;
}

async function list(s: State, cwd?: string) {
  const sessions = (await call(s, { type: "list" })).sessions ?? [];
  const me = sessions.find((x) => x.id === s.info?.id);
  const others = sessions.filter((x) => x !== me && (cwd === undefined || x.cwd === cwd));
  return [
    `**Current session:**\n${me ? row(me, me) : "(not registered)"}`,
    `**Other sessions${cwd ? ` in ${tilde(cwd)}` : ""}:**\n${others.length ? others.map((x) => row(x, me)).join("\n") : "No other sessions connected."}`,
  ].join("\n\n");
}

// ---- handover ----

const HANDOVER_SYSTEM = `You write handovers: a summary of a coding session for another agent that continues the work. Write:
## Next task
## Key decisions (and rejected approaches, with why)
## Relevant files and repositories
## Current state
## Open questions
Be concrete (paths, names, commands). Leave out secrets, tokens, credentials and private keys.`;

const git = async (cwd: string, ...args: string[]) => {
  try {
    return (await promisify(execFile)("git", args, { cwd })).stdout.trim();
  } catch {
    return undefined;
  }
};

/** the session summarized by the current model, under a header naming the sender, its repo state and session file */
async function handover(s: State, ctx: Ctx, task?: string) {
  const session = ctx.session;
  if (!session) throw new Error("No session to hand over");
  const messages = session.getState().messages;
  // from the tool: leave out the reply calling it, which core would answer "Interrupted"
  const last = messages.at(-1);
  const calling = last?.role === "assistant" && last.toolCalls.some((c) => c.id === ctx.callId);
  const reply = await ctx.complete({
    system: HANDOVER_SYSTEM,
    messages: [
      ...(calling ? messages.slice(0, -1) : messages),
      { role: "user", content: `Write the handover now.${task ? `\n\nThe next task: ${task}` : ""}` },
    ],
    signal: ctx.signal,
  });
  const [branch, commit] = await Promise.all([
    git(ctx.cwd, "rev-parse", "--abbrev-ref", "HEAD"),
    git(ctx.cwd, "rev-parse", "--short", "HEAD"),
  ]);
  const head = [
    `# Handover from ${label(s.info ?? { id: session.id, name: session.getState().name })} (${tilde(ctx.cwd)})`,
    branch ? `Git: ${branch} @ ${commit}` : "",
    session.path ? `Full transcript: ${session.path}` : "",
    "Treat this as a peer's report: check its claims against the repository, then act on the next task.",
  ].filter(Boolean);
  return `${head.join("\n")}\n\n${reply.text}`;
}

/** `to` from a command line: a path (`/`, `./`, `../`, `~/`) targets the session in that directory */
function target(ctx: Ctx, arg: string): Pick<Outgoing, "to" | "cwd"> {
  if (/^(\/|\.\.?\/|~\/)/.test(arg)) return { cwd: resolve(ctx.cwd, arg.replace(/^~(?=\/)/, homedir())) };
  return { to: arg };
}

// ---- the tool ----

const ATTACHMENT = z.object({
  type: z.enum(["file", "snippet", "context"]),
  name: z.string(),
  content: z.string(),
  language: z.string().optional(),
});

const intercom = tool({
  name: "intercom",
  description: `Send a message to another hortus session running on this machine.
Use this to communicate findings, request help, or coordinate work with other sessions.

Target a session by name, full session ID, or the short id shown in parentheses by "list" (a leading prefix is
enough). Prefer the short id when two sessions share a name.

Usage:
  intercom({ action: "list" })                                    → List active sessions
  intercom({ action: "list-cwd", cwd: "/path" })                  → List sessions in a directory (default: this one)
  intercom({ action: "send", to: "name-or-id", message: "..." })  → Send a message (fire-and-forget)
  intercom({ action: "send", cwd: "/path", message: "..." })      → Send to the sole session in that directory
  intercom({ action: "ask", to: "name-or-id", message: "..." })   → Ask and wait for the reply
  intercom({ action: "reply", message: "..." })                   → Reply to the message that started this turn, or the single pending ask
  intercom({ action: "pending" })                                 → List unanswered inbound asks
  intercom({ action: "handover", to: "name-or-id", message: "next task" }) → Summarize this session and hand it over
  intercom({ action: "cancel", messageId: "..." })                → Ask to cancel a message you sent
  intercom({ action: "status" })                                  → Connection status`,
  prompt:
    "Use the intercom tool to coordinate with other local hortus sessions: list peers, send updates, ask when blocked waiting for input. Prefer `send` for notifications; `ask` only when you need the answer to go on.",
  inputSchema: z.object({
    action: z.enum(["list", "list-cwd", "send", "ask", "handover", "reply", "pending", "status", "cancel"]),
    to: z.string().optional().describe("Target session: name, session id or a prefix of either"),
    message: z.string().optional().describe("The message (send/ask/reply), or the next task (handover)"),
    attachments: z.array(ATTACHMENT).optional(),
    replyTo: z.string().optional().describe("Message id this answers (threading, or an ask's reply)"),
    messageId: z.string().optional().describe("For cancel: the id of a message you sent"),
    cwd: z
      .string()
      .optional()
      .describe("list-cwd: the directory; send/ask/handover: the target must be there (alone: the sole session there)"),
  }),
  execute: async (input, ctx) => {
    const s = st(ctx);
    if (!s.config.enabled) throw new Error("Intercom is disabled (intercom/config.json)");
    const cwd = input.cwd !== undefined ? resolve(ctx.cwd, input.cwd) : undefined;
    const need = (v: string | undefined, what: string) => {
      if (!v?.trim()) throw new Error(`"${what}" is required for ${input.action}`);
      return v;
    };
    switch (input.action) {
      case "list":
        return list(s);
      case "list-cwd":
        return list(s, cwd ?? ctx.cwd);
      case "status": {
        if (s.held) return `Connected: No (${s.held})`;
        const sessions = (await call(s, { type: "list" })).sessions ?? [];
        const info = s.info as SessionInfo;
        return `Connected: Yes, Session ID: ${info.id}, Name: ${info.name ?? "(unnamed)"}, Pool: ${s.scope ?? "default"}, Active sessions: ${sessions.length}`;
      }
      case "pending": {
        const asks = [...s.pending.values()];
        if (!asks.length) return "No pending asks.";
        return asks
          .map(
            (p) =>
              `• ${label(p.from)} (${p.from.id.slice(0, 8)}) message ${p.message.id} · ${ago(p.at)}: ${p.message.text.slice(0, 80)}`,
          )
          .join("\n");
      }
      case "cancel": {
        const r = await call(s, { type: "cancel", messageId: need(input.messageId, "messageId") });
        return r.status === "cancelled"
          ? `Message ${input.messageId} was still queued: cancelled`
          : `Cancellation requested for message ${input.messageId}`;
      }
      case "reply": {
        const r = replyTarget(s, ctx, input.to, input.replyTo);
        const d = await deliver(s, ctx, {
          to: r.from.id,
          text: need(input.message, "message"),
          ...(input.attachments ? { attachments: input.attachments } : {}),
          replyTo: r.message.id,
          explicitReply: true,
        });
        return sentText(d, "Reply");
      }
      case "ask":
        if (input.to === undefined && cwd === undefined) throw new Error('"to" or "cwd" is required for ask');
        return ask(s, ctx, {
          ...(input.to !== undefined ? { to: input.to } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          text: need(input.message, "message"),
          ...(input.attachments ? { attachments: input.attachments } : {}),
        });
      case "send":
      case "handover": {
        if (input.to === undefined && cwd === undefined)
          throw new Error(`"to" or "cwd" is required for ${input.action}`);
        const where = { ...(input.to !== undefined ? { to: input.to } : {}), ...(cwd !== undefined ? { cwd } : {}) };
        if (input.action === "handover") {
          if (input.replyTo || input.attachments) throw new Error("handover takes no replyTo or attachments");
          const d = await deliver(s, ctx, { ...where, text: await handover(s, ctx, input.message) });
          return sentText(d, "Handover");
        }
        let replyTo = input.replyTo;
        const inferred = replyTo ? undefined : inferReply(s, input.to, cwd);
        replyTo ??= inferred?.message.id;
        // a turn an ask started answers that ask, not a guessed peer
        const turn = s.turn?.runId === ctx.run?.id ? s.turn : undefined;
        if (
          !replyTo &&
          turn?.inbound.message.expectsReply &&
          !turn.replied &&
          !matches(input.to, cwd, turn.inbound.from)
        )
          throw new Error(
            `This turn answers an ask from ${label(turn.inbound.from)}: reply with intercom({ action: "reply", message: "..." }), or pass replyTo to send elsewhere`,
          );
        const d = await deliver(s, ctx, {
          ...where,
          text: need(input.message, "message"),
          ...(input.attachments ? { attachments: input.attachments } : {}),
          ...(replyTo ? { replyTo } : {}),
          explicitReply: !!input.replyTo,
        });
        return inferred && !d.queued ? `Reply sent to ${label(d.target)} (inferred from pending ask)` : sentText(d);
      }
    }
  },
});

// ---- commands ----

async function others(s: State) {
  const sessions = (await call(s, { type: "list" })).sessions ?? [];
  return sessions.filter((x) => x.id !== s.info?.id);
}

/** asks whom to talk to, from the roster */
async function pickSession(s: State, ctx: Ctx, question: string) {
  const peers = await others(s);
  if (!peers.length) throw new Error("No other intercom sessions are connected");
  const options = peers.map((p) => ({
    label: `${label(p)} (${p.id.slice(0, 8)})`,
    description: `${tilde(p.cwd)} · ${p.status ?? ""}`,
  }));
  const picked = await ctx.ask({ question, options });
  const i = options.findIndex((o) => o.label === picked);
  return peers[i];
}

/** `/intercom` and Alt+M: pick a session, write the message, send */
async function compose(ctx: Ctx, arg = "") {
  const s = st(ctx);
  const [, who, rest] = arg.trim().match(/^(\S+)\s*([\s\S]*)$/) ?? [];
  if (!who && !ctx.host.interactive) return list(s);
  const to = who ? target(ctx, who) : { to: (await pickSession(s, ctx, "Send to which session?"))?.id };
  if (!to.to && !to.cwd) return;
  const text = rest || (await ctx.ask({ question: `Message to ${who ?? "the session"}`, allowText: true }));
  if (typeof text !== "string" || !text.trim()) return "Nothing sent";
  return sentText(await deliver(s, ctx, { ...to, text, explicitReply: true }));
}

const commands: Command[] = [
  {
    name: "intercom",
    args: "[session message]",
    description: "Send a message to another hortus session (alone: pick one)",
    complete: async (ctx) =>
      (await others(st(ctx)).catch(() => [])).map((p) => ({
        value: `${p.name ?? p.id} `,
        label: label(p),
        description: `${tilde(p.cwd)} · ${p.status ?? ""}`,
      })),
    run: (arg, ctx) => compose(ctx, arg),
  },
  {
    name: "intercom-id",
    description: "Put a snippet that targets this session into the prompt (to paste elsewhere)",
    run: async (_, ctx) => {
      const s = st(ctx);
      if (!s.info) await register(s);
      const snippet = `intercom({ action: "send", to: ${JSON.stringify(s.info?.id)}, message: "..." })`;
      if (ctx.host.kind !== "tui") return snippet;
      cliOf(ctx).setInput(snippet);
    },
  },
  {
    name: "intercom-pool",
    args: "[name | default]",
    description: "Show or switch the intercom pool: sessions only see those in the same pool",
    run: async (arg, ctx) => {
      const s = st(ctx);
      const name = arg.trim();
      if (!name) return `Intercom pool: ${s.scope ?? "default"}`;
      if (s.waiting) throw new Error(`Waiting for ${s.waiting.to} to reply: switch pools after that`);
      s.scope = name === "default" ? undefined : name;
      await register(s);
      return `Intercom pool: ${s.scope ?? "default"}`;
    },
  },
  {
    name: "alias",
    args: "[name]",
    description: "Name this session (the session title intercom peers address it by)",
    run: async (arg, ctx) => {
      const session = ctx.session;
      if (!session) throw new Error("No session");
      let name: unknown = arg.trim();
      if (!name && ctx.host.interactive)
        name = await ctx.ask({
          question: `Alias for this session (now: ${session.getState().name ?? "none"})`,
          allowText: true,
        });
      if (typeof name !== "string" || !name.trim()) return `Alias: ${session.getState().name ?? "(none)"}`;
      await session.setName(name.trim());
      return `Alias: ${name.trim()}`;
    },
  },
  {
    name: "handover",
    args: "[session|path] [next task]",
    description: "Summarize this session and hand it over to another one, which acts on it",
    complete: async (ctx) =>
      (await others(st(ctx)).catch(() => [])).map((p) => ({ value: `${p.name ?? p.id} `, label: label(p) })),
    run: async (arg, ctx) => {
      const s = st(ctx);
      const [, who, task] = arg.trim().match(/^(\S+)\s*([\s\S]*)$/) ?? [];
      const to = who ? target(ctx, who) : { to: (await pickSession(s, ctx, "Hand over to which session?"))?.id };
      if (!to.to && !to.cwd) return;
      const next = task || (who ? "" : await ctx.ask({ question: "The next task (optional)", allowText: true }));
      let text = await handover(s, ctx, typeof next === "string" ? next : undefined);
      // reviewed (and edited) before it goes, where someone can
      if (ctx.host.interactive) {
        const edited = await ctx.ask({
          kind: "intercom:review",
          question: "Review the handover (Enter sends, Esc cancels)",
          allowText: true,
          data: { text },
        });
        if (typeof edited !== "string" || !edited.trim()) return "Handover cancelled";
        text = edited;
      }
      return sentText(await deliver(s, ctx, { ...to, text, explicitReply: true }), "Handover");
    },
  },
];

// ---- the TUI ----

/** an incoming message: who and where from, then the body (its first lines, all with Ctrl+O) */
const MessageEntry: EntryRenderer["Render"] = ({ entry }) => {
  const t = useTheme();
  const expanded = useUi((u) => u.expanded);
  const r = entry.meta?.details as Inbound | undefined;
  if (!r) return <Text>{entry.text}</Text>;
  const rows = body(r.message).split("\n");
  const shown = expanded ? rows : rows.slice(0, 6);
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={t.accent}>{`✉ ${label(r.from)}`}</Text>
        <Text
          color={t.dim}
        >{` ${tilde(r.from.cwd)}${r.message.expectsReply ? " · asks" : r.message.replyTo ? " · reply" : ""}`}</Text>
      </Text>
      <Text>{shown.join("\n")}</Text>
      {shown.length < rows.length && <Text color={t.dim}>{`… ${rows.length - shown.length} more lines (Ctrl+O)`}</Text>}
    </Box>
  );
};

const toolBlock = linesRenderer(({ call, result }) => {
  const i = call.input as { action?: string; to?: string; cwd?: string; message?: string };
  const out: Span[][] = [
    [
      { text: "intercom ", color: theme.toolTitle, bold: true },
      { text: `${i.action ?? ""}${i.to || i.cwd ? ` → ${i.to ?? tilde(i.cwd ?? "")}` : ""}`, color: theme.accent },
    ],
  ];
  if (i.message) out.push([{ text: i.message.split("\n")[0] ?? "", color: theme.dim }]);
  if (result)
    for (const l of result.output.split("\n").slice(0, 8))
      out.push([{ text: l, color: result.isError ? theme.red : theme.toolOutput }]);
  return out;
});

function ReviewDialog({ ask }: { ask: AskEvent }) {
  const t = useTheme();
  const [text, setText] = useState(() => (ask.data as { text?: string } | undefined)?.text ?? "");
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.accent} paddingX={1}>
      <Text color={t.accent}>{ask.question}</Text>
      <PromptInput
        value={text}
        onChange={(v) => {
          ask.engage();
          setText(v);
        }}
        onSubmit={() => ask.resolve(text)}
        onKey={(_, key) => {
          if (!key.escape) return false;
          ask.resolve(undefined);
          return true;
        }}
      />
    </Box>
  );
}

const mine = (ctx: Ctx, s: State) => !ctx.run?.depth && ctx.session?.id === s.ctx.session?.id;

export default {
  tools: [intercom],
  commands,
  on: {
    init: async (_, ctx) => {
      const { config, error } = loadConfig();
      const scope = process.env.HORTUS_INTERCOM_SCOPE_ID?.trim();
      stateOf(
        ctx,
        "st",
        (): State => ({
          ctx,
          config,
          retry: 0,
          inbox: new Map(),
          pending: new Map(),
          queued: [],
          tools: new Map(),
          running: false,
          ...(scope && { scope }),
        }),
      );
      if (error) await ctx.notify(`${error}: incoming messages won't start runs until it's fixed`, "error");
    },
    session_open: async ({ session }, ctx) => {
      const s = st(ctx);
      if (!s.config.enabled) return;
      // a new session is a new identity: nothing it was asked carries over
      s.pending.clear();
      s.turn = undefined;
      s.unsubscribe?.();
      s.unsubscribe = session.subscribe((now, prev) => {
        if (now.name !== prev.name) presence(s, { name: now.name });
        if (now.model !== prev.model && now.model) presence(s, { model: now.model });
      });
      await register(s).catch((e) => ctx.notify(`Intercom: ${errorText(e)}`, "warn"));
    },
    run_start: (p, ctx) => {
      const s = st(ctx);
      if (p.source !== "run" || !mine(ctx, s)) return;
      s.running = true;
      presence(s, { status: statusText(s), model: p.model });
    },
    tool_call: ({ call }, ctx) => {
      const s = st(ctx);
      if (call.parentId || !mine(ctx, s)) return;
      s.tools.set(call.id, call.name);
      presence(s, { status: statusText(s) });
    },
    tool_result: ({ call }, ctx) => {
      const s = st(ctx);
      if (!s.tools.delete(call.id)) return;
      presence(s, { status: statusText(s) });
    },
    message: (m, ctx) => {
      const s = st(ctx);
      if (!ctx.run || !mine(ctx, s)) return;
      if (m.role === "user" && m.meta?.plugin === ctx.plugin && m.meta.type === "message") {
        const r = m.meta.details as Inbound;
        s.turn = { runId: ctx.run.id, inbound: s.inbox.get(r.message.id) ?? r };
      }
      const window = ctx.run.info.contextWindow;
      const messages = ctx.session?.getState().messages;
      if (m.role === "assistant" && m.usage && window && messages)
        presence(s, { contextPct: Math.round((100 * contextTokens(messages)) / window) });
    },
    // human-first: one held message steers in at a turn's end, unless a person's input is waiting (not awaited: a
    // steer resolves when this run ends)
    turn_end: (_, ctx) => {
      const s = st(ctx);
      if (!s.queued.length || !mine(ctx, s) || ctx.signal.aborted) return;
      if (ctx.pending().some((x) => x.source === "user")) return;
      const r = s.queued.shift();
      if (r) void sendInbound(s, r);
    },
    idle: ({ session }, ctx) => {
      const s = st(ctx);
      if (session !== s.ctx.session) return;
      for (const r of s.queued.splice(0)) void sendInbound(s, r);
    },
    run_end: (p, ctx) => {
      const s = st(ctx);
      if (p.source !== "run" || !mine(ctx, s)) return;
      s.running = false;
      s.tools.clear();
      if (s.turn?.runId === ctx.run?.id) s.turn = undefined;
      presence(s, { status: statusText(s) });
    },
    intercom_send: async (p, ctx) => {
      const s = st(ctx);
      if (s.config.confirmSend && !ctx.host.interactive) {
        p.result = { ok: false, code: "confirmation_unavailable", error: "confirmSend is on and nobody can confirm" };
        return;
      }
      try {
        const d = await deliver(s, ctx, { to: p.to, text: p.message });
        p.result = { ok: true, messageId: d.message.id };
      } catch (e) {
        p.result = { ok: false, error: errorText(e) };
      }
    },
    close: (_, ctx) => {
      const s = st(ctx);
      s.closed = true;
      s.unsubscribe?.();
      s.sock?.end();
    },
  },
  cli: {
    entries: { "intercom:message": { Render: MessageEntry } },
    tools: { intercom: toolBlock },
    asks: { "intercom:review": ReviewDialog },
    // Alt+M: pick a session and write to it
    keys: (input, key, cli, ctx) => {
      if (!key.meta || input !== "m") return;
      void compose(ctx).then(
        (text) => text && cli.push({ kind: "info", text }),
        (e) => cli.push({ kind: "error", text: `Intercom: ${errorText(e)}` }),
      );
      return true;
    },
  },
} satisfies CliPlugin;
