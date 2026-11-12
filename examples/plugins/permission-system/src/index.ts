import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Ctx,
  type GatedCall,
  hortusDir,
  type Plugin,
  parseSkillMessage,
  projectDirs,
  type Skill,
  type Tool,
  stateOf,
} from "@hortus/core";
import {
  type Action,
  analyzeUnit,
  bashPaths,
  type Check,
  type Config,
  ConfigSchema,
  commandGrant,
  compose,
  type Decision,
  decide,
  evaluate,
  expandHome,
  floorAllows,
  fullyDenied,
  outside,
  parseBash,
  pathValues,
  type Rule,
  wildcard,
} from "./policy.ts";

export * from "./policy.ts";

// ── the bus (`ctx.emit`), Pi's `permissions:*` channels ──────────────────────

/** One thing a request is decided on, as the bus reports it. */
export interface CheckFacts {
  surface: string;
  value: string;
  what: string;
  action: Action;
  pattern: string;
  origin: string;
  reason?: string;
}
export type Resolution =
  | "policy_allow"
  | "policy_deny"
  | "session_approved"
  | "auto_approved"
  | "user_approved"
  | "user_approved_for_session"
  | "user_denied"
  | "prompt_unanswered"
  | "confirmation_unavailable"
  | "authorizer_allowed"
  | "authorizer_denied"
  | "gate_error";
interface Request {
  requestId: string;
  source: "tool_call" | "skill_input";
  tool?: string;
  /** the subrun's agent (`ctx.run.agent`, else its `source`), for a run below the top level */
  agent?: string;
}
export interface DecisionEvent extends Request {
  surface: string;
  value: string;
  what: string;
  result: "allow" | "deny";
  resolution: Resolution;
  origin?: string;
  pattern?: string;
  reason?: string;
}
export interface UiPromptEvent extends Request {
  question: string;
  checks: CheckFacts[];
}
/** Fired before prompting; handlers named in `authorizerChain` push a verdict under their plugin name. */
export interface AuthorizeEvent extends Request {
  input?: unknown;
  checks: CheckFacts[];
  verdicts: { name: string; verdict: "allow" | "deny" | "defer"; reason?: string }[];
}
/** A query: the handler fills `result` with what policy (and this session's approvals) says about `value`. */
export interface CheckEvent {
  surface: string;
  value?: string;
  result?: { action: Action; pattern: string; origin: string; reason?: string };
}

declare module "@hortus/core" {
  interface Events {
    "permissions:decision": DecisionEvent;
    "permissions:ui_prompt": UiPromptEvent;
    "permissions:authorize": AuthorizeEvent;
    "permissions:check": CheckEvent;
  }
}

// ── config and per-agent state ─────────────────────────────────────────────────

export const configPath = () => join(hortusDir(), "permission-system.json");

interface Loaded {
  rules: Rule[];
  config: Config;
  issues: string[];
}
interface State {
  /** each run's policy, loaded at its `run_start`, and the skills it lists */
  runs: Map<string, { loaded: Loaded; skills: readonly Skill[] }>;
  /** session approvals, by top-level session id (`ctx.run.root`: a subrun's go to its root's, as Pi's forwarded grants do) */
  grants: Map<string, Rule[]>;
  reported: Set<string>;
  status?: string;
}
const stateIn = (ctx: Ctx) =>
  stateOf(ctx, "permissions", (): State => ({ runs: new Map(), grants: new Map(), reported: new Set() }));

/** a subrun's agent name (`SubrunOptions.agent`), else who started it */
const agentOf = (ctx: Ctx) => (ctx.run && ctx.run.depth > 0 ? (ctx.run.agent ?? ctx.run.source) : undefined);
/** the top-level session, whose approvals a subrun shares */
const rootOf = (ctx: Ctx) => ctx.run?.root ?? ctx.session?.id ?? "";

async function readScope(path: string): Promise<{ config?: Config; invalid?: string; exists: boolean }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    return { exists: true, invalid: `${path}: ${(e as Error).message}` };
  }
  try {
    return { exists: true, config: ConfigSchema.parse(JSON.parse(text)) };
  } catch (e) {
    return { exists: true, invalid: `${path}: ${(e as Error).message.replace(/\s+/g, " ")}` };
  }
}

