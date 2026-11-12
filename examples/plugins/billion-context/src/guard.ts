import { createHash } from "node:crypto";
import type { Ctx, Events, ToolResult } from "@hortus/core";

/** `guardrails` in the plugin's config (Pi: `guardrails.*` in billion-context.json, or `BILI_GUARDRAIL_*`). */
export interface GuardConfig {
  /** seconds a bash call gets when it names no `timeout` (default 60; 0 = leave bash's own default) */
  bashTimeout?: number;
  /** a tool result's text is cut to this many bytes (default 50000; 0 = never) */
  maxOutputBytes?: number;
  /** consecutive identical calls: warn at `warn` (3), refuse at `abort` (5), then abort the run; false = off */
  repetition?: boolean | { enabled?: boolean; warn?: number; abort?: number; recovery?: boolean };
}

/** Per-agent guardrail state (in the plugin's `ctx.state`). */
export interface GuardState {
  /** repetition trackers by session id */
  trackers: Map<string, Tracker>;
  /** call id → the repetition count a warning is appended to its result for */
  warns: Map<string, number>;
}

const SLOW_CALL_MS = 5000;
const BACKSTOP = 5;

const canonical = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const entries = Object.entries(v)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
};
const fingerprint = (name: string, input: unknown) =>
  createHash("sha1")
    .update(`${name}\0${canonical(input ?? {})}`)
    .digest("hex");

type Action = "none" | "warn" | "final-refuse" | "abort" | "soft-stop" | "hard-abort";

/** Pi's RepetitionTracker: counts consecutive identical calls; a slow identical call (a deliberate wait) restarts it. */
export class Tracker {
  private last?: string;
  private count = 0;
  private done?: { fp: string; ms: number };
  private starts = new Map<string, { fp: string; at: number }>();
  constructor(private t: { warn: number; abort: number; recovery: boolean }) {}
  note(name: string, input: unknown, id: string): { action: Action; count: number } {
    const fp = fingerprint(name, input);
    if (this.done?.fp === fp && this.done.ms >= SLOW_CALL_MS) this.last = undefined;
    this.count = fp === this.last ? this.count + 1 : 1;
    this.last = fp;
    this.starts.set(id, { fp, at: Date.now() });
    const { warn, abort, recovery } = this.t;
    const action: Action =
      recovery && this.count >= abort + BACKSTOP
        ? "hard-abort"
        : recovery && this.count > abort
          ? "soft-stop"
          : this.count > abort
            ? "abort"
            : this.count === abort
              ? "final-refuse"
              : this.count >= warn
                ? "warn"
                : "none";
    return { action, count: this.count };
  }
  complete(id: string) {
    const s = this.starts.get(id);
    if (!s) return;
    this.starts.delete(id);
    this.done = { fp: s.fp, ms: Date.now() - s.at };
  }
  reset() {
    this.last = undefined;
    this.count = 0;
    this.done = undefined;
    this.starts.clear();
  }
}

const positive = (v: unknown, d: number) => (typeof v === "number" && v > 0 ? Math.floor(v) : d);

function repetition(c: GuardConfig["repetition"]) {
  if (c === false) return undefined;
  const o = typeof c === "object" ? c : {};
  if (o.enabled === false) return undefined;
  const warn = positive(o.warn, 3);
  return { warn, abort: Math.max(positive(o.abort, 5), warn + 1), recovery: o.recovery === true };
}

const notices = {
  warn: (tool: string, n: number) =>
    `\n\n[ACP guardrail: WARNING — you have issued ${n} CONSECUTIVE identical \`${tool}\` calls in quick succession (same tool, equivalent arguments — key order aside). If nothing changed since the last result, re-issuing this exact call will not help; if you are deliberately waiting/polling external state, one LONGER wait beats repeated short polls. Continuing the identical call escalates to a hard refusal before the turn is aborted.]`,
  "final-refuse": (tool: string, n: number) =>
    `[ACP guardrail: REFUSED — you issued ${n} consecutive identical \`${tool}\` calls in quick succession (equivalent arguments, key order aside). This call was refused and NOT executed. FINAL WARNING: if the very next call is identical again, the guardrail will take stronger action. If you were waiting/polling external state, issue ONE longer wait instead (larger duration argument) or stop and report to the user. Changing the tool or ANY argument restarts the count.]`,
  abort: (tool: string, n: number) =>
    `[ACP guardrail: BLOCKED — you issued ${n} consecutive identical \`${tool}\` calls in quick succession despite the final refusal. This call was refused and NOT executed. You MUST change strategy: use different arguments, a different tool, or stop and report to the user. Do not re-issue the identical call. The turn has been aborted.`,
  "soft-stop": (tool: string, n: number, backstop: number) =>
    `[ACP guardrail: BLOCKED — you issued ${n} consecutive identical \`${tool}\` calls in quick succession despite the final refusal. This call was refused and NOT executed; identical calls will keep being refused while the turn continues. You MUST change strategy: use different arguments, a different tool, or stop and report to the user. Do not re-issue the identical call. If ${backstop} identical calls in a row are reached, the turn will be forcibly terminated.`,
};

