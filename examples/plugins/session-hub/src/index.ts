/**
 * The TUI side of the session hub (hub.ts): the session the TUI has open is attached to the hub, which stops its
 * background worker and relays the chat's messages here instead; leaving the session hands it back. A `/resume` to a
 * session another TUI holds is cancelled (`session_close.cancel`), so a session never has two writers.
 */
import { connect } from "node:net";
import type { CliPlugin } from "@hortus/cli";
import type { Ctx } from "@hortus/core";
import { hubSocket, replyOf } from "./hub.ts";

interface Answer {
  ok: boolean;
  reason?: string;
}
interface Conn {
  call(m: { type: "attach" | "detach" | "can_switch"; sessionId: string; cwd?: string }): Promise<Answer>;
}
interface State {
  conn?: Promise<Conn | undefined>;
}

const STATUS = "session-hub";
const isTui = (ctx: Ctx) => ctx.host.kind === "tui";

/** this agent's connection to the hub; undefined when no hub runs */
function hub(ctx: Ctx, st = ctx.state as State) {
  st.conn ??= new Promise((resolve) => {
    const sock = connect(hubSocket());
    const calls = new Map<number, (a: Answer) => void>();
    let n = 0;
    sock.on("error", () => resolve(undefined));
    sock.on("close", () => {
      st.conn = undefined;
      for (const r of calls.values()) r({ ok: false, reason: "The hub went away" });
      void ctx.status(STATUS);
    });
    sock.on("connect", () =>
      resolve({
        call: (m) =>
          new Promise((r) => {
            calls.set(++n, r);
            sock.write(`${JSON.stringify({ id: n, ...m })}\n`);
          }),
      }),
    );
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.type === "prompt") {
          // a chat message for the session shown here: a turn of its own, after any running one
          void ctx
            .send(m.text, { deliver: "after", source: "session-hub" })
            .then((end) => replyOf(end?.messages, end?.error as { message?: string }))
            .catch((e) => `Error: ${e instanceof Error ? e.message : e}`)
            .then((text) => sock.write(`${JSON.stringify({ type: "reply", pid: m.pid, text })}\n`));
        } else {
          calls.get(m.id)?.(m);
          calls.delete(m.id);
        }
      }
    });
  });
  return st.conn;
}

export default {
  on: {
    session_open: async ({ session }, ctx) => {
      if (!isTui(ctx)) return;
      const r = await (await hub(ctx))?.call({ type: "attach", sessionId: session.id, cwd: ctx.cwd });
      await ctx.status(STATUS, r?.ok ? "chat: attached" : undefined);
      if (r?.reason) await ctx.notify(r.reason, "warn");
    },
    session_close: async (p, ctx) => {
      const st = ctx.state as State;
      if (!isTui(ctx) || p.reason !== "resume" || !p.target || !st.conn) return;
      const c = await st.conn;
      if (!c) return;
      const r = await c.call({ type: "can_switch", sessionId: p.target.id });
      if (r.ok) return;
      p.cancel = true;
      await ctx.notify(r.reason ?? "The hub refused the switch", "warn");
    },
    session_closed: async ({ session, reason }, ctx) => {
      const c = isTui(ctx) && reason !== "child" && (await (ctx.state as State).conn);
      if (c) await c.call({ type: "detach", sessionId: session.id });
    },
  },
} satisfies CliPlugin;
