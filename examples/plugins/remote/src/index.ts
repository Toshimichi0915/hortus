import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { type AskEvent, type Ctx, type Handlers, hortusDir, type Plugin, type SendOptions } from "@hortus/core";

/**
 * Where clients find this process's server: `{ url, token }`, mode 0600, removed at exit. One file per process, so
 * several hortus processes don't clobber each other's; clients pick one of `~/.hortus/remote-*.json`.
 */
export const infoPath = () => join(hortusDir(), `remote-${process.pid}.json`);

// ponytail: one server per process (module state); a second agent in the process would replace its info file
let server: Server | undefined;
const clients = new Set<ServerResponse>();
/** asks sent to clients and not yet answered (by anyone), by id */
const asks = new Map<string, AskEvent>();
/** what lets go of each of those asks: called when the last client leaves, as no one is left to answer */
const holds = new Map<string, () => void>();

/** Sends `name` to every `/events` client as a server-sent event. */
function broadcast(name: string, payload: unknown) {
  let data: string;
  try {
    data = JSON.stringify({ name, payload });
  } catch {
    data = JSON.stringify({ name });
  }
  for (const res of clients) res.write(`data: ${data}\n\n`);
}

const body = async (req: IncomingMessage) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  return JSON.parse(text || "{}") as { text?: unknown; deliver?: unknown; id?: unknown; answer?: unknown };
};

/** The server's requests, each needing `Authorization: Bearer <token>`. */
function handler(ctx: Ctx, token: Buffer) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const given = Buffer.from(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
    if (given.length !== token.length || !timingSafeEqual(given, token)) return res.writeHead(401).end();
    if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }).flushHeaders();
      clients.add(res);
      req.on("close", () => {
        clients.delete(res);
        if (clients.size) return;
        // no one left to answer: let go, so the ask fails closed unless another handler answers
        for (const done of holds.values()) done();
        holds.clear();
      });
      return;
    }
    if (req.method === "POST" && req.url === "/send") {
      try {
        const { text, deliver = "steer" } = await body(req);
        if (typeof text !== "string" || !["context", "steer", "after"].includes(String(deliver)))
          return res.writeHead(400).end("Expected { text, deliver?: context | steer | after }");
        // not awaited: a started run may take long; its events stream to /events
        void ctx.send(text, { deliver: deliver as SendOptions["deliver"], source: "remote" }).catch(() => {});
        return res.writeHead(202).end();
      } catch (e) {
        return res.writeHead(400).end(e instanceof Error ? e.message : String(e));
      }
    }
    if (req.method === "POST" && req.url === "/engage") {
      try {
        const { id } = await body(req);
        const ask = typeof id === "string" ? asks.get(id) : undefined;
        if (!ask) return res.writeHead(404).end("No such ask (answered already?)");
        ask.engage();
        return res.writeHead(204).end();
      } catch (e) {
        return res.writeHead(400).end(e instanceof Error ? e.message : String(e));
      }
    }
    if (req.method === "POST" && req.url === "/answer") {
      try {
        const { id, answer } = await body(req);
        const ask = typeof id === "string" ? asks.get(id) : undefined;
        if (!ask) return res.writeHead(404).end("No such ask (answered already?)");
        const ok =
          answer === null ||
          typeof answer === "string" ||
          (Array.isArray(answer) && answer.every((a) => typeof a === "string"));
        if (!ok) return res.writeHead(400).end("Expected { id, answer: string | string[] | null }");
        ask.resolve((answer as string | string[] | null) ?? undefined);
        return res.writeHead(204).end();
      } catch (e) {
        return res.writeHead(400).end(e instanceof Error ? e.message : String(e));
      }
    }
    res.writeHead(404).end();
  };
}

/** Forwarded to `/events` clients as they are (`run_start`/`run_end` slimmed down). */
const FORWARDED = ["input", "message", "text", "tool_call", "tool_result", "idle"] as const;

/**
 * Drives hortus from elsewhere (a phone, a chat bridge): a local HTTP server (port `HORTUS_REMOTE_PORT`, default any
 * free one; address and a fresh bearer token in `~/.hortus/remote-<pid>.json`) whose `POST /send { text, deliver? }` sends a
 * message through the host ctx kept from `init` (default "steer": starts a turn when idle, steers a running one), and
 * whose `GET /events` streams the agent's events. While a client listens, each `ask` is streamed too (`{ name: "ask",
 * payload: { id, question, options, ... } }`, never a secret's answer; when the last client leaves, its pending asks are
 * left to other handlers, so with none they fail closed), and `POST /answer { id, answer }` answers it
 * (a string, an array for `multi`, null to dismiss), racing the TUI's dialog: the first answer wins, closing the other;
 * `answered { id }` follows either way. A streamed ask counts as shown (`show()`), and `POST /engage { id }` says a
 * client is answering it (`engage()`: an autopilot's countdown stops).
 */
export default {
  on: {
    init: async (_, ctx) => {
      const token = randomBytes(24).toString("hex");
      const s = createServer(handler(ctx, Buffer.from(token)));
      await new Promise<void>((resolve, reject) => {
        s.once("error", reject);
        s.listen(Number(process.env.HORTUS_REMOTE_PORT ?? 0), "127.0.0.1", resolve);
      });
      server = s;
      const { port } = s.address() as { port: number };
      await writeFile(infoPath(), `${JSON.stringify({ url: `http://127.0.0.1:${port}`, token })}\n`, { mode: 0o600 });
      await chmod(infoPath(), 0o600);
    },
    ...Object.fromEntries(FORWARDED.map((name) => [name, (p: unknown) => broadcast(name, p)])),
    run_start: ({ source, model, provider }) => {
      if (source === "run") broadcast("run_start", { model, provider });
    },
    run_end: ({ source, aborted, error }) => {
      if (source === "run") broadcast("run_end", { aborted, ...(error !== undefined && { error: String(error) }) });
    },
    // only while someone listens: else no one could answer, and the ask mustn't wait on this handler
    ask: (p) => {
      if (!clients.size || p.signal.aborted) return;
      const id = randomBytes(8).toString("hex");
      asks.set(id, p);
      const { signal, resolve, answered, show, shown, engage, engaged, ...fields } = p;
      broadcast("ask", { id, ...fields });
      // in front of someone now: e.g. an autopilot's countdown starts
      show();
      return new Promise<void>((done) => {
        holds.set(id, done);
        p.signal.addEventListener(
          "abort",
          () => {
            asks.delete(id);
            holds.delete(id);
            broadcast("answered", { id });
            done();
          },
          { once: true },
        );
      });
    },
    close: async () => {
      for (const res of clients) res.end();
      clients.clear();
      server?.closeAllConnections();
      server?.close();
      server = undefined;
      await rm(infoPath(), { force: true });
    },
  } as Handlers,
} satisfies Plugin;