const bytes = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);

/** The first `max` bytes of `s`, on a character boundary, at a line break if one is in its second half. */
function head(s: string, max: number) {
  const buf = Buffer.from(s, "utf8");
  let end = max;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  const h = buf.subarray(0, end).toString("utf8");
  const nl = h.lastIndexOf("\n");
  return nl >= Math.floor(max / 2) ? h.slice(0, nl) : h;
}

export function capOutput(output: string, max: number): string | undefined {
  const total = Buffer.byteLength(output, "utf8");
  if (max <= 0 || total <= max) return;
  const kept = head(output, max);
  const dropped = total - Buffer.byteLength(kept, "utf8");
  // ponytail: hortus's bash keeps no full-output file to point at (Pi's `details.fullOutputPath`)
  return `${kept}\n\n[ACP guardrail: output capped at ${bytes(max)} (~${bytes(dropped)} dropped). To see more, narrow the query or redirect output to a file and read the relevant slice.]`;
}

const TIMEOUT = /Command timed out after (\d+) seconds/;

const tracker = (s: GuardState, c: GuardConfig, sid: string) => {
  const t = repetition(c.repetition);
  if (!t) return;
  const tr = s.trackers.get(sid) ?? new Tracker(t);
  s.trackers.set(sid, tr);
  return tr;
};

/**
 * `tool_call`: gives bash calls without a `timeout` the configured one, and refuses (then aborts on) runs of identical
 * calls. A refused call gets its result set, so it never runs and the model reads the guardrail's text.
 */
export function onToolCall(p: Events["tool_call"], ctx: Ctx, s: GuardState, c: GuardConfig) {
  const { call } = p;
  const input = call.input as Record<string, unknown> | undefined;
  const timeout = c.bashTimeout ?? 60;
  if (call.name === "bash" && input && input.timeout === undefined && timeout > 0) input.timeout = timeout;
  const tr = tracker(s, c, ctx.session?.id ?? "");
  if (!tr || p.result) return;
  const { action, count } = tr.note(call.name, call.input, call.id);
  if (action === "none") return;
  if (action === "warn") {
    s.warns.set(call.id, count);
    return;
  }
  const t = repetition(c.repetition);
  const text =
    action === "final-refuse"
      ? notices["final-refuse"](call.name, count)
      : action === "soft-stop"
        ? notices["soft-stop"](call.name, count, (t?.abort ?? 5) + BACKSTOP)
        : notices.abort(call.name, count);
  void ctx.notify(`[ACP] ${text}`, "warn");
  tr.complete(call.id);
  p.result = { id: call.id, output: text, isError: true };
  if (action === "abort" || action === "hard-abort") ctx.abort("ACP guardrail: repeated identical tool calls");
}

/** `tool_result`: caps the text, explains a bash timeout, appends a pending repetition warning. */
export function onToolResult(p: Events["tool_result"], sid: string, s: GuardState, c: GuardConfig) {
  const { call } = p;
  s.trackers.get(sid)?.complete(call.id);
  // a refusal of ours is left as it is
  if (p.result.output.startsWith("[ACP guardrail:")) return;
  let output = capOutput(p.result.output, c.maxOutputBytes ?? 50000);
  const secs = call.name === "bash" && p.result.isError ? p.result.output.match(TIMEOUT)?.[1] : undefined;
  if (secs) {
    const suggested = Math.min(Math.max(Math.ceil(Number(secs) * 2), 120), 3600);
    output = `${output ?? p.result.output}\n\n[ACP guardrail: command killed after ${secs}s. To give it more time, re-run the bash tool with a larger \`timeout\` argument (e.g. \`"timeout": ${suggested}\`).]`;
  }
  const warn = s.warns.get(call.id);
  if (warn !== undefined) {
    s.warns.delete(call.id);
    output = `${output ?? p.result.output}${notices.warn(call.name, warn)}`;
  }
  if (output !== undefined) p.result = { ...p.result, output } satisfies ToolResult;
}
