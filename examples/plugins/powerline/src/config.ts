import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hortusDir } from "@hortus/core";

/** Pi's built-in segments (`queue` waits for compaction, `shell_mode` for bash mode: both never show). */
export const SEGMENT_IDS = [
  "model",
  "shell_mode",
  "path",
  "git",
  "subagents",
  "queue",
  "token_in",
  "token_out",
  "token_total",
  "cost",
  "context_pct",
  "context_total",
  "time_spent",
  "time",
  "session",
  "hostname",
  "cache_read",
  "cache_write",
  "thinking",
  "extension_statuses",
] as const;
export type BuiltinSegment = (typeof SEGMENT_IDS)[number];
export type SegmentId = BuiltinSegment | `custom:${string}`;

export const SEPARATORS = [
  "powerline",
  "powerline-thin",
  "slash",
  "pipe",
  "block",
  "none",
  "ascii",
  "dot",
  "chevron",
  "star",
] as const;
export type Separator = (typeof SEPARATORS)[number];
export const PRESET_NAMES = ["default", "minimal", "compact", "full", "nerd", "ascii"] as const;
export type Preset = (typeof PRESET_NAMES)[number];
export const CURRENCIES = ["USD", "CNY", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "INR", "KRW"] as const;
export type Currency = (typeof CURRENCIES)[number];

export interface SegmentOptions {
  model?: { showThinkingLevel?: boolean; display?: "name" | "qualified" };
  path?: { mode?: "basename" | "abbreviated" | "full"; maxLength?: number };
  git?: {
    showBranch?: boolean;
    showStaged?: boolean;
    showUnstaged?: boolean;
    showUntracked?: boolean;
    polling?: "full" | "branch" | "off";
    hostIcon?: boolean;
    statusTtlMs?: number;
  };
  time?: { format?: "12h" | "24h"; showSeconds?: boolean };
  cost?: { subscriptionDisplay?: "subscription" | "reported-cost" | "both"; currency?: Currency };
  context?: { format?: "full" | "percent" };
  cache_read?: { format?: "tokens" | "percent" | "both" | "request" | "session-request" };
}

export interface CustomItem {
  id: string;
  statusKey: string;
  position: "left" | "right" | "secondary";
  color?: string;
  selfColorize: boolean;
  prefix?: string;
  hideWhenMissing: boolean;
  excludeFromExtensionStatuses: boolean;
}

export interface Layout {
  left?: SegmentId[];
  right?: SegmentId[];
  secondary?: SegmentId[];
}

export interface Shortcuts {
  stashHistory: string | null;
  copyEditor: string | null;
  cutEditor: string | null;
  reply: string | null;
}

export interface VibeSettings {
  theme: string | null;
  mode: "generate" | "file";
  /** `provider/model[:effort]`, or "auto" (the session's model) */
  model: string;
  fallback: string;
  refreshInterval: number;
  prompt: string;
  maxLength: number;
}

export interface PowerlineConfig {
  preset: Preset;
  customItems: CustomItem[];
  disabledSegments: SegmentId[];
  layout: Layout | null;
  separator: Separator | null;
  segmentOptions: SegmentOptions;
  placement: "above" | "below";
  padding: number;
  secondaryOverflow: "drop" | "wrap";
  workingIndicatorPlacement: "editor-border" | "above-powerline";
  welcome: boolean;
  sendDelayMs: number;
  autoFollowUp: boolean;
  workingVibes: { color?: string };
  hiddenExtensionStatusKeys: string[];
  showLastPrompt: boolean;
  shortcuts: Shortcuts;
  vibe: VibeSettings;
  /** theme.json's: semantic color and icon overrides */
  colors: Record<string, string>;
  icons: Record<string, string>;
  /** what was ignored, for a warning at start */
  invalid: string[];
}

export const DEFAULT_VIBE_PROMPT = `Generate a 2-4 word "{theme}" themed loading message ending in "...".

Task: {task}

Be creative and unexpected. Avoid obvious/clichéd phrases for this theme.
The message should hint at the task using theme vocabulary.
{exclude}
Output only the message, nothing else.`;

