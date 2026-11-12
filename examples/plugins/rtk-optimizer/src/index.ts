import { dirname } from "node:path";
import { stripVTControlCharacters as stripAnsiFast } from "node:util";
import { clearMetrics, compactToolOutput, metricsSummary } from "./compactor.ts";
import type { Plugin } from "@hortus/core";
import { configPath, DEFAULT_CONFIG, loadConfig, type RtkConfig, saveConfig } from "./config.ts";
import { applyRtkCommandEnvironment, checkRuntime, computeRewriteDecision, type RuntimeStatus } from "./rewrite.ts";

const NOTE =
  "RTK note: If file edits repeatedly fail because old text does not match, ask the user to run '/rtk' and disable read compaction (`outputCompaction.readCompaction.enabled` in ~/.hortus/rtk-optimizer.json), re-read the file, apply the edit, then ask them to re-enable it.";
const USAGE = "Usage: /rtk [show|path|verify|stats|clear-stats|reset|help]";
const SUBCOMMANDS = {
  show: "Show current RTK config + runtime summary",
  path: "Show RTK config file path",
  verify: "Check whether rtk binary is available",
  stats: "Show output compaction metrics",
  "clear-stats": "Clear output compaction metrics",
  reset: "Reset RTK settings to defaults",
  help: "Show usage help",
};

// ponytail: module state, shared by every agent in the process (Pi's lives per extension instance); key it by agent
// (a WeakMap on the host ctx's session, say) if one process ever hosts two configured differently
let config: RtkConfig = DEFAULT_CONFIG;
let status: RuntimeStatus = { rtkAvailable: false };
/** directories of each running run's skills, for `preserveExactSkillReads` */
const skillDirs = new Map<string, string[]>();

const refreshStatus = async () => {
  status = await checkRuntime();
  return status;
};

/** `rtk` is checked again after 30s, only when its absence matters (`guardWhenRtkMissing`). */
async function ensureStatusFresh() {
  if (config.guardWhenRtkMissing && Date.now() - (status.lastCheckedAt ?? 0) > 30_000) await refreshStatus();
}

/** Strips ANSI codes from a progress/details value: a string, or an object's top-level strings. */
function sanitizeDetails(details: unknown): unknown {
  if (typeof details === "string") return stripAnsiFast(details);
  if (!details || typeof details !== "object" || Array.isArray(details)) return details;
  return Object.fromEntries(Object.entries(details).map(([k, v]) => [k, typeof v === "string" ? stripAnsiFast(v) : v]));
}

// suggestions and warnings already shown, so each shows once per process
const shown = new Set<string>();
const once = (key: string) => !shown.has(key) && !!shown.add(key);

/** Settings `/rtk` alone offers to flip (Pi's settings modal), each with how it reads now. */
const TOGGLES: { label: string; get: () => string; flip: () => void }[] = [
  {
    label: "enabled",
    get: () => String(config.enabled),
    flip: () => {
      config.enabled = !config.enabled;
    },
  },
  {
    label: "mode",
    get: () => config.mode,
    flip: () => {
      config.mode = config.mode === "rewrite" ? "suggest" : "rewrite";
    },
  },
  {
    label: "guardWhenRtkMissing",
    get: () => String(config.guardWhenRtkMissing),
    flip: () => {
      config.guardWhenRtkMissing = !config.guardWhenRtkMissing;
    },
  },
  {
    label: "showRewriteNotifications",
    get: () => String(config.showRewriteNotifications),
    flip: () => {
      config.showRewriteNotifications = !config.showRewriteNotifications;
    },
  },
  {
    label: "outputCompaction",
    get: () => String(config.outputCompaction.enabled),
    flip: () => {
      config.outputCompaction.enabled = !config.outputCompaction.enabled;
    },
  },
];

const summary = () => {
  const c = config.outputCompaction;
  const runtime = status.rtkAvailable
    ? "rtk=available"
    : `rtk=missing${status.lastError ? ` (${status.lastError})` : ""}`;
  const path = status.executable?.resolvedPath
    ? `, rtkPath=${status.executable.resolvedPath}`
    : status.executable?.warning
      ? `, rtkPath=unresolved (${status.executable.warning})`
      : "";
  return `enabled=${config.enabled}, mode=${config.mode}, rewriteSource=rtk, rewriteNotice=${config.showRewriteNotifications}, compaction=${c.enabled}, readCompaction=${c.readCompaction.enabled}, sourceFilterEnabled=${c.sourceCodeFilteringEnabled}, preserveSkillReads=${c.preserveExactSkillReads}, sourceFilter=${c.sourceCodeFiltering}, ${runtime}${path}`;
};

/**
 * pi-rtk-optimizer: rewrites `bash` commands to their `rtk` equivalents (as `rtk rewrite` decides, for execution only:
 * the model and the session keep its command) and compacts noisy `bash`/`read`/`grep` output before the model sees it.
 * Ported from pi-rtk-optimizer (MIT License, Copyright (c) 2026 MasuRii); `techniques/` are its files, lightly adapted.
 */