/** Global config, then the project's (only once trusted), then the subrun's `agents` entries in each; re-read every run. */
async function load(ctx: Ctx): Promise<Loaded> {
  const issues: string[] = [];
  const g = await readScope(configPath());
  if (g.invalid) issues.push(`Invalid ${g.invalid}; ignoring it (everything asks)`);
  const gc = g.config ?? {};
  const root = (await projectDirs(ctx.cwd))[0] ?? ctx.cwd;
  const projectFile = join(root, ".hortus", "permission-system.json");
  let p = await readScope(projectFile);
  const trusted =
    p.exists &&
    (gc.defaultProjectTrust ||
      gc.trustedProjects?.some((t) => resolve(expandHome(t)) === root) ||
      (await ctx.trust(root, { reason: `(${projectFile} changes which tools run unasked)` })));
  if (p.exists && !trusted) {
    issues.push(
      `${projectFile} skipped: the project isn't trusted (trust it when asked, or list ${root} in trustedProjects of ${configPath()})`,
    );
    p = { exists: false };
  }
  const pc = p.config ?? {};
  const agent = agentOf(ctx);
  const rules = compose([
    ["global", gc.permission],
    ["project", pc.permission],
    ["agent", agent ? gc.agents?.[agent]?.permission : undefined],
    ["project-agent", agent ? pc.agents?.[agent]?.permission : undefined],
  ]);
  // a project can't trust itself
  const { trustedProjects: _, defaultProjectTrust: __, ...knobs } = pc;
  const config = { ...gc, ...knobs };
  if (p.invalid) {
    issues.push(`Invalid ${p.invalid}: failing closed, 'allow' rules ask until it is fixed`);
    return { rules: floorAllows(rules), config, issues };
  }
  if (rules[0]?.action === "allow" && !rules.some((r) => r.surface === "bash"))
    issues.push(`The top-level "*": "allow" lets every bash command run unasked; set "bash" explicitly to gate it`);
  return { rules, config, issues };
}

/** The run's policy (loaded at its `run_start`), else a fresh one; reports new config issues once. */
async function policy(ctx: Ctx) {
  const state = stateIn(ctx);
  const run = ctx.run && state.runs.get(ctx.run.id);
  const loaded = run?.loaded ?? (await load(ctx));
  for (const issue of loaded.issues)
    if (!state.reported.has(issue)) {
      state.reported.add(issue);
      await ctx.notify(`permission-system: ${issue}`, "warn");
    }
  const rules = [...loaded.rules, ...(state.grants.get(rootOf(ctx)) ?? [])];
  return { loaded, rules, skills: run?.skills ?? [], yolo: !!loaded.config.yoloMode };
}

async function syncStatus(ctx: Ctx, config: Config) {
  const state = stateIn(ctx);
  const text = config.yoloMode ? "yolo" : undefined;
  if (state.status === text) return;
  state.status = text;
  await ctx.status("permission-system", text);
}

// ── what a call does ────────────────────────────────────────────────────────

/** Path accesses a plugin tool declares beyond its `effects`: `meta.accessPaths(input)`, Pi's access extractors. */
type AccessPaths = (input: unknown) => { path: string; dir?: "read" | "write" }[];

