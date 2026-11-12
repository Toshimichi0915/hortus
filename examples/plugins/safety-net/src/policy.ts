import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hortusDir } from "@hortus/core";
import type { SecretPolicy } from "./secrets.ts";

export type Level = "standard" | "strict" | "paranoid";

/** The effective policy for one check: `policy.json` (user, then project) under the session's env. */
export interface Policy {
  level: Level;
  failClosed: boolean;
  paranoidRm: boolean;
  paranoidInterpreters: boolean;
  worktree: boolean;
  destructive: { enabled: boolean; overrides: Record<string, "on" | "off">; allowPaths: string[] };
  secret: SecretPolicy;
  /** the policy files a tool call must not change (`guard.policy-config`) */
  files: string[];
  /** files that failed to load (their scope falls back to defaults) */
  warnings: string[];
  rules: CustomRule[];
}

/** One rule of a rulebook (`rulebook.json`'s `rules[]`). */
export interface CustomRule {
  id: string;
  name: string;
  command: string;
  subcommand?: string;
  blockArgs: string[];
  commandPath: string[];
  anyArgs: string[];
  excludeArgs: string[];
  reason: string;
}

/** `$CC_SAFETY_NET_HOME`, else `~/.hortus/safety-net` (the user scope: policy.json, rule.json, rules/, logs/) */
export const userDir = () => process.env.CC_SAFETY_NET_HOME || join(hortusDir(), "safety-net");
/** the project scope, committed with the repo (the same layout as the original's, so a team shares one) */
export const projectDir = (root: string) => join(root, ".cc-safety-net");

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

interface PolicyFile {
  safety?: {
    level?: string;
    overrides?: Partial<Record<"fail_closed" | "paranoid_rm" | "paranoid_interpreters", boolean>>;
  };
  workflow?: { worktree_mode?: boolean };
  destructive_command_protection?: {
    enabled?: boolean;
    overrides?: Record<string, "on" | "off">;
    allow_paths?: string[];
  };
  secret_protection?: {
    enabled?: boolean;
    overrides?: Record<string, "on" | "off">;
    allow_paths?: string[];
    deny_paths?: string[];
  };
}

function readJson<T>(path: string, warnings: string[]): T | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as T;
    warnings.push(`${path}: not a JSON object`);
  } catch (e) {
    warnings.push(`${path}: ${(e as Error).message}`);
  }
}

/** `<scope>/rule.json` (`{ "rules": ["name", …] }`) → each `<scope>/rules/<name>/rulebook.json`'s rules */
function loadRules(scope: string, warnings: string[], seen: Set<string>): CustomRule[] {
  const cfg = readJson<{ rules?: unknown }>(join(scope, "rule.json"), warnings);
  let names: string[] = [];
  if (cfg && Array.isArray(cfg.rules)) names = cfg.rules.filter((n): n is string => typeof n === "string");
  else if (!cfg) {
    // without a rule.json, every rulebook in rules/ (a cloned repo's shared ones)
    try {
      names = readdirSync(join(scope, "rules"));
    } catch {}
  }
  const out: CustomRule[] = [];
  for (const name of names) {
    // the first claim of a name wins: user scope before project scope
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) || seen.has(name)) continue;
    const book = readJson<{ name?: string; rules?: unknown[] }>(join(scope, "rules", name, "rulebook.json"), warnings);
    if (!book || !Array.isArray(book.rules)) continue;
    seen.add(name);
    for (const r of book.rules as Record<string, unknown>[]) {
      if (typeof r?.name !== "string" || typeof r.command !== "string" || typeof r.reason !== "string") continue;
      const strs = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
      const match = (r.match ?? {}) as Record<string, unknown>;
      out.push({
        id: `custom.${name}.${r.name}`,
        name: r.name,
        command: r.command,
        ...(typeof r.subcommand === "string" && { subcommand: r.subcommand }),
        blockArgs: strs(r.block_args),
        commandPath: strs(match.command_path),
        anyArgs: strs(match.any_args),
        excludeArgs: strs(match.exclude_args),
        reason: `[${name}] ${r.reason}`,
      });
    }
  }
  return out;
}

/**
 * Reads the policy now (files are live: an edit applies to the next call). A broken file is a warning and its scope's
 * defaults, never an error: the guard keeps guarding.
 */
export function loadPolicy(root: string): Policy {
  const warnings: string[] = [];
  const files = [join(userDir(), "policy.json"), join(projectDir(root), "policy.json")];
  const [user = {}, project = {}] = files.map((f) => readJson<PolicyFile>(f, warnings) ?? {});
  const tighten = truthy(process.env.CC_SAFETY_NET_PROJECT_TIGHTEN_ONLY);
  const order: Level[] = ["standard", "strict", "paranoid"];
  const lvl = (v: unknown): Level | undefined => (order.includes(v as Level) ? (v as Level) : undefined);
  let level = lvl(user.safety?.level) ?? "standard";
  const pl = lvl(project.safety?.level);
  if (pl && (!tighten || order.indexOf(pl) > order.indexOf(level))) level = pl;
  const envLevel = lvl(process.env.CC_SAFETY_NET_LEVEL?.trim().toLowerCase());
  if (envLevel) level = envLevel;
  if (truthy(process.env.CC_SAFETY_NET_PARANOID ?? process.env.SAFETY_NET_PARANOID)) level = "paranoid";
  else if (level === "standard" && truthy(process.env.CC_SAFETY_NET_STRICT ?? process.env.SAFETY_NET_STRICT))
    level = "strict";
  const pins = { ...user.safety?.overrides, ...project.safety?.overrides };
  const env = (name: string) => {
    const v = process.env[`CC_SAFETY_NET_${name}`] ?? process.env[`SAFETY_NET_${name}`];
    return v === undefined ? undefined : truthy(v);
  };
  const d = { ...user.destructive_command_protection, ...project.destructive_command_protection };
  const s = { ...user.secret_protection, ...project.secret_protection };
  const seen = new Set<string>();
  return {
    level,
    failClosed: pins.fail_closed ?? level !== "standard",
    paranoidRm: env("PARANOID_RM") ?? pins.paranoid_rm ?? level === "paranoid",
    paranoidInterpreters: env("PARANOID_INTERPRETERS") ?? pins.paranoid_interpreters ?? level === "paranoid",
    worktree: env("WORKTREE") ?? project.workflow?.worktree_mode ?? user.workflow?.worktree_mode ?? false,
    destructive: {
      enabled: d.enabled !== false,
      overrides: {
        ...user.destructive_command_protection?.overrides,
        ...project.destructive_command_protection?.overrides,
      },
      allowPaths: d.allow_paths ?? [],
    },
    secret: {
      enabled: s.enabled !== false,
      overrides: { ...user.secret_protection?.overrides, ...project.secret_protection?.overrides },
      allowPaths: s.allow_paths ?? [],
      // deny paths only add up
      denyPaths: [...(user.secret_protection?.deny_paths ?? []), ...(project.secret_protection?.deny_paths ?? [])],
    },
    files,
    warnings,
    rules: [...loadRules(userDir(), warnings, seen), ...loadRules(projectDir(root), warnings, seen)],
  };
}
