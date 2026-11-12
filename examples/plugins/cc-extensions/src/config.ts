import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hortusDir } from "@hortus/core";

export type Mode = "on" | "compact" | "off";

/** `~/.hortus/cc-extensions.json` (Pi's `~/.pi/agent/pi-cc-extensions.json`): the keys that mean something in hortus. */
export interface Config {
  mode: Mode;
  /** tools keeping their own renderer (case-insensitive) */
  excludeRenderers: string[];
  editDiffCollapsedLines: number;
  writeDiffCollapsedLines: number;
  expandedInputMaxLines: number;
  expandedOutputMaxLines: number;
  /** clip for paths/commands in tool titles; 0 = fit the width */
  toolLabelClip: number;
  useSummaryTitlesAsThinkingTitle: boolean;
  previewLines: number;
  /** null = previewLines */
  completedPreviewLines: number | null;
  animationIntervalMs: number;
  showStartupHeader: boolean;
  enableSessionReference: boolean;
  enableSubagentAutocomplete: boolean;
  enableContextCommand: boolean;
  enableAgentSummary: boolean;
  enableWorkingMessage: boolean;
  enableAliases: boolean;
  enableMarkdownEnhance: boolean;
  enableEditorPrefix: boolean;
  enableCustomFooter: boolean;
  footerTokenRate: boolean;
  footerTokenRateTtft: boolean;
  footerSessionTokens: boolean;
  footerCurrency: string;
  footerCurrencyRate: number | null;
  footerNerdIcons: boolean;
  footerHiddenKeys: string[];
  footerLine1Keys: string[];
  footerLine2Keys: string[];
  footerLine3Keys: string[];
}

export const DEFAULTS: Config = {
  mode: "on",
  excludeRenderers: [],
  editDiffCollapsedLines: 24,
  writeDiffCollapsedLines: 0,
  expandedInputMaxLines: 5,
  expandedOutputMaxLines: 10,
  toolLabelClip: 0,
  useSummaryTitlesAsThinkingTitle: true,
  previewLines: 3,
  completedPreviewLines: null,
  animationIntervalMs: 90,
  showStartupHeader: true,
  enableSessionReference: true,
  enableSubagentAutocomplete: true,
  enableContextCommand: true,
  enableAgentSummary: true,
  enableWorkingMessage: true,
  enableAliases: true,
  enableMarkdownEnhance: true,
  enableEditorPrefix: true,
  enableCustomFooter: true,
  footerTokenRate: true,
  footerTokenRateTtft: true,
  footerSessionTokens: false,
  footerCurrency: "USD",
  footerCurrencyRate: null,
  footerNerdIcons: true,
  footerHiddenKeys: [],
  footerLine1Keys: ["model", "context", "cache", "rate", "cost", "tokens"],
  footerLine2Keys: ["cwd", "git"],
  footerLine3Keys: [],
};

export const configPath = () => join(hortusDir(), "cc-extensions.json");

/** The file over the defaults; values of the wrong type are dropped (a hand-edited file can't break rendering). */
export async function loadConfig(): Promise<Config> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(configPath(), "utf8"));
  } catch {}
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    const d = (DEFAULTS as unknown as Record<string, unknown>)[k];
    if (!(k in DEFAULTS)) continue;
    if (k === "completedPreviewLines" || k === "footerCurrencyRate") {
      if (v === null || typeof v === "number") out[k] = v;
    } else if (Array.isArray(d) ? Array.isArray(v) && v.every((x) => typeof x === "string") : typeof v === typeof d)
      out[k] = v;
  }
  if (!["on", "compact", "off"].includes(out.mode as string)) out.mode = "on";
  return out as unknown as Config;
}

/** Writes the whole config by rename, so a reader never sees half of it. */
export async function saveConfig(config: Config): Promise<void> {
  await mkdir(hortusDir(), { recursive: true });
  const tmp = `${configPath()}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`);
  await rename(tmp, configPath());
}
