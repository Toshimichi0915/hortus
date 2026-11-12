import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type CliPlugin, linesRenderer, type ToolBlock } from "@hortus/cli";
import type { Ctx, Plugin, PluginEntry, Session, Tool } from "@hortus/core";
import { tool } from "@hortus/core";
import { z } from "zod";
import {
  type ArchiveOutcome,
  buildRecoveryNotice,
  compactResultStatus,
  humanToolName,
  MEMORY_INSTRUCTIONS,
  renderCallText,
  renderResultText,
} from "./prompts.ts";

/**
 * gentle-engram: connects hortus to an Engram memory server (`engram serve`, HTTP on 127.0.0.1:7437, started detached
 * when nothing answers). The model gets the `mem_*` tools and the Engram memory protocol in its system prompt; user
 * prompts and other tools' outputs are captured passively (`<private>` blocks redacted); each hortus session is an
 * Engram session (a resumed one that Engram already ended continues as `<id>:resume:<n>`, saved in a session entry),
 * ended when the session closes; after a compaction the summary is archived to Engram and the next run starts with a
 * hidden recovery notice. Other plugins can ask on the bus whether Engram owns a session or a prompt (the bridge).
 */

declare module "@hortus/core" {
  interface Events {
    /** a consumer asks whether native Engram owns this session's registration or a prompt's capture */
    "engram:bridge:claim:v1": BridgeClaim;
    /** engram's answer to a valid claim for the asker's session (none for invalid or foreign ones) */
    "engram:bridge:decision:v1": BridgeClaim & { status: "owned" | "unknown" };
  }
}
export interface BridgeClaim {
  runtimeSessionId: string;
  nonce: string;
  operation: "session-register" | "prompt-capture";
  /** prompt-capture: sha256 hex of the original prompt, trimmed */
  promptDigest?: string;
}

// ─── Transport ───

const env = (name: string) => process.env[name]?.trim() || undefined;
const baseUrl = () => env("ENGRAM_URL") ?? `http://127.0.0.1:${Number.parseInt(env("ENGRAM_PORT") ?? "7437", 10)}`;
const STARTUP_ALLOWED =
  process.env.ENGRAM_STARTUP_POLICY === undefined || process.env.ENGRAM_STARTUP_POLICY === "allow";
const DISABLED_NOTICE = `Engram memory is disabled by startup policy. Back up your existing Engram data, update Engram, restart its server and hortus, then recheck memory safety.${process.env.ENGRAM_STARTUP_NOTICE ? ` ${process.env.ENGRAM_STARTUP_NOTICE}` : ""}`;

const PRIVATE = /<private>[\s\S]*?<\/private>/gi;
export const redact = (s: string) => s.replace(PRIVATE, "[REDACTED]");
const redactValue = (v: unknown): unknown =>
  typeof v === "string"
    ? redact(v)
    : Array.isArray(v)
      ? v.map(redactValue)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x)]))
        : v;
function redactPath(path: string): string {
  const url = new URL(redact(path), "http://engram.local");
  const query = new URLSearchParams([...url.searchParams].map(([k, v]) => [k, redact(v)])).toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}
const qs = (params: Record<string, unknown>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  return q.size ? `?${q}` : "";
};

export class EngramHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: unknown,
  ) {
    super(message);
  }
}
/** the request never got an answer: `unknown` = a write (or registration) the server may have applied */
class TransportError extends Error {
  constructor(
    message: string,
    readonly outcome: "unknown" | "timed_out" | "unreachable",
  ) {
    super(message);
  }
}

