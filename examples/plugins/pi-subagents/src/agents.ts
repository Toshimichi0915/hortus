import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EFFORTS, type Effort, hortusDir, parseFrontmatter, projectDirs } from "@hortus/core";

/** An agent: a markdown file's frontmatter and body (Pi's agent definition, the fields hortus can honour). */
export interface AgentDef {
  name: string;
  description: string;
  /** the system prompt (the file's body) */
  prompt: string;
  source: "builtin" | "user" | "project" | "runtime";
  path?: string;
  aliases: string[];
  /** strict tool allowlist; none: every tool the child has */
  tools?: string[];
  excludeTools: string[];
  /** `provider/model` or a bare model (the caller's provider), optionally `:<thinking>` */
  model?: string;
  thinking?: Effort;
  /** "replace" (default): the agent prompt instead of hortus's base prompt; "append": after it */
  systemPromptMode: "replace" | "append";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  defaultContext?: "fresh" | "fork";
  async?: boolean;
  timeoutMs?: number;
  maxSubagentDepth?: number;
  /** may launch only these agents (with `subagent` in `tools`) */
  allowedAgents?: string[];
  /** listed in the parent's system prompt */
  advertise: boolean;
  /** plugins (Pi: extensions) the child loads besides the built-in pieces; none: all */
  extensions?: string[];
}

/** Per-agent settings from the plugin config (`agentOverrides.<name>`). */
export interface AgentOverride {
  model?: string;
  thinking?: string;
  advertise?: boolean;
  disabled?: boolean;
}

/** Frontmatter and the body: core's YAML parse, each value as a string (a list's items as strings); invalid YAML = none. */
export function splitFrontmatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(text);
  } catch {
    return { meta: {}, body: text.trim() };
  }
  const meta: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(parsed.meta)) {
    if (v == null) continue;
    meta[k] = Array.isArray(v) ? v.map(String) : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return { meta, body: parsed.body.trim() };
}

const list = (v: string | string[] | undefined) =>
  v === undefined ? undefined : (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean);
const bool = (v: string | string[] | undefined, dflt: boolean) => (v === undefined ? dflt : v === "true");
const num = (v: string | string[] | undefined) => (typeof v === "string" && v && Number.isFinite(+v) ? +v : undefined);

/** Pi's thinking levels as hortus efforts (`minimal` is `low`); undefined for none or an unknown one. */
export function effortOf(level: string | undefined): Effort | undefined {
  if (level === "minimal") return "low";
  return EFFORTS.find((e) => e === level);
}

/** Parses an agent file; undefined when it isn't one (no name or description). */
export function parseAgent(text: string, source: AgentDef["source"], path?: string): AgentDef | undefined {
  const { meta, body } = splitFrontmatter(text);
  const name = typeof meta.name === "string" ? meta.name : undefined;
  const description = typeof meta.description === "string" ? meta.description : undefined;
  if (!name || !description) return undefined;
  const pkg = typeof meta.package === "string" && meta.package ? `${meta.package}.` : "";
  const ctxMode = meta.defaultContext;
  return {
    name: `${pkg}${name}`,
    description,
    prompt: body,
    source,
    path,
    aliases: list(meta.aliases) ?? [],
    tools: list(meta.tools),
    excludeTools: list(meta.excludeTools) ?? [],
    model: typeof meta.model === "string" && meta.model ? meta.model : undefined,
    thinking: effortOf(typeof meta.thinking === "string" ? meta.thinking : undefined),
    systemPromptMode: meta.systemPromptMode === "append" ? "append" : "replace",
    inheritProjectContext: bool(meta.inheritProjectContext, false),
    inheritSkills: bool(meta.inheritSkills, false),
    defaultContext: ctxMode === "fork" || ctxMode === "fresh" ? ctxMode : undefined,
    async: meta.async === undefined ? undefined : meta.async === "true",
    timeoutMs: num(meta.timeoutMs),
    maxSubagentDepth: num(meta.maxSubagentDepth),
    allowedAgents: list(meta.allowedAgents),
    advertise: bool(meta.advertise, false),
    extensions: list(meta.extensions),
  };
}

export const builtinDir = fileURLToPath(new URL("../agents", import.meta.url));
export const userDir = () => join(hortusDir(), "agents");

/** Agent files under `dir`, recursively (`.chain.md` files aren't agents). */
async function readDir(dir: string, source: AgentDef["source"]): Promise<AgentDef[]> {
  const names = await readdir(dir, { recursive: true }).catch(() => []);
  const out: AgentDef[] = [];
  for (const n of names.filter((n) => n.endsWith(".md") && !n.endsWith(".chain.md")).sort()) {
    const path = join(dir, n);
    const def = parseAgent(await readFile(path, "utf8").catch(() => ""), source, path);
    if (def) out.push(def);
  }
  return out;
}

/**
 * Every agent, by name, lowest priority first: bundled, `~/.hortus/agents`, each project dir's `.hortus/agents` (root
 * first, so the nearest wins), then runtime-registered ones; `overrides` patch model/thinking/advertise and drop
 * disabled ones.
 */
export async function discoverAgents(
  cwd: string,
  runtime: Iterable<AgentDef> = [],
  overrides: Record<string, AgentOverride> = {},
): Promise<Map<string, AgentDef>> {
  const found = [
    ...(await readDir(builtinDir, "builtin")),
    ...(await readDir(userDir(), "user")),
    ...(
      await Promise.all((await projectDirs(cwd)).map((d) => readDir(join(d, ".hortus", "agents"), "project")))
    ).flat(),
    ...runtime,
  ];
  const agents = new Map<string, AgentDef>();
  for (const a of found) agents.set(a.name, a);
  for (const [name, o] of Object.entries(overrides)) {
    const a = agents.get(name);
    if (!a) continue;
    if (o.disabled) agents.delete(name);
    else
      agents.set(name, {
        ...a,
        ...(o.model && { model: o.model }),
        ...(effortOf(o.thinking) && { thinking: effortOf(o.thinking) }),
        ...(o.advertise !== undefined && { advertise: o.advertise }),
      });
  }
  return agents;
}

/** An agent by exact name, else by alias; throws listing the available ones. */
export function findAgent(agents: Map<string, AgentDef>, name: string): AgentDef {
  const a = agents.get(name) ?? [...agents.values()].find((x) => x.aliases.includes(name));
  if (a) return a;
  throw new Error(`Unknown agent "${name}". Available: ${[...agents.keys()].join(", ") || "none"}`);
}