const DEFAULT_SHORTCUTS: Shortcuts = {
  stashHistory: "ctrl+alt+h",
  copyEditor: "ctrl+alt+c",
  cutEditor: "ctrl+alt+x",
  reply: null,
};
/** keys hortus or this plugin already use */
const RESERVED = new Set([
  "escape",
  "ctrl+c",
  "ctrl+d",
  "ctrl+o",
  "shift+tab",
  "alt+enter",
  "alt+s",
  "ctrl+s",
  "enter",
]);

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(all: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" && (all as readonly string[]).includes(v.trim().toLowerCase())
    ? (v.trim().toLowerCase() as T)
    : undefined;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const num = (v: unknown, ok: (n: number) => boolean) =>
  typeof v === "number" && Number.isFinite(v) && ok(v) ? v : undefined;
/** `o` without its undefined fields, so spreads over defaults keep them */
const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function customItems(raw: unknown): CustomItem[] {
  const entries: [unknown, unknown][] = Array.isArray(raw)
    ? raw.map((e) => [isRecord(e) ? e.id : undefined, e])
    : isRecord(raw)
      ? Object.entries(raw)
      : [];
  const out = new Map<string, CustomItem>();
  for (const [rawId, e] of entries) {
    const id = str(rawId);
    if (!isRecord(e) || !id || !/^[a-zA-Z0-9_-]+$/.test(id)) continue;
    out.set(id, {
      id,
      statusKey: str(e.statusKey) ?? id,
      position: oneOf(["left", "right", "secondary"], e.position) ?? "right",
      color: str(e.color),
      selfColorize: e.selfColorize === true,
      prefix: str(e.prefix),
      hideWhenMissing: e.hideWhenMissing !== false,
      excludeFromExtensionStatuses: e.excludeFromExtensionStatuses !== false,
    });
  }
  return [...out.values()];
}

function segmentId(v: unknown, custom: Set<string>): SegmentId | undefined {
  const s = str(v);
  if (!s) return;
  if ((SEGMENT_IDS as readonly string[]).includes(s)) return s as SegmentId;
  return s.startsWith("custom:") && custom.has(s.slice(7)) ? (s as SegmentId) : undefined;
}

function segmentOptions(raw: Raw): SegmentOptions {
  const o: SegmentOptions = {};
  const m = raw.model;
  if (isRecord(m))
    o.model = defined({
      showThinkingLevel: bool(m.showThinkingLevel),
      display: oneOf(["name", "qualified"], m.display),
    });
  const p = raw.path;
  if (isRecord(p))
    o.path = defined({
      mode: oneOf(["basename", "abbreviated", "full"], p.mode),
      maxLength: num(p.maxLength, (n) => n > 0),
    });
  const g = raw.git;
  if (isRecord(g))
    o.git = defined({
      showBranch: bool(g.showBranch),
      showStaged: bool(g.showStaged),
      showUnstaged: bool(g.showUnstaged),
      showUntracked: bool(g.showUntracked),
      polling: oneOf(["full", "branch", "off"], g.polling),
      statusTtlMs: num(g.statusTtlMs, (n) => n >= 0),
      hostIcon: bool(g.hostIcon),
    });
  const t = raw.time;
  if (isRecord(t)) o.time = defined({ format: oneOf(["12h", "24h"], t.format), showSeconds: bool(t.showSeconds) });
  const c = raw.cost;
  if (isRecord(c))
    o.cost = defined({
      subscriptionDisplay: oneOf(["subscription", "reported-cost", "both"], c.subscriptionDisplay),
      currency: typeof c.currency === "string" ? oneOf(CURRENCIES, c.currency.toUpperCase()) : undefined,
    });
  if (isRecord(raw.context)) o.context = defined({ format: oneOf(["full", "percent"], raw.context.format) });
  if (isRecord(raw.cache_read))
    o.cache_read = defined({
      format: oneOf(["tokens", "percent", "both", "request", "session-request"], raw.cache_read.format),
    });
  return o;
}

/** Shortcut overrides (`null`/"" disables one); one taken by hortus falls back to its default, else is disabled. */
function shortcuts(raw: unknown, invalid: string[]): Shortcuts {
  const out = { ...DEFAULT_SHORTCUTS };
  const used = new Set(RESERVED);
  for (const key of Object.keys(out) as (keyof Shortcuts)[]) {
    const v = isRecord(raw) && Object.hasOwn(raw, key) ? raw[key] : undefined;
    if (v === null || v === "") out[key] = null;
    else if (typeof v === "string") out[key] = v.trim().toLowerCase();
    const k = out[key];
    if (k === null) continue;
    if (!used.has(k)) {
      used.add(k);
      continue;
    }
    invalid.push(`shortcut ${key}: ${k} is taken`);
    const fallback = DEFAULT_SHORTCUTS[key];
    out[key] = fallback && !used.has(fallback) ? fallback : null;
    if (out[key]) used.add(fallback as string);
  }
  return out;
}

/** `~/.hortus/powerline.json`: Pi's `powerline` settings, plus `showLastPrompt`, `shortcuts`, `vibe`, `colors`, `icons`. */
export function parseConfig(value: unknown): PowerlineConfig {
  const raw: Raw = isRecord(value) ? value : typeof value === "string" ? { preset: value } : {};
  const invalid: string[] = [];
  const custom = customItems(raw.customItems);
  const ids = new Set(custom.map((c) => c.id));

  const disabledSegments: SegmentId[] = [];
  for (const e of Array.isArray(raw.disabledSegments) ? raw.disabledSegments : []) {
    const id = segmentId(e, ids);
    if (!id) invalid.push(`disabled segment ${JSON.stringify(e)}`);
    else if (!disabledSegments.includes(id)) disabledSegments.push(id);
  }

  let layout: Layout | null = null;
  if (isRecord(raw.layout)) {
    layout = {};
    const placed = new Set<SegmentId>();
    for (const row of ["left", "right", "secondary"] as const) {
      const entries = raw.layout[row];
      if (!Array.isArray(entries)) continue;
      const segs: SegmentId[] = [];
      for (const e of entries) {
        const id = segmentId(e, ids);
        if (!id) invalid.push(`layout segment ${row}:${String(e)}`);
        else if (segs.includes(id)) continue;
        else if (placed.has(id)) invalid.push(`layout segment ${row}:${id}`);
        else {
          placed.add(id);
          segs.push(id);
        }
      }
      layout[row] = segs;
    }
    if (!Object.keys(layout).length) layout = null;
  }

  const placement = raw.placement === undefined ? "above" : oneOf(["above", "below"], raw.placement);
  if (!placement) invalid.push(`placement ${JSON.stringify(raw.placement)}`);
  const overflow = raw.secondaryOverflow === undefined ? "drop" : oneOf(["drop", "wrap"], raw.secondaryOverflow);
  if (!overflow) invalid.push(`secondaryOverflow ${JSON.stringify(raw.secondaryOverflow)}`);
  const working =
    raw.workingIndicatorPlacement === undefined
      ? "editor-border"
      : oneOf(["editor-border", "above-powerline"], raw.workingIndicatorPlacement);
  if (!working) invalid.push(`workingIndicatorPlacement ${JSON.stringify(raw.workingIndicatorPlacement)}`);

  const v = isRecord(raw.vibe) ? raw.vibe : {};
  const theme = str(v.theme);
  const strings = (o: unknown) =>
    Object.fromEntries(
      Object.entries(isRecord(o) ? o : {}).filter((e): e is [string, string] => typeof e[1] === "string"),
    );

  return {
    preset: oneOf(PRESET_NAMES, raw.preset) ?? "default",
    customItems: custom,
    disabledSegments,
    layout,
    separator: oneOf(SEPARATORS, raw.separator) ?? null,
    segmentOptions: segmentOptions(raw),
    placement: placement ?? "above",
    padding: num(raw.padding, (n) => Number.isInteger(n) && n >= 0 && n <= 8) ?? 1,
    secondaryOverflow: overflow ?? "drop",
    workingIndicatorPlacement: working ?? "editor-border",
    welcome: raw.welcome !== false,
    sendDelayMs: num(raw.sendDelayMs, (n) => n > 0) ?? 0,
    autoFollowUp: raw.autoFollowUp === true,
    workingVibes: defined({ color: isRecord(raw.workingVibes) ? str(raw.workingVibes.color) : undefined }),
    hiddenExtensionStatusKeys: [
      ...new Set(
        (Array.isArray(raw.hiddenExtensionStatusKeys) ? raw.hiddenExtensionStatusKeys : []).flatMap(
          (k) => str(k) ?? [],
        ),
      ),
    ],
    showLastPrompt: raw.showLastPrompt !== false,
    shortcuts: shortcuts(raw.shortcuts, invalid),
    vibe: {
      theme: theme && theme.toLowerCase() !== "off" ? theme : null,
      mode: oneOf(["generate", "file"], v.mode) ?? "generate",
      model: str(v.model) ?? "auto",
      fallback: typeof v.fallback === "string" ? v.fallback : "Working",
      refreshInterval: (num(v.refreshInterval, () => true) ?? 30) * 1000,
      prompt: typeof v.prompt === "string" ? v.prompt : DEFAULT_VIBE_PROMPT,
      maxLength: Math.max(4, Math.floor(num(v.maxLength, () => true) ?? 65)),
    },
    colors: strings(raw.colors),
    icons: strings(raw.icons),
    invalid,
  };
}

export const configPath = () => join(hortusDir(), "powerline.json");
/** The plugin's own files: stash history, vibes, currency rates. */
export const dataDir = () => join(hortusDir(), "powerline");

export function readRaw(): Raw {
  try {
    const v: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
    return isRecord(v) ? v : typeof v === "string" ? { preset: v } : {};
  } catch {
    return {};
  }
}

/** Applies `patch` to the config file's top level (and to `vibe` when given), keeping everything else. */
export async function saveRaw(patch: Raw, vibe?: Raw): Promise<void> {
  const raw = readRaw();
  const next: Raw = { ...raw, ...patch };
  if (vibe) next.vibe = { ...(isRecord(raw.vibe) ? raw.vibe : {}), ...vibe };
  await mkdir(hortusDir(), { recursive: true });
  // replaced in one rename: a half-written file reads as {}, and the next save would drop everything else
  const tmp = `${configPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, configPath());
}
