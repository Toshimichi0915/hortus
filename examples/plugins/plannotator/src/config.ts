import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EFFORTS, type Effort, hortusDir } from "@hortus/core";

export type Phase = "idle" | "planning" | "executing";

export interface PhaseProfile {
  model?: { provider: string; id: string } | null;
  thinking?: Effort | null;
  activeTools?: string[] | null;
  statusLabel?: string | null;
  instructions?: string | null;
}

export interface PlannotatorConfig {
  executionMode?: "automatic" | "external" | null;
  defaults?: PhaseProfile | null;
  phases?: Partial<Record<"planning" | "executing" | "reviewing", PhaseProfile | null>>;
  /** the `plannotator` tool for the model (Pi: `~/.plannotator/config.json`'s `agentTool`) */
  agentTool?: boolean;
  /** "none" opens nothing; else a command to open review URLs with (default: `PLANNOTATOR_BROWSER`, `BROWSER`, the OS's) */
  browser?: string;
}

const PHASES = ["planning", "executing", "reviewing"] as const;
const PROFILE_KEYS = ["model", "thinking", "activeTools", "statusLabel", "instructions"] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One profile as written: `null` (or "" / []) clears what lower layers set, a missing key inherits. */
function profile(raw: unknown, where: string, warnings: string[]): PhaseProfile | null | undefined {
  if (raw === null) return null;
  if (!isRecord(raw)) return undefined;
  const p: PhaseProfile = {};
  if ("model" in raw) {
    const m = raw.model;
    p.model =
      isRecord(m) && typeof m.provider === "string" && typeof m.id === "string"
        ? { provider: m.provider, id: m.id }
        : null;
  }
  const thinking = raw.thinking ?? raw.thinkingLevel;
  if (thinking === null || thinking === "") p.thinking = null;
  else if (thinking === "minimal")
    p.thinking = "low"; // Pi's level below low; hortus has none
  else if (EFFORTS.includes(thinking as Effort)) p.thinking = thinking as Effort;
  else if (thinking !== undefined)
    warnings.push(
      `Ignoring unknown thinking ${JSON.stringify(thinking)} at ${where}: expected one of ${EFFORTS.join(", ")}`,
    );
  if ("activeTools" in raw)
    p.activeTools = Array.isArray(raw.activeTools) ? raw.activeTools.filter((t) => typeof t === "string") : null;
  for (const key of ["statusLabel", "instructions"] as const)
    if (key in raw) p[key] = typeof raw[key] === "string" && raw[key] ? (raw[key] as string) : null;
  if ("systemPrompt" in raw)
    warnings.push(`Ignoring obsolete "systemPrompt" at ${where}: rename it to "instructions" (a phase-entry message)`);
  return p;
}

function load(path: string, warnings: string[]): PlannotatorConfig {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    warnings.push(`Failed to parse ${path}: ${(e as Error).message}`);
    return {};
  }
  if (!isRecord(raw)) return {};
  const c: PlannotatorConfig = {};
  if (raw.executionMode === null || raw.executionMode === "automatic" || raw.executionMode === "external")
    c.executionMode = raw.executionMode;
  else if (raw.executionMode !== undefined)
    warnings.push(`Ignoring unknown executionMode ${JSON.stringify(raw.executionMode)} in ${path}`);
  if ("defaults" in raw) c.defaults = profile(raw.defaults, `defaults in ${path}`, warnings);
  if (isRecord(raw.phases)) {
    c.phases = {};
    for (const ph of PHASES) {
      const p = profile(raw.phases[ph], `phases.${ph} in ${path}`, warnings);
      if (p !== undefined) c.phases[ph] = p;
    }
  }
  if (typeof raw.agentTool === "boolean") c.agentTool = raw.agentTool;
  if (typeof raw.browser === "string") c.browser = raw.browser;
  return c;
}

function mergeProfile(base?: PhaseProfile | null, over?: PhaseProfile | null): PhaseProfile | null | undefined {
  if (over === null) return null;
  if (!over) return base;
  if (!base) return over;
  const merged: PhaseProfile = { ...base };
  for (const k of PROFILE_KEYS) if (over[k] !== undefined) Object.assign(merged, { [k]: over[k] });
  return merged;
}

function merge(base: PlannotatorConfig, over: PlannotatorConfig): PlannotatorConfig {
  const phases: PlannotatorConfig["phases"] = {};
  for (const ph of PHASES) {
    const p = mergeProfile(base.phases?.[ph], over.phases?.[ph]);
    if (p !== undefined) phases[ph] = p;
  }
  return {
    executionMode: over.executionMode !== undefined ? over.executionMode : base.executionMode,
    defaults: mergeProfile(base.defaults, over.defaults),
    phases,
    agentTool: over.agentTool ?? base.agentTool,
    browser: over.browser ?? base.browser,
  };
}

export const BASE_CONFIG = new URL("../plannotator.json", import.meta.url).pathname;
export const projectConfigPath = (cwd: string) => join(cwd, ".hortus", "plannotator.json");

/**
 * The built-in config, then `~/.hortus/plannotator.json`, then (when `trusted`) `<cwd>/.hortus/plannotator.json`; later
 * layers win field by field. Read on every call (each run), so edits apply without a restart.
 */
export function loadConfig(cwd: string, trusted: boolean) {
  const warnings: string[] = [];
  let config = load(BASE_CONFIG, warnings);
  config = merge(config, load(join(hortusDir(), "plannotator.json"), warnings));
  if (trusted) config = merge(config, load(projectConfigPath(cwd), warnings));
  return { config, warnings };
}

export interface ResolvedProfile {
  model?: { provider: string; id: string };
  thinking?: Effort;
  activeTools: string[];
  statusLabel?: string;
  instructions?: string;
}

export function resolveProfile(config: PlannotatorConfig, phase: "planning" | "executing"): ResolvedProfile {
  const p = mergeProfile(config.defaults ?? undefined, config.phases?.[phase] ?? undefined) ?? {};
  return {
    model: p.model ?? undefined,
    thinking: p.thinking ?? undefined,
    activeTools: p.activeTools ?? [],
    statusLabel: p.statusLabel ?? undefined,
    instructions: p.instructions ?? undefined,
  };
}

/** `${name}` variables of `template` filled from `vars`; unknown ones become "" and are listed. */
export function renderTemplate(template: string, vars: Record<string, string | number>) {
  const unknown = new Set<string>();
  const text = template.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => {
    if (key in vars) return String(vars[key]);
    unknown.add(key);
    return "";
  });
  return { text, unknown: [...unknown] };
}
