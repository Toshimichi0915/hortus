import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/** What the reviewer decided: `approved` (plans, gated annotations), `feedback` (their notes), or `exit` (closed). */
export interface Decision {
  approved?: boolean;
  feedback?: string;
  exit?: boolean;
  /** why it ended without the reviewer: "stopped" (plan mode left, session closed, exit) or "agent" (the tool closed it) */
  closedBy?: "stopped" | "agent";
  /** the plan text decided on (plan reviews) */
  plan?: string;
}

export interface ReviewServer {
  url: string;
  decision: Promise<Decision>;
  /** shows a revision in the open page (it polls); null once decided */
  update(content: string): { version: number; unchanged: boolean } | null;
  /** ends it with `closedBy` (nothing more is accepted) and frees the port */
  stop(closedBy?: Decision["closedBy"]): void;
}

export interface ReviewOptions {
  kind: "plan" | "review" | "annotate" | "last";
  title: string;
  content: string;
  /** an Approve button (plans always have one) */
  gate?: boolean;
  /** "Ask this session": answers a question from the page */
  ask?: (question: string, interrupt: boolean) => Promise<string>;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 1 << 20) throw new Error("Body too large");
  }
  const v = s ? JSON.parse(s) : {};
  return typeof v === "object" && v ? v : {};
}

/**
 * A local review page on 127.0.0.1 (a random port; every request needs the URL's token): the content, a feedback box,
 * Approve / Send feedback / Close, and an Ask box. ponytail: a plain page in place of Plannotator's bundled React app
 * (inline annotations, plan diffs, code-review UI); its decisions arrive through the same `decision` shape.
 */
export async function startReviewServer(opts: ReviewOptions): Promise<ReviewServer> {
  const token = randomBytes(16).toString("hex");
  const versions = [opts.content];
  let settle!: (d: Decision) => void;
  let decided = false;
  const decision = new Promise<Decision>((r) => {
    settle = (d) => {
      if (decided) return;
      decided = true;
      r({ ...d, ...(opts.kind === "plan" && { plan: versions.at(-1) }) });
      server.close();
      server.closeAllConnections();
    };
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, data: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(type === "application/json" ? JSON.stringify(data) : String(data));
    };
    if (url.searchParams.get("t") !== token) return send(403, { error: "Bad token" });
    try {
      if (url.pathname === "/" && req.method === "GET") return send(200, page(token), "text/html; charset=utf-8");
      if (url.pathname === "/api/state" && req.method === "GET")
        return send(200, { ...opts, ask: !!opts.ask, content: versions.at(-1), version: versions.length, decided });
      if (url.pathname === "/api/decision" && req.method === "POST") {
        const b = await body(req);
        if (decided) return send(409, { error: "Already decided" });
        send(200, { ok: true });
        return settle({
          approved: b.approved === true,
          exit: b.exit === true,
          ...(typeof b.feedback === "string" && b.feedback.trim() && { feedback: b.feedback.trim() }),
        });
      }
      if (url.pathname === "/api/ask" && req.method === "POST" && opts.ask) {
        const b = await body(req);
        if (typeof b.question !== "string" || !b.question.trim()) return send(400, { error: "No question" });
        return send(200, { answer: await opts.ask(b.question, b.interrupt === true) });
      }
      send(404, { error: "Not found" });
    } catch (e) {
      send(500, { error: (e as Error).message });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    decision,
    update: (content) => {
      if (decided) return null;
      if (content === versions.at(-1)) return { version: versions.length, unchanged: true };
      versions.push(content);
      return { version: versions.length, unchanged: false };
    },
    stop: (closedBy = "stopped") => settle({ exit: true, closedBy }),
  };
}

/** Opens `url` with `browser` ("none": nothing), else `PLANNOTATOR_BROWSER`, `BROWSER`, or the OS's opener. */
export function openBrowser(url: string, browser?: string) {
  const cmd = browser ?? process.env.PLANNOTATOR_BROWSER ?? process.env.BROWSER;
  if (cmd === "none") return;
  const [bin, args] = cmd
    ? [cmd, [url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(bin, args, { detached: true, stdio: "ignore" })
    .on("error", () => {})
    .unref();
}

const page = (token: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plannotator</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--muted:#666;--line:#ddd;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#e8e8ea;--muted:#999;--line:#333;--accent:#60a5fa}}
body{margin:0 auto;max-width:56rem;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
pre{white-space:pre-wrap;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto}
textarea,input{width:100%;box-sizing:border-box;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px;font:inherit}
textarea{min-height:8rem}button{margin:8px 8px 0 0;padding:6px 14px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}small{color:var(--muted)}
</style></head><body>
<h1 id="title">Plannotator</h1><small id="meta"></small><pre id="content"></pre>
<label for="feedback">Feedback</label><textarea id="feedback"></textarea>
<div><button class="primary" id="approve" hidden>Approve</button><button id="send">Send feedback</button><button id="close">Close</button></div>
<section id="asks" hidden><h2>Ask this session</h2><input id="question"><button id="ask">Ask</button><label><input type="checkbox" id="interrupt" style="width:auto"> Interrupt and ask now</label><pre id="answer"></pre></section>
<script>
const t=${JSON.stringify(token)};const $=(id)=>document.getElementById(id);const api=(p,b)=>fetch(p+"?t="+t,b?{method:"POST",body:JSON.stringify(b)}:{}).then(r=>r.json());
let version=0;
async function poll(){const s=await api("/api/state");if(s.version!==version){version=s.version;$("content").textContent=s.content;}
$("title").textContent=s.title;$("meta").textContent=s.kind+(s.version>1?" · version "+s.version:"")+(s.decided?" · closed":"");
$("approve").hidden=!(s.kind==="plan"||s.gate);$("asks").hidden=!s.ask;if(!s.decided)setTimeout(poll,2000);}
const decide=async(d)=>{await api("/api/decision",{...d,feedback:$("feedback").value});$("meta").textContent="Sent. You can close this tab.";};
$("approve").onclick=()=>decide({approved:true});$("send").onclick=()=>decide({});$("close").onclick=()=>decide({exit:true});
$("ask").onclick=async()=>{$("answer").textContent="…";const r=await api("/api/ask",{question:$("question").value,interrupt:$("interrupt").checked});$("answer").textContent=r.answer??r.error;};
poll();
</script></body></html>`;