/** Every check a call is decided on: the paths it touches, a skill it reads, then the tool (or each bash command) itself. */
export function checksFor(
  call: Pick<GatedCall, "name" | "input">,
  tool: Tool | undefined,
  cwd: string,
  skills: readonly Skill[],
  config: Config,
): Check[] {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const checks: Check[] = [];
  const infra = (abs: string) =>
    skills.some((s) => abs.startsWith(dirname(s.path) + sep)) ||
    !!config.infrastructureReadPaths?.some((p) => wildcard(p, abs) || abs.startsWith(resolve(expandHome(p)) + sep));
  const access = (typed: string, abs: string | undefined, dir: "read" | "write" | undefined, via: string) => {
    const values = pathValues(typed, abs);
    const dirs = dir ? [dir] : ["read", "write"];
    const verb = dir === "read" ? "reading" : dir === "write" ? "writing" : "accessing";
    checks.push({
      surfaces: dirs.map((d) => `path_${d}`),
      values,
      what: `${verb} ${abs ?? typed}${via}`,
      grant: abs ?? typed,
      configuredOnly: true,
    });
    if (abs && outside(abs, cwd))
      checks.push({
        surfaces: dirs.map((d) => `external_directory_${d}`),
        values,
        what: `${verb} ${abs} outside the working directory${via}`,
        grant: join(dirname(abs), "*"),
        ...(dir === "read" && infra(abs) && { infrastructure: true }),
      });
  };
  const mcp = tool?.meta?.mcp as { server: string; tool: string } | undefined;
  // what the tool declares (`effects`), else guessed: bash's `command`, a `path` read by read, written by write/edit
  const effects = tool?.effects;
  const command = (effects ? (effects.exec ?? []) : call.name === "bash" ? ["command"] : [])
    .map((k) => input[k])
    .find((v): v is string => typeof v === "string");
  if (command !== undefined) {
    const { units, unparsed } = parseBash(command, cwd);
    if (unparsed || !units.length)
      checks.push({
        surfaces: ["bash"],
        values: [command],
        what: `bash command "${command}"${unparsed ? " (not fully parsed)" : ""}`,
        grant: command,
        ...(unparsed && { floor: "<unparseable-bash-command>" }),
      });
    for (const unit of units) {
      const { words, floor } = analyzeUnit(unit);
      const paths = bashPaths(unit, words);
      const absText = words.map((w) => paths.find((p) => p.path === w)?.abs ?? w).join(" ");
      const via = unit.nested ? ` (${unit.nested})` : "";
      checks.push({
        surfaces: ["bash"],
        values: [...new Set([unit.text, words.join(" "), absText])],
        what: `bash command "${words.join(" ")}"${via}`,
        grant: commandGrant(words),
        ...(floor && { floor }),
      });
      for (const p of paths) access(p.path, p.abs, p.dir, ` (by ${words[0]})`);
    }
  } else if (mcp) {
    const { server, tool: t } = mcp;
    checks.push({
      surfaces: ["mcp"],
      values: [`${server}_${t}`, `${server}:${t}`, server, t, call.name, "mcp_call"],
      what: `MCP tool ${server}:${t}`,
      grant: call.name,
    });
  } else {
    const key = effects
      ? [...(effects.writes ?? []), ...(effects.reads ?? [])].find((k) => typeof input[k] === "string")
      : "path";
    const path = key !== undefined && typeof input[key] === "string" ? input[key] : undefined;
    const abs = path === undefined ? undefined : resolve(cwd, expandHome(path));
    const dir = effects
      ? effects.writes?.includes(key ?? "")
        ? "write"
        : "read"
      : call.name === "read"
        ? "read"
        : call.name === "write" || call.name === "edit"
          ? "write"
          : undefined;
    if (dir === "read" && abs) {
      const skill = skills.find((s) => abs === s.path || abs.startsWith(dirname(s.path) + sep));
      if (skill)
        checks.push({ surfaces: ["skill"], values: [skill.name], what: `skill "${skill.name}"`, grant: skill.name });
    }
    if (path !== undefined) access(path, abs, dir, "");
    for (const p of (tool?.meta?.accessPaths as AccessPaths | undefined)?.(call.input) ?? [])
      access(p.path, resolve(cwd, expandHome(p.path)), p.dir, "");
    checks.push({
      surfaces: [call.name],
      values: path === undefined ? ["*"] : pathValues(path, abs),
      what: path === undefined ? `tool "${call.name}"` : `${call.name} ${abs}`,
      grant: abs ?? "*",
    });
  }
  return checks;
}

// ── deciding ────────────────────────────────────────────────────────────────

const ALLOW = "Allow once";
const SESSION = "Allow for this session";
const DENY = "Deny";
const ruleText = (d: Decision) => `${d.surface} "${d.rule.pattern}": ${d.rule.action} (${d.rule.origin})`;
const facts = (d: Decision): CheckFacts => ({
  surface: d.surface,
  value: d.check.values[0] ?? "*",
  what: d.check.what,
  action: d.action,
  pattern: d.rule.pattern,
  origin: d.rule.origin,
  ...(d.rule.reason && { reason: d.rule.reason }),
});

