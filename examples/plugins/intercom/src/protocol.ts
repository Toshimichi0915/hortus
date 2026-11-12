/** What the broker (broker.ts) and its clients (index.tsx) say to each other: one JSON object per line. */
import type { Socket } from "node:net";

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

/** A connected session, as the roster shows it; everything but `id` and `scope` is display metadata. */
export interface SessionInfo {
  /** the hortus session's id (or the one an `intercom_identity` handler claimed) */
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  /** "idle", "thinking" or "tool:<name>", then config's `status` */
  status?: string;
  /** the pool: sessions only see and reach those of the same one */
  scope?: string;
  contextPct?: number;
}

export interface IntercomMessage {
  id: string;
  timestamp: number;
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  /** an `ask`: the sender waits for a reply */
  expectsReply?: boolean;
}

export type ToBroker = { reqId: number } & (
  | { type: "register"; session: SessionInfo }
  | { type: "presence"; patch: Partial<SessionInfo> }
  | { type: "list" }
  /** `to`: a name, id or prefix of either; `cwd` narrows (alone: the sole session there) */
  | { type: "send"; to?: string; cwd?: string; message: IntercomMessage; requireConnected?: boolean }
  | { type: "cancel"; messageId: string }
);

export interface Reply {
  type: "reply";
  reqId: number;
  error?: string;
  /** "E_SESSION_HELD" for a register refused because another live process holds the id */
  code?: string;
  sessions?: SessionInfo[];
  /** a send's target */
  target?: SessionInfo;
  delivery?: "socket_delivered" | "queued";
  /** a cancel's outcome */
  status?: "cancelled" | "cancellation_requested";
}

export type FromBroker =
  | Reply
  | { type: "message"; from: SessionInfo; message: IntercomMessage }
  | { type: "cancel"; from: SessionInfo; messageId: string };

/** Calls `fn` with each JSON line `sock` receives (a malformed one is dropped). */
export function lines(sock: Socket, fn: (msg: unknown) => void) {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (d: string) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      fn(msg);
    }
  });
}

export const write = (sock: Socket, msg: unknown) => {
  if (!sock.destroyed) sock.write(`${JSON.stringify(msg)}\n`);
};
