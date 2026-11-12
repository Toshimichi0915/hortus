import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Ctx,
  hortusDir,
  type Plugin,
  type PluginEntry,
  type Session,
  type Skill,
  type Tool,
  tool,
} from "@hortus/core";
import { z } from "zod";

/** Always declared, never deferred, demoted or blocked: the model's way to everything else. */
const SPINE = "search_tools";
const SEARCH_CAP = 20;

const ConfigSchema = z.object({
  /** false: every tool declared, every skill listed, nothing blocked */
  enabled: z.boolean().default(true),
  /** defer every tool not pinned (`alwaysActive`) or guarded (`neverDefer`) */
  deferByDefault: z.boolean().default(true),
  /** list only `activeSkills` in the prompt; `search_tools` loads the others */
  deferSkills: z.boolean().default(true),
  /** byte-identical AGENTS.md files appear once */
  deduplicateContext: z.boolean().default(true),
  /** "session" keeps promotions across runs */
  promotionLifetime: z.enum(["run", "session"]).default("run"),
  maxSearchResults: z.int().min(1).max(SEARCH_CAP).default(3),
  maxSkillBytes: z.int().min(1).default(65536),
  /** pinned: always declared */
  alwaysActive: z.array(z.string()).default([]),
  /** never deferred, and `demote_tools` refuses them */
  neverDefer: z.array(z.string()).default([]),
  deferredNames: z.array(z.string()).default([]),
  deferredPrefixes: z.array(z.string()).default(["mcp_"]),
  /** hard deny: never declared, searched or run */
  blockedTools: z.array(z.string()).default([]),
  blockedPrefixes: z.array(z.string()).default([]),
  activeSkills: z.array(z.string()).default([]),
  /** these tools are declared first, and the prompt says this order wins */
  toolPriority: z.array(z.string()).default([]),
});
type Config = z.infer<typeof ConfigSchema>;

