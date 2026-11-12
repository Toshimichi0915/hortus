import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hortusDir } from "@hortus/core";

export const RTK_MODES = ["rewrite", "suggest"] as const;
export const RTK_SOURCE_FILTER_LEVELS = ["none", "minimal", "aggressive"] as const;
export type RtkSourceFilterLevel = (typeof RTK_SOURCE_FILTER_LEVELS)[number];

export interface RtkOutputCompactionConfig {
  enabled: boolean;
  stripAnsi: boolean;
  readCompaction: { enabled: boolean };
  truncate: { enabled: boolean; maxChars: number };
  sourceCodeFilteringEnabled: boolean;
  preserveExactSkillReads: boolean;
  sourceCodeFiltering: RtkSourceFilterLevel;
  smartTruncate: { enabled: boolean; maxLines: number };
  aggregateTestOutput: boolean;
  filterBuildOutput: boolean;
  compactGitOutput: boolean;
  aggregateLinterOutput: boolean;
  groupSearchOutput: boolean;
  trackSavings: boolean;
}

export interface RtkConfig {
  enabled: boolean;
  mode: (typeof RTK_MODES)[number];
  guardWhenRtkMissing: boolean;
  showRewriteNotifications: boolean;
  outputCompaction: RtkOutputCompactionConfig;
}

export const DEFAULT_CONFIG: RtkConfig = {
  enabled: true,
  mode: "rewrite",
  guardWhenRtkMissing: true,
  showRewriteNotifications: true,
  outputCompaction: {
    enabled: true,
    stripAnsi: true,
    readCompaction: { enabled: false },
    truncate: { enabled: true, maxChars: 12_000 },
    sourceCodeFilteringEnabled: false,
    preserveExactSkillReads: false,
    sourceCodeFiltering: "none",
    smartTruncate: { enabled: false, maxLines: 220 },
    aggregateTestOutput: true,
    filterBuildOutput: true,
    compactGitOutput: true,
    aggregateLinterOutput: true,
    groupSearchOutput: true,
    trackSavings: true,
  },
};

/** Integer ranges of the numeric settings (out-of-range values are clamped). */
const RANGES: Record<string, [number, number]> = { maxChars: [1_000, 200_000], maxLines: [40, 4_000] };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** `raw` over the defaults, keeping only values of the default's type (enums checked, numbers rounded and clamped). */
function normalize<T>(def: T, raw: unknown, key = ""): T {
  if (isRecord(def)) {
    const src = isRecord(raw) ? raw : {};
    return Object.fromEntries(Object.entries(def).map(([k, v]) => [k, normalize(v, src[k], k)])) as T;
  }
  if (typeof def === "number") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return def;
    const [min, max] = RANGES[key] ?? [-Infinity, Infinity];
    return Math.max(min, Math.min(max, Math.round(raw))) as T;
  }
  if (key === "mode") return (RTK_MODES.includes(raw as never) ? raw : def) as T;
  if (key === "sourceCodeFiltering") return (RTK_SOURCE_FILTER_LEVELS.includes(raw as never) ? raw : def) as T;
  return (typeof raw === typeof def ? raw : def) as T;
}

export const normalizeConfig = (raw: unknown): RtkConfig => normalize(DEFAULT_CONFIG, raw);

// ponytail: hortus has no per-plugin config location; a file next to config.json, like Pi's extension dir
export const configPath = () => join(hortusDir(), "rtk-optimizer.json");

/** The config, writing the defaults first if there is none; a file that doesn't parse gives the defaults and a warning. */
export function loadConfig(): { config: RtkConfig; warning?: string } {
  const path = configPath();
  try {
    if (!existsSync(path)) saveConfig(DEFAULT_CONFIG);
    return { config: normalizeConfig(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (e) {
    return { config: structuredClone(DEFAULT_CONFIG), warning: `Failed to load ${path}: ${(e as Error).message}` };
  }
}

export function saveConfig(config: RtkConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}