interface Opts {
  method?: string;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const code = (e: unknown): unknown => (e as { cause?: { code?: unknown } })?.cause?.code;

/**
 * One Engram call through `ctx.fetch`: bodies and query values redacted; reads retried (3 tries, 10 s each), session
 * registration twice (5 s, idempotent), writes once (3 s). ponytail: no save-result recovery by operation id.
 */
async function engram<T = unknown>(ctx: Ctx, path: string, opts: Opts = {}): Promise<T | null> {
  const method = opts.method ?? "GET";
  const registration = method === "POST" && path === "/sessions";
  const [timeout, attempts] = registration
    ? [5000, 2]
    : method === "GET"
      ? [path.startsWith("/doctor") ? 15000 : 10000, 3]
      : [3000, 1];
  const signal = opts.signal ?? ctx.signal;
  let timedOut = false;
  let ambiguous = false;
  for (let i = 0; i < attempts; i++) {
    if (i) await wait(250 * 2 ** (i - 1));
    let res: Response;
    try {
      res = await ctx.fetch(`${baseUrl()}${redactPath(path)}`, {
        method,
        headers: {
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
          ...(env("ENGRAM_HTTP_TOKEN") ? { Authorization: `Bearer ${env("ENGRAM_HTTP_TOKEN")}` } : {}),
        },
        body: opts.body ? JSON.stringify(redactValue(opts.body)) : undefined,
        signal: signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      if ((e as Error)?.name === "TimeoutError") timedOut = true;
      else ambiguous ||= code(e) !== "ECONNREFUSED";
      continue;
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const error = (data as { error?: unknown } | null)?.error;
      throw new EngramHttpError(
        typeof error === "string" ? error : `Engram request failed with HTTP ${res.status}`,
        res.status,
        data,
      );
    }
    return data as T;
  }
  if (!timedOut && !ambiguous) delete st(ctx).ready; // refused: the next call starts the server again
  if ((timedOut || ambiguous) && method !== "GET")
    throw new TransportError(
      registration
        ? `gentle-engram could not confirm session registration after ${timeout}ms. Its final outcome is unknown. No memory write was sent; retrying the memory operation is safe.`
        : `gentle-engram could not confirm the write after ${timeout}ms. Its outcome is unknown because the server may already have applied it — do NOT blindly retry it, or you may duplicate the write. Verify with mem_search or mem_doctor first.`,
      "unknown",
    );
  if (timedOut)
    throw new TransportError(
      `gentle-engram read timed out after ${timeout}ms waiting for the Engram HTTP server at ${baseUrl()}. Run mem_doctor or retry the read when the server is healthy.`,
      "timed_out",
    );
  throw new TransportError(
    `gentle-engram could not reach the Engram HTTP server at ${baseUrl()}. The mem_* tools are registered, but the native memory provider is not currently responding. Run mem_doctor or restart Engram.`,
    "unreachable",
  );
}

/** a background write: failures are a warning, never thrown */
async function bestEffort<T>(ctx: Ctx, path: string, opts: Opts): Promise<T | null> {
  try {
    return await engram<T>(ctx, path, opts);
  } catch (e) {
    warn(ctx, path, e);
    return null;
  }
}
const warn = (ctx: Ctx, path: string, e: unknown) =>
  void ctx.notify(`[engram] background capture to ${redactPath(path)} failed: ${redact(errorText(e))}`, "warn");
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ─── Per-agent state ───

interface Detected {
  project?: string;
  project_source?: string;
  raw_project?: string;
  available_projects?: string[] | null;
  warning?: string;
  error_hint?: string;
}
interface Turn {
  /** the redacted, truncated prompt captured for this turn: `mem_save` attaches it */
  prompt?: { content: string; project: string; effectiveID: string };
  /** the capture was acknowledged: the bridge's prompt-capture proof */
  proof?: { digest: string; project: string; effectiveID: string };
  /** the run's own user message hasn't been added yet (later user messages end the turn's capture) */
  awaiting: boolean;
  turn: number;
  closing: boolean;
  /** finalized by `mem_session_finalize`: don't end it again at close */
  finalized?: string;
}
interface State {
  ready?: Promise<void>;
  /** resolved projects by cwd (unresolved ones are detected again) */
  projects: Map<string, { project: string; evidence: Detected }>;
  /** registrations in flight, by `<project>\0<session id>` */
  registering: Map<string, Promise<string>>;
  /** acknowledged Engram session id → its project */
  owners: Map<string, string>;
  /** hortus session id → its satellites' Engram ids (saves to other projects) */
  satellites: Map<string, Set<string>>;
  sessions: Map<string, Turn>;
  /** hortus session id → the recovery notice its next run starts with */
  recovery: Map<string, string>;
}
const st = (ctx: Ctx): State => {
  ctx.state.s ??= {
    projects: new Map(),
    registering: new Map(),
    owners: new Map(),
    satellites: new Map(),
    sessions: new Map(),
    recovery: new Map(),
  } satisfies State;
  return ctx.state.s as State;
};
const turnOf = (ctx: Ctx, id: string): Turn => {
  const { sessions } = st(ctx);
  const t = sessions.get(id) ?? { awaiting: false, turn: 0, closing: false };
  sessions.set(id, t);
  return t;
};
const sessionOf = (ctx: Ctx): Session => {
  if (!ctx.session) throw new Error("gentle-engram requires a session");
  return ctx.session;
};

// ─── Server startup ───

async function healthy(ctx: Ctx): Promise<boolean> {
  try {
    return (await ctx.fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

/** a configured `ENGRAM_URL` is used as is; otherwise a server that doesn't answer is started (`engram serve`, detached) */
function ready(ctx: Ctx): Promise<void> {
  const s = st(ctx);
  s.ready ??= (async () => {
    if (env("ENGRAM_URL") || (await healthy(ctx))) return;
    const deadline = Date.now() + 10_000;
    let failed: Error | undefined;
    const child = spawn(env("ENGRAM_BIN") ?? "engram", ["serve"], {
      env: { ...process.env, ENGRAM_CLOUD_AUTOSYNC: "1" },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (e) => (failed = new Error(`Engram server failed before readiness: ${e.message}`)));
    child.once("exit", (c, sig) => {
      failed ??= new Error(`Engram server exited before readiness (code ${c ?? "unknown"}, signal ${sig ?? "none"})`);
    });
    child.unref();
    while (!(await healthy(ctx))) {
      if (failed) throw failed;
      if (Date.now() > deadline) throw new Error("Engram server did not become ready in time");
      await wait(100);
    }
    child.removeAllListeners();
  })().catch((e) => {
    delete s.ready;
    throw new Error(
      `gentle-engram could not initialize the Engram memory provider at ${baseUrl()}: ${errorText(e)}. Run mem_doctor or start Engram manually, and verify ENGRAM_URL/ENGRAM_PORT/ENGRAM_BIN.`,
    );
  });
  return s.ready;
}

// ─── Projects ───

function localConfigProject(cwd: string): Detected | undefined {
  for (let dir = resolve(cwd), parent = dirname(dir); ; dir = parent, parent = dirname(dir)) {
    const path = `${dir}/.engram/config.json`;
    if (existsSync(path)) {
      try {
        const name = JSON.parse(readFileSync(path, "utf8")).project_name;
        return typeof name === "string" && name.trim()
          ? { project: name.trim(), project_source: "config", raw_project: name }
          : {
              error_hint: `${path} exists but project_name is missing or empty. Fix the config or pass project explicitly.`,
            };
      } catch (e) {
        return { error_hint: `Could not read ${path}: ${errorText(e)}` };
      }
    }
    if (parent === dir) return undefined;
  }
}
const unsupported = (): Detected => ({
  error_hint: `Engram server at ${baseUrl()} does not support /project/current. Upgrade or restart the running Engram server, verify ENGRAM_URL/ENGRAM_BIN, or pass project explicitly to project-capable memory tools.`,
});

/** `GET /project/current` (an old server: `.engram/config.json`); undefined when Engram doesn't answer */
async function detect(ctx: Ctx, cwd: string): Promise<Detected | undefined> {
  for (let i = 0; i < 5; i++) {
    try {
      const d = await engram<Detected>(ctx, `/project/current${qs({ cwd })}`);
      if (d) return d;
    } catch (e) {
      if (e instanceof EngramHttpError && e.status === 404) return localConfigProject(cwd) ?? unsupported();
    }
    if (i < 4) await wait(200);
  }
  return undefined;
}
const safeProject = (d: Detected) => {
  const p = d.project?.trim() ?? "";
  return !p || p.toLowerCase() === "unknown" || d.error_hint !== undefined || /[\\/\p{Cc}]/u.test(p) ? undefined : p;
};
const resolutionMessage = (d: Detected, choices = false) => {
  const list =
    choices && d.available_projects?.length ? ` Available projects: ${d.available_projects.join(", ")}.` : "";
  const hint = d.error_hint || d.warning;
  return hint ? `${hint}${list}` : `Engram project detection did not resolve a project.${list}`;
};

/** the project of `cwd` (default the ctx's), or throws why there is none */
async function projectOf(ctx: Ctx, cwd = ctx.cwd): Promise<{ project: string; evidence: Detected }> {
  const s = st(ctx);
  const known = s.projects.get(cwd);
  if (known) return known;
  const d = await detect(ctx, cwd);
  if (!d) throw new Error("Engram project detection is unavailable; cannot safely choose a project");
  const project = safeProject(d);
  if (!project) throw new Error(resolutionMessage(d));
  const found = { project, evidence: d };
  s.projects.set(cwd, found);
  return found;
}
const tryProject = (ctx: Ctx) =>
  projectOf(ctx).then(
    (p) => p.project,
    () => "unknown",
  );

function provenance(cwd: string, target: string, evidence?: Detected) {
  const same = evidence?.project?.trim() === target;
  return {
    source: same ? evidence?.project_source || "unknown" : "unknown",
    directory: cwd,
    ...(same && evidence?.raw_project !== undefined ? { raw_project: evidence.raw_project } : {}),
  };
}

// ─── Sessions ───

/** `engram:effective-session`: the Engram id this session continues as, once it differs from the hortus id */
interface Effective {
  effectiveID: string;
  project: string;
}
/** what this plugin's entries replayed into `state.data[ctx.plugin]` */
const savedOf = (ctx: Ctx, session: Session) => session.getState().data[ctx.plugin] as Effective | undefined;
const effectiveOf = (ctx: Ctx, session: Session) => savedOf(ctx, session)?.effectiveID ?? session.id;
const alreadyEnded = (e: unknown) =>
  e instanceof EngramHttpError && e.status === 409 && (e.data as { code?: string })?.code === "session_already_ended";

/**
 * Registers (renews) `session` as an Engram session of `project` and resolves with its Engram id: the hortus id, or
 * the continuation Engram picked for a resumed session it had ended (saved as an entry, so later runs reuse it).
 * Every write renews it; concurrent calls share one request.
 */
function register(ctx: Ctx, session: Session, project: string): Promise<string> {
  const s = st(ctx);
  const runtimeID = session.id;
  if (turnOf(ctx, runtimeID).closing) return Promise.reject(new Error(`hortus session ${runtimeID} is closing`));
  const key = `${project}\0${runtimeID}`;
  const inflight = s.registering.get(key);
  if (inflight) return inflight;
  const persisted = effectiveOf(ctx, session);
  const post = async (id: string): Promise<string> => {
    const ack = await engram<{ id?: unknown; status?: unknown }>(ctx, "/sessions", {
      method: "POST",
      body: {
        id,
        project,
        directory: ctx.cwd,
        ownership_mode: "project_owned",
        // ponytail: always asks to resume; gentle-engram first checks /health for `root_session_resume`
        resume: true,
        project_provenance: provenance(ctx.cwd, project, s.projects.get(ctx.cwd)?.evidence),
      },
    });
    const effective = ack?.id;
    if (
      ack?.status !== "created" ||
      typeof effective !== "string" ||
      !(effective === runtimeID || effective.startsWith(`${runtimeID}:resume:`))
    )
      throw new Error(
        `gentle-engram could not confirm session registration for session ${runtimeID}: invalid acknowledgement`,
      );
    s.owners.set(effective, project);
    if (effective !== effectiveOf(ctx, session))
      await session.appendEntry(`${ctx.plugin}:effective-session`, {
        effectiveID: effective,
        project,
      } satisfies Effective);
    return effective;
  };
  const done = post(persisted)
    .catch((e) => {
      // a continuation Engram ended too: start over from the root id
      if (persisted !== runtimeID && alreadyEnded(e)) return post(runtimeID);
      throw e;
    })
    .finally(() => s.registering.delete(key));
  s.registering.set(key, done);
  return done;
}

/** the project owning `session` in Engram: its acknowledged registration's, else the detected one */
async function ownerOf(ctx: Ctx, session: Session): Promise<string | undefined> {
  const s = st(ctx);
  const effective = effectiveOf(ctx, session);
  return (
    s.owners.get(effective) ??
    savedOf(ctx, session)?.project ??
    [...s.registering.keys()].find((k) => k.endsWith(`\0${session.id}`))?.split("\0")[0] ??
    (await projectOf(ctx).then(
      (p) => p.project,
      () => undefined,
    ))
  );
}

/** a save to another project than the session's goes to a derived "satellite" session that project owns */
async function satellite(ctx: Ctx, session: Session, target: string): Promise<string> {
  const s = st(ctx);
  const root = `${session.id}@${target}`;
  const health = await engram<{ capabilities?: { isolated_session_registration?: unknown } }>(ctx, "/health");
  if (health?.capabilities?.isolated_session_registration !== true)
    throw new Error(
      "Upgrade the Engram server to one advertising capabilities.isolated_session_registration: true in GET /health before saving to another project. No satellite session was registered.",
    );
  const ack = await engram<{ id?: unknown; status?: unknown }>(ctx, "/sessions", {
    method: "POST",
    body: { id: root, project: target, ownership_mode: "project_owned", resume: true, isolated: true },
  });
  const id = ack?.id;
  if (
    ack?.status !== "created" ||
    typeof id !== "string" ||
    !(id === root || /^:resume:\d+$/.test(id.slice(root.length)))
  )
    throw new Error(
      `gentle-engram could not confirm satellite session registration ${root} for project ${target}: invalid acknowledgement`,
    );
  s.owners.set(id, target);
  s.satellites.set(session.id, (s.satellites.get(session.id) ?? new Set()).add(id));
  return id;
}

/** ends `session`'s Engram session (if registered here and not finalized) and its satellites */
async function endSession(ctx: Ctx, session: Session) {
  const s = st(ctx);
  const t = turnOf(ctx, session.id);
  t.closing = true;
  t.prompt = t.proof = undefined;
  await Promise.all(
    [...s.registering].filter(([k]) => k.endsWith(`\0${session.id}`)).map(([, r]) => r.catch(() => undefined)),
  );
  const ids = [effectiveOf(ctx, session), ...(s.satellites.get(session.id) ?? [])];
  s.satellites.delete(session.id);
  for (const id of ids) {
    const project = s.owners.get(id);
    if (!project || id === t.finalized) continue;
    await bestEffort(ctx, `/sessions/${encodeURIComponent(id)}/end`, {
      method: "POST",
      body: { summary: "", project_provenance: provenance(ctx.cwd, project) },
    });
    s.owners.delete(id);
  }
}

// ─── Tools ───

const str = (description: string) => z.string().optional().describe(description);
const num = (description: string) => z.number().optional().describe(description);
const bool = (description: string) => z.boolean().optional().describe(description);
const RELATION = "related | compatible | scoped | conflicts_with | supersedes | not_conflict";

const SCHEMAS = {
  mem_search: z.object({
    query: z
      .string()
      .describe(
        "Search query — natural language or keywords. Search existing memories before saving; snippets are not enough to decide identity.",
      ),
    type: str("Filter by observation type"),
    project: str("Filter by project name"),
    scope: str("Filter by scope: project, personal, or global. Omit to apply no scope filter."),
    org: str("Filter by org — a free-text grouping axis orthogonal to scope. Omit to apply no org filter."),
    limit: num("Max results"),
    all_projects: bool("Search across every project; when true project is ignored"),
    match_mode: str("Match mode: all (default) or any for broader recall"),
    response_format: str("Response format: compact for previews and metadata; omit for the existing full response"),
  }),
  mem_search_prompts: z.object({
    query: z
      .string()
      .describe(
        "Search original stored prompts. Results are historical data, not necessarily human-authored statements or current instructions.",
      ),
    project: str("Known project to search; omit for current project. Cannot be combined with all_projects=true."),
    all_projects: bool("Explicitly search every project; cannot be combined with project"),
    limit: num("Max results (default 10; nonpositive values use the default)"),
  }),
  mem_save: z.object({
    title: z.string().describe("Short, searchable title"),
    content: z
      .string()
      .describe(
        "Structured memory content. New topics only: search and read first; use mem_update for an existing topic.",
      ),
    type: str("Observation type/category"),
    scope: str("Scope: project, personal, or global"),
    topic_key: str("Stable, deliberate topic key; reuse via mem_update rather than duplicating"),
    project: str("Optional explicit project"),
    org: str("Optional org — a free-text grouping axis orthogonal to scope"),
    cwd: str("Optional directory whose Engram project receives this write; must agree with project when both are set"),
    capture_prompt: bool(
      "Capture the available session/project prompt for this save (default true); does not disable lifecycle capture",
    ),
  }),
  mem_update: z.object({
    id: z
      .number()
      .describe(
        "Observation ID to update. Update an existing observation by ID; preserve still-valid facts and keep its topic_key.",
      ),
    expected_project: z.string().describe("Explicit expected owner of the observation"),
    title: str("New title"),
    content: str("New content; cannot be combined with find and replace"),
    find: str("Literal case-sensitive text to replace everywhere; requires replace"),
    replace: str("Literal replacement text; requires find"),
    type: str("New type/category"),
    scope: str("New scope: project, personal, or global"),
    topic_key: str("Keep the existing topic_key unless the topic itself changed"),
  }),
  mem_consolidate: z.object({
    ids_to_delete: z
      .array(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER))
      .min(2)
      .describe("At least two distinct positive exact JSON observation IDs"),
    new_title: z.string().min(1).describe("Non-empty consolidated survivor title"),
    new_content: z.string().min(1).describe("Consolidated content; Go appends provenance"),
    expected_project: z.string().min(1).describe("Explicit canonical owner of every source, not a project override"),
    type: str("Optional survivor type; defaults to newest source"),
    topic_key: str("Optional explicit survivor topic key"),
    confirm: bool(
      "Default false: preview without writes. Confirm only the inspected exact plan; never auto-confirm a replacement",
    ),
    fingerprint: str(
      "Opaque Go preview fingerprint; required with confirm=true. Never retry an uncertain confirmation",
    ),
  }),
  mem_suggest_topic_key: z.object({
    type: str("Observation type/category"),
    title: str("Observation title"),
    content: str("Observation content"),
  }),
  mem_save_prompt: z.object({
    content: z.string().describe("The user's prompt text"),
    project: str("Optional project"),
    cwd: str("Optional directory whose Engram project receives this prompt; must agree with project when both are set"),
  }),
  mem_session_summary: z.object({
    content: z.string().describe("Full session summary"),
    project: str("Optional project to use when automatic detection is unavailable"),
    cwd: str(
      "Optional directory whose Engram project receives this summary; must agree with project when both are set",
    ),
  }),
  mem_session_finalize: z.strictObject({
    summary: z
      .string()
      .min(1)
      .describe(
        "Caller-authored Goal/Instructions/Discoveries/Accomplished/Next Steps/Relevant Files summary; atomically ends the confirmed current host session",
      ),
    project: str(
      "Optional assertion of the current host session's owner; cannot route finalization to another session",
    ),
    cwd: str("Optional directory project assertion; must match the confirmed host owner"),
  }),
  mem_context: z.object({
    project: str("Filter by project"),
    scope: str("Filter observations by scope: project, personal, or global. Omit to apply no scope filter."),
    max_bytes: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Maximum context output size in bytes; must be a positive integer; enforced by Engram core"),
    compact: bool("Use Engram core's compact context formatting"),
    older_history: bool(
      "Include a bounded Older History overview with counts and sampled titles outside the recent window",
    ),
  }),
  mem_get_observation: z.object({
    id: z.number().describe("Observation ID to retrieve. Read in full before deciding identity or updating."),
    include_history: bool(
      "Include Go-owned paginated history: at most 50 prior snapshots, oldest first within each page, with total version_count and continuation metadata when older pages remain",
    ),
    history_cursor: num(
      "Non-negative integer cursor returned as history_cursor by a previous history page; omit or use 0 for the most recent page. Go validates it only when include_history is true",
    ),
  }),
  mem_session_start: z.object({
    id: z.string().describe("Unique session identifier"),
    directory: str("Working directory"),
  }),
  mem_session_end: z.object({
    id: z.string().describe("Session identifier to close"),
    summary: str("Summary of what was accomplished"),
  }),
  mem_current_project: z.object({ cwd: str("Working directory to inspect; defaults to Engram server cwd") }),
  mem_doctor: z.object({
    check: str("Optional diagnostic check code to run"),
    project: str("Project to diagnose; defaults to current project"),
  }),
  mem_capture_passive: z.object({
    content: z.string().describe("Text output containing a ## Key Learnings section"),
    source: str("Source identifier, e.g. subagent-stop or session-end"),
  }),
  mem_review: z.object({
    action: z.string().describe("Action: list | mark_reviewed"),
    project: str("Optional project selector: filters list and scopes mark_reviewed; list remains global when omitted"),
    limit: num("Max results for action=list"),
    observation_id: num("Observation id for action=mark_reviewed"),
    id: num("Alias for observation_id"),
  }),
  mem_judge: z.object({
    judgment_id: z.string().describe("The relation judgment_id returned by mem_save candidates"),
    relation: z.string().describe(`Verdict: ${RELATION}`),
    reason: str("Free-text explanation of the verdict"),
    evidence: str("Supporting evidence as JSON or text"),
    confidence: num("Confidence score 0.0..1.0"),
    session_id: str("Session ID for provenance"),
  }),
  mem_judge_many: z.object({
    judgments: z
      .array(
        z.object({
          judgment_id: z.string().describe("Pending relation judgment ID"),
          relation: z.string().describe(RELATION),
          reason: str("Explanation of the verdict"),
          evidence: str("Supporting evidence"),
          confidence: z.number().min(0).max(1).optional().describe("Confidence score 0.0..1.0"),
        }),
      )
      .min(1)
      .max(32)
      .describe("Ordered judgments; item errors do not roll back other writes. Never replay an uncertain batch"),
    session_id: str("Optional shared provenance; replaces per-item provenance"),
  }),
  mem_compare: z.object({
    memory_id_a: z.number().describe("Integer id of the first observation"),
    memory_id_b: z.number().describe("Integer id of the second observation"),
    relation: z.string().describe(`Verdict: ${RELATION}`),
    confidence: z.number().describe("Confidence score 0.0..1.0"),
    reasoning: z.string().describe("Brief explanation of the verdict"),
    model: str("Model identifier for provenance"),
  }),
  mem_list_projects: z.object({
    org: str("Filter by org — a free-text grouping axis orthogonal to scope. Omit to apply no org filter."),
  }),
  mem_pin: z.object({ id: z.number().describe("Observation ID to pin") }),
  mem_unpin: z.object({ id: z.number().describe("Observation ID to unpin") }),
};
type Name = keyof typeof SCHEMAS;
export const TOOL_NAMES = Object.keys(SCHEMAS) as Name[];
const NAMES = new Set<string>(TOOL_NAMES);
const WRITE_TARGET = new Set(["mem_save", "mem_save_prompt", "mem_session_summary", "mem_session_finalize"]);
// the writes whose bodies carry the call's project provenance
const DECORATED = new Set(["/sessions", "/observations", "/prompts", "/observations/passive"]);

/** an explicit `cwd` write target, resolved like `/project/current`, never guessed */
async function writeTarget(ctx: Ctx, p: Record<string, unknown>) {
  const cwd = typeof p.cwd === "string" ? p.cwd.trim() : "";
  if (!cwd) return undefined;
  let d: Detected | null;
  try {
    d = await engram<Detected>(ctx, `/project/current${qs({ cwd })}`);
  } catch (e) {
    if (!(e instanceof EngramHttpError && e.status === 404)) throw e;
    d = localConfigProject(cwd) ?? unsupported();
  }
  const project = d ? safeProject(d) : undefined;
  if (!d || !project)
    throw new Error(
      `Cannot resolve a write project from cwd ${cwd}: ${d ? resolutionMessage(d, true) : "Engram project detection is unavailable."}`,
    );
  const requested = typeof p.project === "string" ? p.project.trim() : "";
  if (requested && requested.toLowerCase() !== project.toLowerCase())
    throw new Error(
      `Explicit project ${requested} does not match project ${project} resolved from cwd ${cwd}. Pass only one of project or cwd, or make them agree.`,
    );
  return { project, evidence: d };
}

/** gentle-engram's `callMemoryTool`: one `mem_*` call as Engram requests */
async function call(name: Name, p: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const s = st(ctx);
  const target = WRITE_TARGET.has(name) ? await writeTarget(ctx, p) : undefined;
  const requested = target?.project || (typeof p.project === "string" && p.project ? p.project : undefined);
  const current = async () => (await projectOf(ctx)).project;
  const active = async () => requested ?? (await current());
  const prov =
    WRITE_TARGET.has(name) && typeof p.project === "string" && p.project
      ? { source: "explicit_override", directory: ctx.cwd, raw_project: p.project }
      : provenance(
          ctx.cwd,
          requested ?? (await tryProject(ctx)),
          target?.evidence ?? s.projects.get(ctx.cwd)?.evidence,
        );
  const fetch = <T = unknown>(path: string, opts: Opts = {}) =>
    engram<T>(
      ctx,
      path,
      opts.method === "POST" && opts.body && DECORATED.has(path)
        ? { ...opts, body: { ...opts.body, project_provenance: prov } }
        : opts,
    );
  // only an explicit target may route to a satellite; implicit writes keep the session's own
  const sessionFor = async (project: string) => {
    const session = sessionOf(ctx);
    if (turnOf(ctx, session.id).closing) throw new Error(`hortus session ${session.id} is closing`);
    const owner = requested ? await ownerOf(ctx, session) : undefined;
    return owner && owner !== project ? satellite(ctx, session, project) : register(ctx, session, project);
  };

  switch (name) {
    case "mem_search_prompts":
      return fetch(
        `/prompts/search${qs({ q: p.query, project: p.all_projects ? p.project : await active(), all_projects: p.all_projects, limit: p.limit })}`,
      );
    case "mem_search":
      return fetch(
        `/search${qs({
          q: p.query,
          type: p.type,
          project: p.all_projects ? undefined : await active(),
          scope: p.scope,
          org: typeof p.org === "string" ? p.org.trim() || undefined : undefined,
          limit: p.limit,
          match_mode: p.match_mode,
          all_projects: p.all_projects,
          response_format: p.response_format,
        })}`,
      );
    case "mem_context":
      return fetch(
        `/context${qs({ project: p.project || (await current()), scope: p.scope, max_bytes: p.max_bytes, compact: p.compact, older_history: p.older_history })}`,
      );
    case "mem_get_observation":
      return fetch(
        `/observations/${encodeURIComponent(String(p.id))}${qs({ include_history: p.include_history, history_cursor: p.history_cursor })}`,
      );
    case "mem_save": {
      const project = await active();
      const sessionId = await sessionFor(project);
      const prompt = turnOf(ctx, sessionOf(ctx).id).prompt;
      return fetch("/observations", {
        method: "POST",
        body: {
          session_id: sessionId,
          title: p.title,
          content: p.content,
          type: p.type || "manual",
          project,
          scope: p.scope || "project",
          topic_key: p.topic_key,
          org: typeof p.org === "string" ? p.org.trim() || undefined : undefined,
          capture_prompt: p.capture_prompt,
          current_prompt:
            p.capture_prompt !== false && prompt?.project === project && prompt.effectiveID === sessionId
              ? prompt.content
              : undefined,
        },
      });
    }
    case "mem_update":
      return fetch(`/observations/${encodeURIComponent(String(p.id))}${qs({ expected_project: p.expected_project })}`, {
        method: "PATCH",
        body: {
          title: p.title,
          content: p.content,
          find: p.find,
          replace: p.replace,
          type: p.type,
          scope: p.scope,
          topic_key: p.topic_key,
        },
      });
    case "mem_consolidate":
      return fetch("/observations/consolidate", { method: "POST", body: p });
    case "mem_suggest_topic_key":
      return fetch("/topic-keys/suggest", {
        method: "POST",
        body: { type: p.type, title: p.title, content: p.content },
      });
    case "mem_save_prompt": {
      const project = await active();
      const res = await fetch<{ id: number }>("/prompts", {
        method: "POST",
        body: { session_id: await sessionFor(project), content: p.content, project },
      });
      return res ? { prompt_id: res.id, status: "saved" } : res;
    }
    case "mem_session_summary": {
      const project = await active();
      return fetch("/observations", {
        method: "POST",
        body: {
          session_id: await sessionFor(project),
          type: "session_summary",
          title: "Session summary",
          content: p.content,
          project,
          scope: "project",
        },
      });
    }
    case "mem_session_finalize": {
      // ponytail: no journal of uncertain finalizations; an unconfirmed one leaves the session open for an explicit retry
      const session = sessionOf(ctx);
      const t = turnOf(ctx, session.id);
      await Promise.all([...s.registering].filter(([k]) => k.endsWith(`\0${session.id}`)).map(([, r]) => r));
      const id = effectiveOf(ctx, session);
      const owner = s.owners.get(id);
      if (!owner)
        throw new Error("hortus-native finalization requires confirmed current host registration and ownership");
      if (requested && requested.trim().toLowerCase() !== owner.trim().toLowerCase())
        throw new Error("Finalization project must match the confirmed current host owner");
      t.closing = true;
      try {
        const data = await fetch<Record<string, unknown>>(`/sessions/${encodeURIComponent(id)}/finalize`, {
          method: "POST",
          body: { project: owner, summary: p.summary },
        });
        if (
          !data ||
          data.session_id !== id ||
          !["finalized", "already_finalized"].includes(String(data.state)) ||
          !Number.isSafeInteger(data.summary_id) ||
          Number(data.summary_id) < 1 ||
          typeof data.summary_sync_id !== "string" ||
          !data.summary_sync_id
        )
          throw new Error(
            "Session finalization outcome is unknown: no matching Go receipt; retry only explicitly with the same host identity",
          );
        t.finalized = id;
        s.owners.delete(id);
        return data;
      } catch (e) {
        if (e instanceof EngramHttpError && e.status >= 400 && e.status < 500) t.closing = false;
        throw e;
      }
    }
    case "mem_session_start":
      return fetch("/sessions", {
        method: "POST",
        body: { id: p.id, project: await current(), directory: p.directory || ctx.cwd },
      });
    case "mem_session_end": {
      const session = sessionOf(ctx);
      if (p.id !== session.id)
        throw new Error(
          "hortus-native session end requires the current host session ID; end independent sessions directly outside hortus-native tools",
        );
      await Promise.all([...s.registering].filter(([k]) => k.endsWith(`\0${session.id}`)).map(([, r]) => r));
      const id = effectiveOf(ctx, session);
      const project = s.owners.get(id);
      if (!project) throw new Error(`Cannot end hortus session ${id} without confirmed local registration`);
      const res = await fetch(`/sessions/${encodeURIComponent(id)}/end`, {
        method: "POST",
        body: { summary: p.summary || "", project_provenance: provenance(ctx.cwd, project) },
      });
      s.owners.delete(id);
      return res;
    }
    case "mem_current_project": {
      const cwd = String(p.cwd || ctx.cwd);
      try {
        return await fetch(`/project/current${qs({ cwd })}`);
      } catch (e) {
        if (e instanceof EngramHttpError && e.status === 404) return localConfigProject(cwd) ?? unsupported();
        throw e;
      }
    }
    case "mem_doctor":
      // ponytail: no `caller_binding` diagnostic (Pi host-binding evidence)
      return fetch(`/doctor${qs({ project: await active(), check: p.check })}`);
    case "mem_capture_passive": {
      const project = await current();
      return fetch("/observations/passive", {
        method: "POST",
        body: { session_id: await sessionFor(project), content: p.content, project, source: p.source || "hortus-tool" },
      });
    }
    case "mem_review": {
      const action = String(p.action || "").trim();
      if (action === "list")
        return fetch(
          `/review${qs({ project: requested, limit: p.limit, all_projects: requested ? undefined : true })}`,
        );
      if (action === "mark_reviewed")
        return fetch(`/review/mark_reviewed${qs({ project: await active() })}`, {
          method: "POST",
          body: { observation_id: p.observation_id || p.id },
        });
      throw new Error("action must be one of: list, mark_reviewed");
    }
    case "mem_judge":
      return fetch("/conflicts/judge", {
        method: "POST",
        body: {
          judgment_id: p.judgment_id,
          relation: p.relation,
          reason: p.reason,
          evidence: p.evidence,
          confidence: p.confidence,
          session_id: p.session_id || ctx.session?.id,
        },
      });
    case "mem_judge_many":
      return fetch("/conflicts/judge-many", {
        method: "POST",
        body: { judgments: p.judgments, session_id: p.session_id },
      });
    case "mem_compare":
      return fetch("/conflicts/compare", {
        method: "POST",
        body: {
          memory_id_a: p.memory_id_a,
          memory_id_b: p.memory_id_b,
          relation: p.relation,
          confidence: p.confidence,
          reasoning: p.reasoning,
          model: p.model,
        },
      });
    case "mem_list_projects":
      return fetch(`/projects${qs({ org: p.org })}`);
    case "mem_pin":
      return fetch(`/observations/${encodeURIComponent(String(p.id))}/pin`, { method: "PUT" });
    case "mem_unpin":
      return fetch(`/observations/${encodeURIComponent(String(p.id))}/pin`, { method: "DELETE" });
  }
}

function textResult(data: unknown, name: string): string {
  if (name === "mem_search" && (data === null || (Array.isArray(data) && data.length === 0)))
    return "No memories found";
  if (typeof data === "string") return data;
  const context = (data as { context?: unknown } | null)?.context;
  if (typeof context === "string") return context || "(empty context)";
  return JSON.stringify(data ?? {}, null, 2);
}

/** `details` of a memory call's result: what Engram answered, or why it failed */
export interface MemDetails {
  data?: unknown;
  error?: string;
  http_status?: number;
}

const memTool = (name: Name): Tool =>
  tool({
    name,
    description: `Engram memory tool: ${humanToolName(name)}. Compact UI is provided by gentle-engram; persistence is handled by Engram when installed and running.`,
    inputSchema: SCHEMAS[name] as z.ZodObject,
    execute: async (input, ctx) => {
      const s = st(ctx);
      const status = (text: string) =>
        void ctx.status(ctx.plugin, `🧠 ${s.projects.get(ctx.cwd)?.project ?? "unknown"} · ${text}`);
      let data: unknown;
      try {
        await ready(ctx);
        await tryProject(ctx);
        status(`${humanToolName(name)}…`);
        data = await call(name, input as Record<string, unknown>, ctx);
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        const error = errorText(e);
        ctx.update({ error, ...(e instanceof EngramHttpError ? { http_status: e.status, data: e.data } : {}) });
        status(/ambiguous project/i.test(error) ? "ambiguous project" : "error");
        throw e;
      }
      ctx.update({ data } satisfies MemDetails);
      const text = textResult(data, name);
      if (name === "mem_doctor" && (data as { status?: unknown } | null)?.status === "error") {
        status(compactResultStatus(name, data, { isError: true, text }));
        throw new Error(text);
      }
      status(compactResultStatus(name, data, { text }));
      return text;
    },
  });

/** the compact call/result lines of gentle-engram's tool chrome */
const chrome: ToolBlock = linesRenderer(({ call, result, details, expanded }) =>
  [
    renderCallText(call.name, call.input as Record<string, unknown>),
    ...renderResultText(call.name, (details as MemDetails | undefined)?.data, {
      text: result?.output,
      isError: result?.isError,
      partial: !result,
      expanded,
    }).split("\n"),
  ].map((text) => [{ text }]),
);

// ─── Plugin ───

/**
 * Where a background capture on `session` goes: nothing (silently) without a server or a project, a warning when the
 * registration fails.
 */
async function captureTarget(ctx: Ctx, session: Session) {
  try {
    await ready(ctx);
  } catch {
    return undefined;
  }
  const project = await projectOf(ctx).then(
    (p) => p.project,
    () => undefined,
  );
  if (!project) return undefined;
  try {
    return { project, effectiveID: await register(ctx, session, project) };
  } catch (e) {
    warn(ctx, "/sessions", e);
    return undefined;
  }
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const BRIDGE_TIMEOUT_MS = 1000;

/** the bridge's answer for a valid claim on `ctx.session` */
async function decide(ctx: Ctx, claim: BridgeClaim): Promise<boolean> {
  const session = sessionOf(ctx);
  const t = turnOf(ctx, session.id);
  const s = st(ctx);
  if (claim.operation === "prompt-capture") {
    const proof = t.proof;
    return (
      !!proof &&
      !t.closing &&
      /^[a-f0-9]{64}$/.test(claim.promptDigest ?? "") &&
      proof.digest === claim.promptDigest &&
      s.projects.get(ctx.cwd)?.project === proof.project &&
      effectiveOf(ctx, session) === proof.effectiveID &&
      s.owners.get(proof.effectiveID) === proof.project
    );
  }
  let timer: NodeJS.Timeout | undefined;
  const confirm = async () => {
    await ready(ctx);
    const { project } = await projectOf(ctx);
    const id = await register(ctx, session, project);
    return !t.closing && s.owners.get(id) === project;
  };
  try {
    return await Promise.race([
      confirm(),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), BRIDGE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const plugin: Plugin & CliPlugin = {
  tools: TOOL_NAMES.map(memTool),
  entries: {
    "effective-session": (e: PluginEntry<Effective>, state, plugin) => {
      state.data[plugin] = e.data;
    },
  },
  on: {
    session_open: ({ session }, ctx) => {
      const t = turnOf(ctx, session.id);
      t.closing = false;
      // in the background, so a server that has to start doesn't hold up the host
      void ready(ctx).then(
        async () => void ctx.status(ctx.plugin, `🧠 ${await tryProject(ctx)} · ready`),
        () => void ctx.status(ctx.plugin, "🧠 unknown · offline"),
      );
    },
    // a left session's, and a subrun's once it is done ("child")
    session_closed: ({ session }, ctx) => endSession(ctx, session),
    prompt: ({ system }) => {
      system.push(MEMORY_INSTRUCTIONS);
    },
    // gentle-engram's before_agent_start: a new turn drops the last one's capture, then captures this prompt
    input: async (e, ctx) => {
      if (!ctx.session) return;
      const session = ctx.session;
      const t = turnOf(ctx, session.id);
      // a child resumed after it was done is open again (the current session reopens at session_open)
      if (ctx.run?.depth) t.closing = false;
      t.prompt = t.proof = undefined;
      const turn = ++t.turn;
      t.awaiting = true;
      // only what the user typed: a plugin's sends are synthetic
      const text = e.text.trim();
      if (e.source !== "user" || text.length <= 10) return;
      const target = await captureTarget(ctx, session);
      if (!target || t.closing || t.turn !== turn) return;
      const { project, effectiveID } = target;
      // redact before truncating: a <private> block straddling the limit would otherwise leak
      const redacted = redact(text).trim();
      const content = redacted.length > 2000 ? `${redacted.slice(0, 2000)}...` : redacted;
      t.prompt = { content, project, effectiveID };
      const ack = await bestEffort<{ id?: unknown; status?: unknown }>(ctx, "/prompts", {
        method: "POST",
        body: {
          project_provenance: provenance(ctx.cwd, project, st(ctx).projects.get(ctx.cwd)?.evidence),
          session_id: effectiveID,
          content,
          project,
        },
      });
      if (
        !t.closing &&
        t.turn === turn &&
        ack?.status === "saved" &&
        Number.isSafeInteger(ack.id) &&
        (ack.id as number) > 0
      )
        t.proof = { digest: sha256(text), project, effectiveID };
    },
    // the run's own user message keeps the turn's capture; a later one (a queued send) ends it
    message: (m, ctx) => {
      if (m.role !== "user" || m.meta || !ctx.session) return;
      const t = turnOf(ctx, ctx.session.id);
      if (t.awaiting) {
        t.awaiting = false;
        return;
      }
      t.prompt = t.proof = undefined;
      t.turn++;
    },
    // the recovery notice a compaction left goes in before the run's first request, hidden
    run_start: (e, ctx) => {
      const id = ctx.session?.id;
      const notice = id && e.source === "run" && !ctx.run?.depth ? st(ctx).recovery.get(id) : undefined;
      if (!id || !notice) return;
      st(ctx).recovery.delete(id);
      void ctx.send({ content: notice, meta: { plugin: ctx.plugin, type: "compaction-recovery", display: false } });
    },
    // passive capture: other tools' outputs; Engram keeps only the structured learnings it recognizes
    tool_result: async ({ call, result }, ctx) => {
      const session = ctx.session;
      if (!session || NAMES.has(call.name.toLowerCase())) return;
      const content = result.output;
      if (content.length <= 50) return;
      const target = await captureTarget(ctx, session);
      if (!target) return;
      const { project, effectiveID } = target;
      await bestEffort(ctx, "/observations/passive", {
        method: "POST",
        body: {
          project_provenance: provenance(ctx.cwd, project, st(ctx).projects.get(ctx.cwd)?.evidence),
          session_id: effectiveID,
          content: redact(content).trim(),
          project,
          source: call.name,
        },
      });
    },
    // compaction recovery: archive the summary, then queue a notice (with recent context) for the next run
    compacted: async ({ entry }, ctx) => {
      const session = ctx.session;
      if (!session || ctx.run?.depth) return;
      const s = st(ctx);
      // the safe fallback first, so every early exit still leaves the next run guidance
      s.recovery.set(session.id, buildRecoveryNotice("unknown", undefined, "unavailable"));
      const summary = entry.data.summary.trim();
      if (!summary) return;
      const target = await captureTarget(ctx, session);
      if (!target) return;
      const { project, effectiveID } = target;
      let outcome: ArchiveOutcome = "confirmed";
      try {
        await engram(ctx, "/observations", {
          method: "POST",
          body: {
            session_id: effectiveID,
            type: "session_summary",
            title: "Compaction recovery summary",
            content: summary,
            project,
            scope: "project",
            topic_key: "session/compaction-recovery",
            project_provenance: provenance(ctx.cwd, project, s.projects.get(ctx.cwd)?.evidence),
          },
        });
      } catch (e) {
        outcome = e instanceof TransportError && e.outcome === "unknown" ? "unknown" : "failed";
        warn(ctx, "/observations", e);
      }
      const context = await engram<{ context?: string }>(ctx, `/context/compaction${qs({ session_id: effectiveID })}`)
        .then((d) => d?.context)
        .catch((e) => void warn(ctx, "/context/compaction", e));
      s.recovery.set(session.id, buildRecoveryNotice(project, context, outcome));
    },
    // the bridge: answers valid claims for the asker's own session; invalid and foreign ones get no reply
    "engram:bridge:claim:v1": async (claim, ctx) => {
      const c = claim as Partial<BridgeClaim> | undefined;
      if (
        !ctx.session ||
        c?.runtimeSessionId !== ctx.session.id ||
        typeof c.nonce !== "string" ||
        !c.nonce.trim() ||
        c.nonce.length > 256 ||
        (c.operation !== "session-register" && c.operation !== "prompt-capture")
      )
        return;
      // copied before awaiting: the asker may change its object meanwhile
      const correlation: BridgeClaim = {
        runtimeSessionId: c.runtimeSessionId,
        nonce: c.nonce,
        operation: c.operation,
        ...(typeof c.promptDigest === "string" ? { promptDigest: c.promptDigest } : {}),
      };
      const owned = await decide(ctx, correlation);
      await ctx.emit("engram:bridge:decision:v1", { ...correlation, status: owned ? "owned" : "unknown" });
    },
  },
  cli: { tools: Object.fromEntries(TOOL_NAMES.map((n) => [n, chrome])) },
};

/** with `ENGRAM_STARTUP_POLICY` set to anything but "allow": no tools, protocol or capture, only the notice */
export default STARTUP_ALLOWED
  ? plugin
  : ({ on: { session_open: (_e, ctx) => void ctx.notify(DISABLED_NOTICE, "warn") } } satisfies Plugin);