export default {
  on: {
    // loaded at start and again whenever the session changes, as Pi does on session_start; `/rtk` reloads it too
    init: () => {
      config = loadConfig().config;
    },
    session_open: () => {
      config = loadConfig().config;
    },
    run_start: async ({ skills }, ctx) => {
      if (ctx.run)
        skillDirs.set(
          ctx.run.id,
          (skills ?? []).map((s) => dirname(s.path)),
        );
      await ensureStatusFresh();
    },
    run_end: (_, ctx) => {
      if (ctx.run) skillDirs.delete(ctx.run.id);
    },
    prompt: ({ system }) => {
      const c = config.outputCompaction;
      if (
        config.enabled &&
        c.enabled &&
        c.readCompaction.enabled &&
        c.sourceCodeFilteringEnabled &&
        c.sourceCodeFiltering !== "none" &&
        (c.smartTruncate.enabled || c.truncate.enabled)
      )
        system.push(NOTE);
    },
    tool_call: async ({ call, result }, ctx) => {
      if (!config.enabled || result || call.name !== "bash") return;
      // a copy: the rewrite applies to execution only
      const input = call.input as { command?: unknown } | null;
      if (typeof input?.command !== "string") return;
      await ensureStatusFresh();
      if (config.guardWhenRtkMissing && !status.rtkAvailable) return;
      const decision = await computeRewriteDecision(input.command, status.executable, ctx.signal);
      const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
      if (!decision.changed) {
        if (decision.warning && once(`warn:${decision.warning}`))
          await ctx.notify(`RTK rewrite skipped for ${cut(input.command, 100)}: ${decision.warning}`, "warn");
      } else if (config.mode === "rewrite") {
        if (config.showRewriteNotifications)
          await ctx.notify(`RTK rewrite: ${cut(input.command, 100)} -> ${cut(decision.rewrittenCommand, 120)}`);
        input.command = applyRtkCommandEnvironment(decision.rewrittenCommand);
      } else if (once(`${input.command}:${decision.rewrittenCommand}`))
        await ctx.notify(`RTK suggestion: ${decision.rewrittenCommand}`);
    },
    tool_update: (p) => {
      // progress (builtin:bash's live output) is only shown, never sent: strip the colour codes rtk's tools print; the
      // last update's details are saved as they are left here
      if (p.call.name === "bash" && config.enabled && config.outputCompaction.enabled)
        p.details = sanitizeDetails(p.details);
    },
    tool_result: (p, ctx) => {
      const { call, result } = p;
      if (!config.enabled || !config.outputCompaction.enabled) return;
      const dirs = (ctx.run && skillDirs.get(ctx.run.id)) ?? [];
      const compacted = compactToolOutput(call.name, call.input, result.output, config, dirs);
      if (!compacted) return;
      const base = result.details && typeof result.details === "object" && !Array.isArray(result.details);
      const details = base ? (result.details as Record<string, unknown>) : {};
      const metadata = details.metadata && typeof details.metadata === "object" ? details.metadata : {};
      p.result = {
        ...result,
        output: compacted.text,
        details: {
          ...details,
          rtkCompaction: compacted.metadata,
          metadata: { ...metadata, rtkCompaction: compacted.metadata },
          ...(!base && result.details !== undefined && { rawDetails: result.details }),
        },
      };
    },
  },
  commands: [
    {
      name: "rtk",
      args: "[show|path|verify|stats|clear-stats|reset|help]",
      description: "RTK rewrite and output compaction integration",
      complete: () => Object.entries(SUBCOMMANDS).map(([value, description]) => ({ value, description })),
      // `/rtk` alone is Pi's settings modal: pick a setting to flip (where someone can answer), else the summary
      run: async (arg, ctx) => {
        const loaded = loadConfig();
        config = loaded.config;
        if (loaded.warning) throw new Error(loaded.warning);
        switch (arg.trim().toLowerCase()) {
          case "": {
            if (!ctx.host.interactive) return `rtk: ${summary()}`;
            const pick = await ctx.ask({
              question: "RTK settings: pick one to change",
              options: TOGGLES.map((t) => ({ label: t.label, description: t.get() })),
            });
            const toggle = TOGGLES.find((t) => t.label === pick);
            if (!toggle) return `rtk: ${summary()}`;
            toggle.flip();
            saveConfig(config);
            return `rtk ${toggle.label}=${toggle.get()}`;
          }
          case "show":
            return `rtk: ${summary()}`;
          case "help":
            return USAGE;
          case "path":
            return `rtk config: ${configPath()}`;
          case "verify": {
            const s = await refreshStatus();
            if (s.rtkAvailable)
              return `RTK binary is available${s.executable?.resolvedPath ? ` at ${s.executable.resolvedPath}` : ""}.`;
            throw new Error(`RTK binary is not available${s.lastError ? `: ${s.lastError}` : ""}.`);
          }
          case "stats":
            return metricsSummary();
          case "clear-stats":
            clearMetrics();
            return "RTK metrics cleared.";
          case "reset":
            config = structuredClone(DEFAULT_CONFIG);
            saveConfig(config);
            return "RTK integration settings reset to defaults.";
          default:
            throw new Error(USAGE);
        }
      },
    },
  ],
} satisfies Plugin;