async function report(ctx: Ctx, config: Config, ev: DecisionEvent) {
  await ctx.emit("permissions:decision", ev);
  if (config.permissionReviewLog === false) return;
  const log = join(hortusDir(), "permission-system", "review.jsonl");
  await mkdir(dirname(log), { recursive: true });
  await appendFile(log, `${JSON.stringify({ time: new Date().toISOString(), session: ctx.session?.id, ...ev })}\n`, {
    mode: 0o600,
  });
}

/**
 * Decides a request: any deny blocks it at once (deny first, so nobody is asked about a call that can't run); asks go
 * to the `authorizerChain`, then to the user in one prompt. Resolves with the block message, or undefined to let it run.
 */
async function decideRequest(
  ctx: Ctx,
  req: { source: Request["source"]; tool?: string; input?: unknown; checks: Check[] },
): Promise<string | undefined> {
  const { loaded, rules, yolo } = await policy(ctx);
  const agent = agentOf(ctx);
  const base: Request = {
    requestId: randomUUID(),
    source: req.source,
    ...(req.tool && { tool: req.tool }),
    ...(agent && { agent }),
  };
  const decisions = req.checks.map((c) => decide(rules, c, yolo));
  const emit = (d: Decision, result: "allow" | "deny", resolution: Resolution, reason?: string) =>
    report(ctx, loaded.config, {
      ...base,
      surface: d.surface,
      value: d.check.values[0] ?? "*",
      what: d.check.what,
      result,
      resolution,
      origin: d.rule.origin,
      pattern: d.rule.pattern,
      ...(reason && { reason }),
    });
  const deny = decisions.find((d) => d.action === "deny");
  if (deny) {
    await emit(deny, "deny", "policy_deny", deny.rule.reason);
    return `Blocked by permission-system: ${deny.check.what} is not permitted (rule ${ruleText(deny)})${deny.rule.reason ? `. Reason: ${deny.rule.reason}` : ""}`;
  }
  const asks = decisions.filter((d) => d.action === "ask");
  const first = asks[0];
  if (!first) {
    const d = decisions.at(-1);
    if (d)
      await emit(
        d,
        "allow",
        d.rule.layer === "session" ? "session_approved" : d.rule.origin === "yolo" ? "auto_approved" : "policy_allow",
      );
    return;
  }
  const what = asks.map((d) => d.check.what).join("; ");
  const chain = loaded.config.authorizerChain ?? [];
  if (chain.length) {
    const ev: AuthorizeEvent = { ...base, input: req.input, checks: asks.map(facts), verdicts: [] };
    await ctx.emit("permissions:authorize", ev);
    for (const name of chain) {
      const v = ev.verdicts.find((x) => x.name === name);
      if (!v || v.verdict === "defer") continue;
      // a link may refuse anything, but never widen path access on its own (Pi caps its allow there)
      if (v.verdict === "allow" && asks.some((d) => /^(path|external_directory)_/.test(d.surface))) continue;
      await emit(first, v.verdict, v.verdict === "allow" ? "authorizer_allowed" : "authorizer_denied", v.reason);
      if (v.verdict === "allow") return;
      return `Blocked by permission-system: ${name} refused ${what}${v.reason ? `. Reason: ${v.reason}` : ""}`;
    }
  }
  const timeoutMs = loaded.config.promptTimeoutMs;
  const question = [
    `Allow ${req.tool ? `${req.tool}` : "this"}${agent ? ` (from subrun "${agent}")` : ""}?`,
    ...asks.map((d) => `• ${d.check.what} (rule ${ruleText(d)})`),
  ].join("\n");
  await ctx.emit("permissions:ui_prompt", { ...base, question, checks: asks.map(facts) });
  const answered = await ctx.ask(
    {
      question,
      options: [
        { label: ALLOW },
        {
          label: SESSION,
          description: asks.map((d) => `${d.surface.replace(/_(read|write)$/, "")} "${d.check.grant}"`).join(", "),
        },
        { label: DENY, description: "or type a reason to deny with" },
      ],
      allowText: true,
      data: { permissionSystem: { requestId: base.requestId, ...(timeoutMs && { timeoutMs }) } },
    },
    { detailed: true },
  );
  const { answer } = answered;
  if (answer === ALLOW || answer === SESSION) {
    if (answer === SESSION) {
      const grants = stateIn(ctx).grants;
      const list = grants.get(rootOf(ctx)) ?? [];
      for (const d of asks)
        for (const surface of d.check.surfaces)
          list.push({ surface, pattern: d.check.grant, action: "allow", origin: "session", layer: "session" });
      grants.set(rootOf(ctx), list);
    }
    await emit(first, "allow", answer === SESSION ? "user_approved_for_session" : "user_approved");
    return;
  }
  if (answer !== undefined) {
    const reason = typeof answer === "string" && answer !== DENY ? answer : undefined;
    await emit(first, "deny", "user_denied", reason);
    return `Blocked by permission-system: the user denied ${what}${reason ? `. Reason: ${reason}` : ""}`;
  }
  const unavailable = answered.reason === "unanswered";
  await emit(first, "deny", unavailable ? "confirmation_unavailable" : "prompt_unanswered", answered.reason);
  const why = unavailable
    ? "no one can approve it here (no interactive UI)"
    : answered.reason === "timeout"
      ? `nobody answered within ${(timeoutMs ?? 0) / 1000}s`
      : `the prompt was ${answered.reason}`;
  return `Blocked by permission-system: ${what} needs approval and ${why}`;
}