/** `~/.hortus/deferred-tools.json`, re-read every run (no `/deferred reload` needed); missing = defaults. */
async function loadConfig(): Promise<Config> {
  const path = join(hortusDir(), "deferred-tools.json");
  let text = "{}";
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    return ConfigSchema.parse(JSON.parse(text));
  } catch (e) {
    throw new Error(`Invalid ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * What lasts for a session: promotions (when `promotionLifetime` is "session"), demotions and what `/deferred unblock`
 * unblocked. Kept as `deferred-context:state` entries, so it is per branch and resuming restores it.
 */
interface Kept {
  promoted: Set<string>;
  demoted: Set<string>;
  unblocked: Set<string>;
}
type Saved = Record<keyof Kept, string[]>;
const KEY = "deferred-context";

/** `session`'s kept state, as its last entry left it (a fresh copy). */
function kept(session?: Session): Kept {
  const d = session?.getState().data[KEY] as Saved | undefined;
  return { promoted: new Set(d?.promoted), demoted: new Set(d?.demoted), unblocked: new Set(d?.unblocked) };
}

/** Saves `k` to `session`, unless that is what it has already. */
async function keep(session: Session | undefined, k: Kept) {
  const data: Saved = { promoted: [...k.promoted], demoted: [...k.demoted], unblocked: [...k.unblocked] };
  if (
    session &&
    JSON.stringify(data) !==
      JSON.stringify(session.getState().data[KEY] ?? { promoted: [], demoted: [], unblocked: [] })
  )
    await session.appendEntry(`${KEY}:state`, data);
}

/** One run's view: every skill (before the prompt list was cut), its promotions, and what its last request declared. */
interface RunState {
  skills: Skill[];
  promoted: Set<string>;
  declared: Set<string>;
  /** its session's, as of its start, then as its tools change it */
  kept: Kept;
}

// undefined until a run loaded it, or when it was invalid: then nothing is deferred or blocked
let config: Config | undefined;
const runs = new Map<string, RunState>();

const startsWithAny = (name: string, prefixes: string[]) => prefixes.some((p) => p && name.startsWith(p));

/** blocked by `c`, whatever this session unblocked */
const configBlocked = (name: string, c = config) =>
  !!c?.enabled && name !== SPINE && (c.blockedTools.includes(name) || startsWithAny(name, c.blockedPrefixes));
const isBlocked = (name: string, k: Kept, c = config) => configBlocked(name, c) && !k.unblocked.has(name);

function isDeferred(name: string, promoted: Set<string>, k: Kept, c = config) {
  if (!c?.enabled || name === SPINE || c.alwaysActive.includes(name) || c.neverDefer.includes(name)) return false;
  if (promoted.has(name)) return false;
  return (
    k.demoted.has(name) || c.deferredNames.includes(name) || startsWithAny(name, c.deferredPrefixes) || c.deferByDefault
  );
}

const isActive = (s: RunState, name: string) => s.declared.has(name) || s.promoted.has(name);

function state(ctx: Ctx): RunState {
  const s = ctx.run && runs.get(ctx.run.id);
  if (!s) throw new Error("Deferred context is off for this run (disabled, or deferred-tools.json is invalid)");
  return s;
}

/** Configured names first, the rest in their order. */
function byPriority(tools: Tool[], priority: string[]) {
  const rank = (t: Tool) => {
    const i = priority.indexOf(t.name);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  // stable, and Infinity - Infinity (NaN) counts as equal
  return tools.sort((a, b) => rank(a) - rank(b));
}

// Stable text (no counts), so the prompt prefix stays cacheable as tools come and go.
const DEFERRED_TOOLS = [
  "<deferred_tools>",
  "Some registered tools are deferred (schemas hidden). Call search_tools with the capability you need; matching tools are promoted for this run. Use promote_tools / list_capabilities only when those tools are in the active set.",
  "</deferred_tools>",
].join("\n");

const priorityGuidance = (priority: string[]) =>
  [
    "<dce_tool_priority>",
    `DCE owns tool selection priority: ${JSON.stringify(priority)}. For overlapping capabilities use the first available capable tool in this order; use alternatives only for missing capability or a reported failure. This user-configured order overrides package/tool routing preferences, including always/first-use instructions, not safety constraints, tool contracts, or explicit user requests. Do not promote alternatives just to follow their own routing instructions.`,
    "</dce_tool_priority>",
  ].join("\n");

// --- search ranking: deterministic lexical scores, as Pi's DCE ---

const STOP = new Set("a an and for from in of on or the to with capability task tool tools use using".split(" "));
const terms = (v: string) =>
  v
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}_]+/u)
    .filter((t) => t && !STOP.has(t));

/** Whitespace collapsed, cut at `limit` without splitting a surrogate pair. */
function preview(text: string, limit: number) {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= limit) return s;
  return s.slice(0, (s.codePointAt(limit - 1) ?? 0) > 0xffff ? limit - 1 : limit);
}

function score(query: string, item: { name: string; description: string }) {
  const raw = query.toLowerCase().trim();
  const q = terms(raw.replace(/[_-]+/g, " "));
  if (!q.length) return 0;
  const name = item.name.toLowerCase();
  const spaced = name.replace(/[_-]+/g, " ");
  const nameTerms = new Set(terms(spaced));
  const description = item.description.toLowerCase();
  let s = name === raw ? 64 : spaced === q.join(" ") ? 32 : 0;
  for (const t of q) {
    s += nameTerms.has(t) ? 10 : name.includes(t) ? 6 : 0;
    if (description.includes(t)) s += 2;
  }
  if (q.length > 1 && description.includes(q.join(" "))) s += 6;
  return s;
}

interface Match {
  kind: "tool" | "skill";
  name: string;
  score: number;
  skill?: Skill;
}

function rank(query: string, tools: Tool[], skills: Skill[], limit: number): Match[] {
  return [
    ...tools.map((t): Match => ({ kind: "tool", name: t.name, score: score(query, t) })),
    ...skills.map((s): Match => ({ kind: "skill", name: s.name, score: score(query, s), skill: s })),
  ]
    .filter((m) => m.score > 0 && m.name)
    .sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

// --- promotion ---

interface Promotion {
  added: string[];
  already: string[];
  unknown: string[];
  blocked: string[];
}

function promote(s: RunState, names: string[], tools: readonly Tool[]): Promotion {
  const r: Promotion = { added: [], already: [], unknown: [], blocked: [] };
  for (const name of new Set(names)) {
    if (!tools.some((t) => t.name === name)) r.unknown.push(name);
    else if (isBlocked(name, s.kept)) r.blocked.push(name);
    else (isActive(s, name) ? r.already : r.added).push(name);
  }
  for (const name of [...r.added, ...r.already]) {
    s.promoted.add(name);
    s.kept.demoted.delete(name);
    if (config?.promotionLifetime === "session") s.kept.promoted.add(name);
  }
  return r;
}

function promotionText(p: Promotion) {
  if (p.added.length) return `Promoted tools: ${p.added.join(", ")}`;
  if (p.already.length) return `Matching tools already active: ${p.already.join(", ")}`;
  if (p.blocked.length)
    return `Matched tools are blocked by deferred-tools.json: ${p.blocked.join(", ")} (human: /deferred unblock ${p.blocked.join(" ")})`;
  return "";
}

async function skillText(skill: Skill, max: number) {
  try {
    const content = await readFile(skill.path);
    if (content.length > max)
      throw new Error(`Skill exceeds maxSkillBytes (${content.length} > ${max}): ${skill.name}`);
    return `Loaded skill ${skill.name} from ${skill.path}:\n\n${content.toString("utf8")}`;
  } catch (e) {
    return `Matched skill ${skill.name} but failed to load: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const Names = z.object({ names: z.array(z.string().min(1)).min(1) });
const Kind = z.enum(["tool", "skill", "all"]);

const tools = [
  tool({
    name: SPINE,
    description:
      "Search deferred tools or skills by task intent. Promotes matching tools and loads the best matching skill on demand. Use it when the task needs a capability or workflow absent from the active tool list; describe the needed capability, don't guess tool or skill names.",
    inputSchema: z.object({
      query: z.string().describe("Capability, workflow, or task keywords"),
      limit: z.int().min(1).max(SEARCH_CAP).optional(),
      kind: Kind.optional(),
    }),
    execute: async ({ query, limit, kind = "all" }, ctx) => {
      const s = state(ctx);
      const max = config?.maxSearchResults ?? 3;
      const searchable =
        kind === "skill"
          ? []
          : ctx.tools.filter((t) => t.name !== SPINE && !isActive(s, t.name) && !isBlocked(t.name, s.kept));
      const matches = rank(query, searchable, kind === "tool" ? [] : s.skills, Math.min(limit ?? max, max));
      if (!matches.length) return `No deferred capabilities matched: ${query}`;
      const promotion = promote(
        s,
        matches.filter((m) => m.kind === "tool").map((m) => m.name),
        ctx.tools,
      );
      await keep(ctx.session, s.kept);
      // the best skill (matches are sorted by score) is loaded; the rest are only named
      const top = matches.find((m) => m.skill)?.skill;
      const skills = top ? await skillText(top, config?.maxSkillBytes ?? 65536) : "";
      return [promotionText(promotion), skills].filter(Boolean).join("\n\n") || "Matched deferred capabilities.";
    },
  }),
  tool({
    name: "promote_tools",
    description: "Activate specific registered tools by exact name.",
    inputSchema: Names,
    execute: async ({ names }, ctx) => {
      const s = state(ctx);
      const r = promote(s, names, ctx.tools);
      await keep(ctx.session, s.kept);
      return JSON.stringify(r, null, 2);
    },
  }),
  tool({
    name: "demote_tools",
    description: "Deactivate tools by name. Protected spine tools cannot be demoted.",
    inputSchema: Names,
    execute: async ({ names }, ctx) => {
      const s = state(ctx);
      const r = {
        removed: [] as string[],
        alreadyInactive: [] as string[],
        protected: [] as string[],
        unknown: [] as string[],
      };
      for (const name of new Set(names)) {
        if (!ctx.tools.some((t) => t.name === name)) r.unknown.push(name);
        else if (name === SPINE || config?.neverDefer.includes(name)) r.protected.push(name);
        else (isActive(s, name) ? r.removed : r.alreadyInactive).push(name);
      }
      for (const name of [...r.removed, ...r.alreadyInactive]) {
        s.promoted.delete(name);
        s.declared.delete(name);
        s.kept.promoted.delete(name);
        s.kept.demoted.add(name);
      }
      await keep(ctx.session, s.kept);
      return JSON.stringify(r, null, 2);
    },
  }),
  tool({
    name: "list_capabilities",
    description: "Compact index of registered tools and skills, including active or deferred state.",
    inputSchema: z.object({
      filter: z.string().optional().describe("Optional substring filter on name or description"),
      state: z.enum(["active", "deferred", "registered", "blocked", "all"]).optional(),
      kind: Kind.optional(),
    }),
    execute: async ({ filter, state: want = "all", kind = "all" }, ctx) => {
      const s = state(ctx);
      const promptSkills = new Set(config?.deferSkills ? config.activeSkills : s.skills.map((k) => k.name));
      const rows = [
        ...ctx.tools.map((t) => {
          const active = isActive(s, t.name);
          const blocked = isBlocked(t.name, s.kept);
          const st = active
            ? "active"
            : blocked
              ? "blocked"
              : isDeferred(t.name, s.promoted, s.kept)
                ? "deferred"
                : "registered";
          // deferral only hides declarations: ctx.runTool (and codemode) still reach any tool not blocked
          const exposure = t.exposure ? ` [${t.exposure}; nested=${!blocked}]` : "";
          return { kind: "tool", name: t.name, state: st, exposure, description: preview(t.description, 120) };
        }),
        ...s.skills.map((k) => ({
          kind: "skill",
          name: k.name,
          state: promptSkills.has(k.name) ? "active" : "deferred",
          exposure: "",
          description: preview(k.description, 120),
        })),
      ]
        .filter((r) => !filter || `${r.name}\n${r.description}`.toLowerCase().includes(filter.toLowerCase()))
        .filter((r) => (want === "all" || r.state === want) && (kind === "all" || r.kind === kind))
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
      const body = rows.map(
        (r) => `${r.state.padEnd(10)} ${r.kind.padEnd(5)} ${r.name}${r.exposure}  -- ${r.description}`,
      );
      return `Capabilities (${rows.length})\n${body.join("\n") || "(none)"}`;
    },
  }),
];

/** `/deferred status | config | blocked | unblock <tool>…`: the human side, over every loaded tool. */
async function deferredCommand(arg: string, ctx: Ctx) {
  const session = ctx.session;
  if (!session) throw new Error("No session");
  const [sub = "status", ...names] = arg.trim().split(/\s+/).filter(Boolean);
  const c = await loadConfig();
  const k = kept(session);
  const all = ctx.tools.map((t) => t.name);
  const blocked = all.filter((n) => configBlocked(n, c));
  const mark = (n: string) => (k.unblocked.has(n) ? `${n} (unblocked this session)` : n);
  if (sub === "config") return JSON.stringify(c, null, 2);
  if (sub === "blocked") return blocked.length ? `Blocked: ${blocked.map(mark).join(", ")}` : "No tools are blocked";
  if (sub === "unblock") {
    if (!names.length) throw new Error("Usage: /deferred unblock <tool>…");
    const done = names.filter((n) => blocked.includes(n));
    for (const n of done) k.unblocked.add(n);
    await keep(session, k);
    const rest = names.filter((n) => !done.includes(n));
    return [
      done.length ? `Unblocked for this session: ${done.join(", ")}` : "",
      rest.length ? `Not blocked: ${rest.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
  }
  if (sub !== "status") throw new Error("Usage: /deferred status | config | blocked | unblock <tool>…");
  if (!c.enabled) return "Deferred context is disabled";
  const promoted = c.promotionLifetime === "session" ? k.promoted : new Set<string>();
  const deferred = all.filter((n) => !isBlocked(n, k, c) && isDeferred(n, promoted, k, c));
  return [
    `${all.length} tools: ${deferred.length} deferred, ${blocked.length} blocked`,
    blocked.length ? `blocked: ${blocked.map(mark).join(", ")}` : "",
    k.promoted.size ? `promoted this session: ${[...k.promoted].join(", ")}` : "",
    k.demoted.size ? `demoted: ${[...k.demoted].join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Pi's deferred context engine: only `search_tools` (plus pins) is declared to the model, every other tool is deferred
 * until the model searches for it (promoted for the run, or the session), skills are left out of the prompt and loaded
 * by the same search, blocked tools are never declared or run, and identical AGENTS.md files appear once.
 */
export default {
  tools,
  entries: {
    state: (entry: PluginEntry<Saved>, state) => {
      state.data[KEY] = entry.data;
    },
  },
  on: {
    run_start: async (p, ctx) => {
      config = await loadConfig();
      if (!config.enabled || !ctx.run) return;
      const k = kept(ctx.session);
      runs.set(ctx.run.id, {
        skills: p.skills ?? [],
        promoted: new Set(config.promotionLifetime === "session" ? k.promoted : []),
        declared: new Set(),
        kept: k,
      });
      // the prompt lists only pinned skills; search_tools finds the rest
      const pinned = config.activeSkills;
      if (config.deferSkills && p.skills) p.skills = p.skills.filter((s) => pinned.includes(s.name));
      if (config.deduplicateContext) {
        const seen = new Set<string>();
        p.context = p.context.filter((f) => !seen.has(f.content) && seen.add(f.content));
      }
    },
    prompt: (p, ctx) => {
      const s = ctx.run && runs.get(ctx.run.id);
      if (!s || !config) return;
      if (p.tools.some((t) => !isBlocked(t.name, s.kept) && isDeferred(t.name, s.promoted, s.kept)))
        p.system.push(DEFERRED_TOOLS);
      if (config.toolPriority.length) p.system.push(priorityGuidance(config.toolPriority));
    },
    request: (r, ctx) => {
      if (r.source !== "run" && r.source !== "preview") return;
      const s = ctx.run && runs.get(ctx.run.id);
      if (!s || !config) return;
      const known = new Set(ctx.tools.map((t) => t.name));
      // names unknown to the run (a plugin's own declarations) pass through, unless blocked
      const declared = r.tools.filter(
        (t) => !isBlocked(t.name, s.kept) && !(known.has(t.name) && isDeferred(t.name, s.promoted, s.kept)),
      );
      // promoted tools are declared even when their exposure is "codemode" (e.g. MCP tools)
      for (const t of ctx.tools)
        if (s.promoted.has(t.name) && !isBlocked(t.name, s.kept) && !declared.some((d) => d.name === t.name))
          declared.push(t);
      r.tools = byPriority(declared, config.toolPriority);
    },
    response: ({ request }, ctx) => {
      const s = request.source === "run" && ctx.run && runs.get(ctx.run.id);
      if (s) s.declared = new Set(request.tools.map((t) => t.name));
    },
    // previews end too
    run_end: (_, ctx) => {
      if (ctx.run) runs.delete(ctx.run.id);
    },
    // model calls to blocked tools are undeclared already; this catches nested ones (ctx.runTool) too
    tool_call: (p, ctx) => {
      const k = (ctx.run && runs.get(ctx.run.id)?.kept) || kept(ctx.session);
      if (!p.result && isBlocked(p.call.name, k))
        p.result = {
          id: p.call.id,
          output: `DCE blocks this tool: ${p.call.name}. Use /deferred unblock to change the policy.`,
          isError: true,
        };
    },
  },
  commands: [
    {
      name: "deferred",
      args: "[status | config | blocked | unblock <tool>…]",
      description: "Deferred context: status, config, blocked tools, unblock for this session",
      run: deferredCommand,
    },
  ],
} satisfies Plugin;