// ── the plugin ──────────────────────────────────────────────────────────────

/**
 * Pi's pi-permission-system: allow / ask / deny policy over tools, bash commands (each command of a chain, nested
 * substitutions too), paths (`path`, `external_directory`, read/write), MCP tools and skills. Denied tools and skills
 * are hidden in `run_start`; every call (codemode scripts' and subruns' included, through `tool_gate`) is gated, failing
 * closed on a gate error (`"required": true` keeps it in every subrun, whatever its plugin filter); skill invocations are gated in `input`. Asks go to the `authorizerChain`, then to whoever
 * answers `ctx.ask` (the TUI, an RPC client; nobody under `-p`, which denies). See README-style docs in `policy.ts`.
 */
export default {
  on: {
    ready: async (_, ctx) => syncStatus(ctx, (await policy(ctx)).loaded.config),
    run_start: async (p, ctx) => {
      if (!ctx.run) return;
      const state = stateIn(ctx);
      const loaded = await load(ctx);
      state.runs.set(ctx.run.id, { loaded, skills: [] });
      const { rules } = await policy(ctx);
      await syncStatus(ctx, loaded.config);
      // hide what can never run (Pi: only when every value on its surface is denied)
      for (let i = p.tools.length; i--; ) {
        const t = p.tools[i];
        const mcp = t?.meta?.mcp as { server: string; tool: string } | undefined;
        const denied = mcp
          ? checksFor({ name: t?.name ?? "", input: {} }, t, ctx.cwd, [], loaded.config).every(
              (c) => decide(rules, c, false).action === "deny",
            )
          : fullyDenied(rules, t?.name ?? "");
        if (denied) p.tools.splice(i, 1);
      }
      if (p.skills) p.skills = p.skills.filter((s) => evaluate(rules, "skill", [s.name]).action !== "deny");
      state.runs.set(ctx.run.id, { loaded, skills: p.skills ?? [] });
    },
    run_end: (_, ctx) => {
      if (!ctx.run) return;
      stateIn(ctx).runs.delete(ctx.run.id);
    },
    session_closed: ({ session, reason }, ctx) => {
      if (reason !== "child") stateIn(ctx).grants.delete(session.id);
    },
    // after every tool_call handler, on the input that runs; a block also beats a result a tool_call handler supplied
    tool_gate: async (p, ctx) => {
      if (p.block !== undefined) return;
      const call = p.call;
      try {
        const { loaded, skills } = await policy(ctx);
        const block = await decideRequest(ctx, {
          source: "tool_call",
          tool: call.name,
          input: call.input,
          checks: checksFor(call, p.tool, ctx.cwd, skills, loaded.config),
        });
        if (block) p.block = block;
      } catch (e) {
        // fail closed: a gate that can't decide blocks
        const message = e instanceof Error ? e.message : String(e);
        p.block = `Blocked by permission-system: the permission check failed (${message})`;
        const agent = agentOf(ctx);
        await ctx.emit("permissions:decision", {
          requestId: randomUUID(),
          source: "tool_call",
          tool: call.name,
          ...(agent && { agent }),
          surface: call.name,
          value: "*",
          what: `tool "${call.name}"`,
          result: "deny",
          resolution: "gate_error",
          reason: message,
        });
      }
    },
    input: async (p, ctx) => {
      const skill = parseSkillMessage(p.text);
      if (!skill) return;
      const block = await decideRequest(ctx, {
        source: "skill_input",
        checks: [{ surfaces: ["skill"], values: [skill.name], what: `skill "${skill.name}"`, grant: skill.name }],
      });
      if (!block) return;
      p.handled = true;
      await ctx.notify(block, "warn");
    },
    // Pi's promptTimeoutMs: once our prompt is shown, nobody answering in time denies it; a key press stops the clock
    ask: async (p, ctx) => {
      const ms = (p.data as { permissionSystem?: { timeoutMs?: number } } | undefined)?.permissionSystem?.timeoutMs;
      if (!ms || !ctx.host.interactive) return;
      const stop = new AbortController();
      const aborted = new Promise<void>((r) => p.signal.addEventListener("abort", () => r(), { once: true }));
      await Promise.race([p.shown, aborted]);
      const timedOut = await Promise.race([
        sleep(ms, true, { signal: stop.signal }).catch(() => false),
        p.engaged.then(() => false),
        aborted.then(() => false),
      ]);
      stop.abort();
      if (timedOut) p.resolve(undefined, { reason: "timeout" });
    },
    "permissions:check": async (p, ctx) => {
      const { rules, yolo } = await policy(ctx);
      const d = decide(rules, { surfaces: [p.surface], values: [p.value ?? "*"], what: "", grant: "" }, yolo);
      p.result = {
        action: d.action,
        pattern: d.rule.pattern,
        origin: d.rule.origin,
        ...(d.rule.reason && { reason: d.rule.reason }),
      };
    },
  },
  commands: [
    {
      name: "permission-system",
      description: "Show the permission policy, or turn yolo mode and the review log on or off",
      args: "[show | path | yolo on|off | log on|off]",
      complete: () => ["show", "path", "yolo on", "yolo off", "log on", "log off"].map((value) => ({ value })),
      run: async (arg, ctx) => {
        const [what = "show", value] = arg.trim().split(/\s+/);
        if (what === "path") return configPath();
        if ((what === "yolo" || what === "log") && (value === "on" || value === "off")) {
          let raw: Record<string, unknown> = {};
          try {
            raw = JSON.parse(await readFile(configPath(), "utf8"));
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          raw[what === "yolo" ? "yoloMode" : "permissionReviewLog"] = value === "on";
          ConfigSchema.parse(raw);
          await mkdir(hortusDir(), { recursive: true });
          await writeFile(configPath(), `${JSON.stringify(raw, null, 2)}\n`);
          await syncStatus(ctx, (await load(ctx)).config);
          return `${what === "yolo" ? "Yolo mode" : "The review log"} is ${value}.`;
        }
        if (what !== "show") throw new Error("Usage: /permission-system [show | path | yolo on|off | log on|off]");
        const { loaded, rules } = await policy(ctx);
        const c = loaded.config;
        return [
          `config: ${configPath()}`,
          `yolo ${c.yoloMode ? "on" : "off"}, review log ${c.permissionReviewLog === false ? "off" : "on"}${c.promptTimeoutMs ? `, prompts time out after ${c.promptTimeoutMs / 1000}s` : ""}`,
          ...rules.map(
            (r) => `${r.surface} "${r.pattern}": ${r.action} (${r.origin})${r.reason ? ` — ${r.reason}` : ""}`,
          ),
        ].join("\n");
      },
    },
  ],
} satisfies Plugin;
