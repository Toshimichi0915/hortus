import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type CliPlugin,
  cliOf,
  type EntryView,
  type Suggestion,
  type Theme,
  type ToolRenderer,
  usePluginCtx,
  useStore,
  useUi,
} from "@hortus/cli";
import {
  type Command,
  type Ctx,
  hortusDir,
  listSessions,
  parseSkillMessage,
  readSession,
  toolSchema,
} from "@hortus/core";
import type { ComponentType } from "react";
import { type Config, loadConfig, type Mode, saveConfig } from "./config.ts";
import {
  circledToParens,
  gitStats,
  mentionQuery,
  mentions,
  REFERENCE,
  type RunSummary,
  referenceContent,
  referenceSection,
  SUBAGENT_REFERENCE,
} from "./format.ts";
import {
  AboveInput,
  type AgentInfo,
  ContextView,
  type ContextReport,
  DisplayLine,
  Header,
  PromptSlot,
  ReferenceLine,
  RunSummaryLine,
  type Runtime,
  rt,
  SELF,
  StatusBar,
  Thinking,
  ToolCard,
  TranscriptSlot,
} from "./ui.tsx";

// ── themes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

interface PiTheme {
  name: string;
  vars?: Record<string, string>;
  colors: Record<string, string>;
}

/** hortus tokens Pi names otherwise; Pi's role tokens (`mdHeading`, `thinkingHigh`...) are hortus's too. */
const RENAMED: Record<string, string> = {
  borderIdle: "borderMuted",
  green: "success",
  red: "error",
  yellow: "warning",
  blue: "mdLink",
  thinking: "thinkingText",
  userBackground: "userMessageBg",
  toolRunning: "toolPendingBg",
  toolDone: "toolSuccessBg",
  toolError: "toolErrorBg",
};

/** A Pi theme file (hex colors or `vars` names) as hortus tokens, plus Pi-cc's bright success check. */
export function fromPi(pi: PiTheme): Partial<Theme> {
  const color = (v: string) => (v.startsWith("#") || v === "" ? v : (pi.vars?.[v] ?? v));
  const all: Record<string, string> = { ccToolSuccess: "#50dc64" };
  for (const [k, v] of Object.entries(pi.colors)) all[k] = color(v);
  for (const [k, from] of Object.entries(RENAMED)) if (all[from] !== undefined) all[k] = all[from];
  return all;
}

const themeDir = new URL("../themes/", import.meta.url);
const themes = Object.fromEntries(
  readdirSync(themeDir)
    .filter((f) => f.endsWith(".json"))
    .map((f): PiTheme => JSON.parse(readFileSync(new URL(f, themeDir), "utf8")))
    .map((pi) => [pi.name, fromPi(pi)]),
);

// ── entry renderers ─────────────────────────────────────────────────────────────────────────────────────────────────

type Wrapped = EntryView & { Default: ComponentType<EntryView> };

/** Assistant text after Pi-cc's markdown pass (circled numbers → `(n)`). */
function Assistant({ entry, width, Default }: Wrapped) {
  const r = useRtFromCtx();
  const on = r.config.getState().enableMarkdownEnhance;
  return <Default entry={on ? { ...entry, text: circledToParens(entry.text) } : entry} width={width} />;
}

/** A skill's message as `✓ Skill <name>` (its request with Ctrl+O), like Pi-cc's skill block. */
function User({ entry, width, Default }: Wrapped) {
  const r = useRtFromCtx();
  const skill = entry.message?.role === "user" ? parseSkillMessage(entry.message.content) : undefined;
  if (!skill || r.config.getState().mode === "off") return <Default entry={entry} width={width} />;
  return <DisplayLine title={`Skill ${skill.name}`} body={skill.request ?? ""} />;
}

/** builtin:compaction's summary as `✓ Compacted from N tokens` (the summary with Ctrl+O). */
function Compaction({ entry, width, Default }: Wrapped) {
  const r = useRtFromCtx();
  const session = useUi((s) => s.session);
  if (r.config.getState().mode === "off") return <Default entry={entry} width={width} />;
  const summary = (entry.meta?.details as { summary?: string } | undefined)?.summary ?? "";
  // the summary message's entry is its compaction's
  const saved = session.entries().find((e) => e.id === entry.entryId) as
    | { data?: { tokensBefore?: number } }
    | undefined;
  const before = saved?.data?.tokensBefore;
  return (
    <DisplayLine
      title={before ? `Compacted from ${before.toLocaleString("en-US")} tokens` : "Compacted"}
      body={summary}
    />
  );
}

/** The runtime, its config subscribed (so a /ccstyle change re-renders). */
function useRtFromCtx(): Runtime {
  const r = rt(usePluginCtx());
  useStore(r.config);
  return r;
}

/** Pi-cc's cards draw their own shell (`renderShell: "self"`): no host background or padding. */
const tool: ToolRenderer = {
  Render: ToolCard,
  chrome: () => ({ background: false, padding: false }),
};

// ── commands ────────────────────────────────────────────────────────────────────────────────────────────────────────

const MODES: Mode[] = ["on", "compact", "off"];

async function setConfig(r: Runtime, patch: Partial<Config>) {
  r.config.setState(patch);
  r.saving = r.saving.catch(() => {}).then(() => saveConfig(r.config.getState()));
  await r.saving;
}

const formatStatus = (c: Config) =>
  [
    `mode=${c.mode}`,
    `thinking preview=${c.previewLines}`,
    `edit diff=${c.editDiffCollapsedLines}`,
    `write diff=${c.writeDiffCollapsedLines}`,
    `footer=${c.enableCustomFooter ? "on" : "off"}`,
    `excluded=${c.excludeRenderers.join(",") || "none"}`,
  ].join(" · ");

/** Settings the panel flips (booleans) or cycles through (presets), as Pi-cc's `/ccstyle` panel. */
const PRESETS: Partial<Record<keyof Config, readonly (number | string)[]>> = {
  mode: MODES,
  previewLines: [0, 1, 3, 5, 10],
  editDiffCollapsedLines: [0, 12, 24, 36, 48, 80, 120],
  writeDiffCollapsedLines: [0, 4, 8, 12, 24, 36],
  toolLabelClip: [0, 40, 60, 80, 100, 120, 160],
  animationIntervalMs: [40, 60, 90, 120, 180],
};

async function panel(ctx: Ctx, r: Runtime): Promise<string | undefined> {
  const changed: string[] = [];
  for (;;) {
    const c = r.config.getState();
    const keys = (Object.keys(c) as (keyof Config)[]).filter((k) => typeof c[k] === "boolean" || PRESETS[k]);
    const pick = await ctx.ask({
      question: "Claude Code style settings (Esc closes)",
      options: keys.map((k) => ({
        label: k,
        description: typeof c[k] === "boolean" ? (c[k] ? "on" : "off") : String(c[k]),
      })),
    });
    if (typeof pick !== "string" || !(pick in c)) break;
    const k = pick as keyof Config;
    const v = c[k];
    const presets = PRESETS[k];
    const next = typeof v === "boolean" ? !v : presets?.[(presets.indexOf(v as never) + 1) % presets.length];
    await setConfig(r, { [k]: next } as Partial<Config>);
    changed.push(`${k}=${String(next)}`);
  }
  return changed.length ? `Claude Code style: ${changed.join(", ")}` : undefined;
}

const ccstyle: Command = {
  name: "ccstyle",
  description: "Configure Claude Code style",
  args: "[on|compact|off|status|panel]",
  complete: () => [
    { value: "on", description: "Enable Claude Code style" },
    { value: "compact", description: "One summary line per assistant message" },
    { value: "off", description: "Use hortus's own renderers" },
    { value: "status", description: "Show the configuration" },
    { value: "panel", description: "Pick settings to change" },
  ],
  run: async (arg, ctx) => {
    const r = rt(ctx);
    const a = arg.trim().toLowerCase();
    if (MODES.includes(a as Mode)) {
      await setConfig(r, { mode: a as Mode });
      return `Claude Code style: ${a}`;
    }
    if (a === "status") return `Claude Code style: ${formatStatus(r.config.getState())}`;
    if (!a || a === "panel") {
      if (!ctx.host.interactive) return `Claude Code style: ${formatStatus(r.config.getState())}`;
      return panel(ctx, r);
    }
    throw new Error("Usage: /ccstyle [on|compact|off|status|panel]");
  },
};

const est = (s: string) => Math.ceil(s.length / 4);

/** What fills the context: a preview of the next request, split into system prompt, memory, skills, tools, messages. */
async function contextReport(ctx: Ctx): Promise<ContextReport> {
  const p = await ctx.preview(ctx.session?.getState().messages ?? []);
  const files = p.context.map((f) => ({ label: f.path, tokens: est(f.content) }));
  const skills = (p.skills ?? []).map((s) => ({ label: s.name, tokens: est(`${s.name} ${s.description} ${s.path}`) }));
  const sum = (l: { tokens: number }[]) => l.reduce((n, x) => n + x.tokens, 0);
  let model = `${p.provider}/${p.model}`;
  let window: number | undefined;
  try {
    const res = await ctx.resolve();
    window = res.info.contextWindow;
    model = `${res.provider}/${res.model}`;
  } catch {}
  return {
    model,
    window,
    rows: [
      { label: "System prompt", tokens: Math.max(0, est(p.system) - sum(files) - sum(skills)) },
      { label: "Memory files", tokens: sum(files) },
      { label: "Skills", tokens: sum(skills) },
      {
        label: "Tools",
        tokens: sum(
          p.tools.map((t) => ({
            tokens: est(JSON.stringify({ name: t.name, description: t.description, schema: toolSchema(t) })),
          })),
        ),
      },
      { label: "Messages", tokens: est(JSON.stringify(p.messages)) },
    ],
    files,
    skills,
  };
}

const context: Command = {
  name: "context",
  description: "Show what fills the context window",
  enabled: (ctx) => rt(ctx).config.getState().enableContextCommand,
  run: async (_, ctx) => {
    const r = await contextReport(ctx);
    const used = r.rows.reduce((n, x) => n + x.tokens, 0);
    const text = [
      `Context usage · ${r.model} · ${used}/${r.window ?? "?"} tokens`,
      ...r.rows.map((x) => `${x.label}: ${x.tokens} tokens`),
    ].join("\n");
    // drawn as Pi-cc's colored grid in the TUI; plain text elsewhere
    if (ctx.host.kind !== "tui") return text;
    cliOf(ctx).push({ kind: `${SELF}:context`, text, meta: { plugin: SELF, type: "context", details: r } });
  },
};

const exit: Command = {
  name: "exit",
  description: "→ /quit · Exit hortus",
  enabled: (ctx) => rt(ctx).config.getState().enableAliases,
  run: async (_, ctx) => {
    await ctx.exit();
  },
};

// ── events ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A top-level run's events (not a subrun's; previews are told by `source` where they fire). */
const top = (ctx: Ctx) => ctx.run?.depth === 0;

const run = promisify(execFile);
async function refreshGit(ctx: Ctx) {
  try {
    const opts = { cwd: ctx.cwd, timeout: 5000 };
    const [status, numstat] = await Promise.all([
      run("git", ["status", "--porcelain=v1", "--branch"], opts),
      run("git", ["diff", "--numstat", "HEAD"], opts).catch(() => ({ stdout: "" })),
    ]);
    rt(ctx).live.setState({ git: gitStats(status.stdout, numstat.stdout) });
  } catch {
    rt(ctx).live.setState({ git: undefined });
  }
}

async function refreshSessions(ctx: Ctx) {
  rt(ctx).sessions = await listSessions().catch(() => []);
}

/** `~/.hortus/agents/*.md` (Pi's `~/.pi/agent/agents`): subagent types for `@subagent:[name]`. */
async function loadAgents(): Promise<AgentInfo[]> {
  const dir = join(hortusDir(), "agents");
  const files = await readdir(dir).catch(() => []);
  return Promise.all(
    files
      .filter((f) => f.endsWith(".md"))
      .map(async (f) => {
        const fm: Record<string, string> = {};
        const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(await readFile(join(dir, f), "utf8"))?.[1] ?? "";
        for (const m of head.matchAll(/^(\w+):\s*(.*)$/gm)) fm[m[1] as string] = (m[2] ?? "").trim();
        const name = f.replace(/\.md$/, "");
        return {
          name,
          displayName: fm.display_name || name,
          description: fm.description ?? "",
          model: fm.model,
          thinking: fm.thinking,
        };
      }),
  );
}

const dateText = (d: Date) => d.toISOString().slice(0, 10);

/** `@` completions: subagent types (`@subagent:[name]`) and other sessions (`@session:[id]`), then the default rows. */
const complete: NonNullable<NonNullable<CliPlugin["cli"]>["complete"]> = (input, Default, cli, ctx) => {
  const base = Default(input);
  const q = mentionQuery(input);
  if (q === undefined || q.startsWith("session:")) return base;
  const r = rt(ctx);
  const cfg = r.config.getState();
  const head = input.slice(0, input.length - q.length - 1);
  const rows: Suggestion[] = [];
  const agentQuery = /^subagent:\[?([^\]]*)$/.exec(q)?.[1] ?? q;
  if (cfg.enableSubagentAutocomplete)
    for (const a of r.agents.filter((a) => a.name.includes(agentQuery)).slice(0, 2))
      rows.push({
        label: `[SubAgent] ${a.displayName}`,
        description: `${a.model ?? "?"} · ${a.thinking ?? "?"}`,
        value: `${head}@subagent:[${a.name}] `,
      });
  if (cfg.enableSessionReference && !q.startsWith("subagent:")) {
    const cwd = cli.session.getState().cwd ?? process.cwd();
    const here = (s: { cwd?: string }) => (s.cwd && resolve(s.cwd) === resolve(cwd) ? 1 : 0);
    const others = r.sessions
      .filter((s) => s.id !== cli.session.id && (!q || s.title.toLowerCase().includes(q.toLowerCase())))
      .sort((a, b) => here(b) - here(a) || b.created.getTime() - a.created.getTime());
    for (const s of others.slice(0, 3))
      rows.push({
        label: `[Session] ${s.title || "(no messages)"}`,
        description: `${here(s) ? "current workspace" : s.cwd || "unknown workspace"} · ${dateText(s.created)}`,
        value: `${head}@session:[${s.id}] `,
      });
  }
  return rows.length ? [...rows, ...(base ?? [])] : base;
};

const plugin: CliPlugin = {
  commands: [ccstyle, context, exit],
  on: {
    init: async (_, ctx) => {
      const r = rt(ctx);
      r.config.setState(await loadConfig(), true);
      r.agents = await loadAgents();
      await refreshSessions(ctx);
      void refreshGit(ctx);
    },
    session_open: (_, ctx) => refreshSessions(ctx),
    input: async (p, ctx) => {
      if (p.meta) return;
      const r = rt(ctx);
      const cfg = r.config.getState();
      const ids = cfg.enableSessionReference ? mentions(p.text, REFERENCE) : [];
      if (ids.length) {
        if (ids.some((id) => !r.sessions.some((s) => s.id === id))) await refreshSessions(ctx);
        const found = ids.flatMap((id) => r.sessions.find((s) => s.id === id && s.id !== ctx.session?.id) ?? []);
        if (found.length > 5) await ctx.notify("session-reference: only the first 5 sessions were included", "warn");
        const picked = found.slice(0, 5);
        const sections: string[] = [];
        for (const s of picked)
          try {
            sections.push(referenceSection(s, (await readSession(s.path)).messages));
          } catch (e) {
            await ctx.notify(
              `session-reference: failed to read ${s.id}: ${e instanceof Error ? e.message : e}`,
              "warn",
            );
          }
        if (sections.length)
          void ctx.send(
            {
              content: referenceContent(sections),
              meta: {
                plugin: ctx.plugin,
                type: "session-reference",
                display: true,
                details: { sessions: picked.map((s) => ({ id: s.id, title: s.title, cwd: s.cwd })) },
              },
            },
            { deliver: "context" },
          );
      }
      const names = cfg.enableSubagentAutocomplete
        ? mentions(p.text, SUBAGENT_REFERENCE).filter((n) => r.agents.some((a) => a.name === n))
        : [];
      if (names.length) {
        const list = names.map((n) => `"${n}" (${r.agents.find((a) => a.name === n)?.displayName ?? n})`).join(", ");
        void ctx.send(
          {
            content:
              `The user's prompt references these subagent types: ${list}. You MUST use the subagent tool for EACH ` +
              "mentioned subagent to delegate the relevant parts of the request. Handle different subagents separately — " +
              "do NOT merge their tasks into a single call.",
            meta: { plugin: ctx.plugin, type: "subagent-delegation", display: false },
          },
          { deliver: "context" },
        );
      }
    },
    run_start: (p, ctx) => {
      if (p.source !== "run" || !top(ctx) || !ctx.run) return;
      const r = rt(ctx);
      const now = Date.now();
      r.runs.set(ctx.run.id, {
        start: now,
        commands: 0,
        reads: new Set(),
        edits: new Set(),
        writes: new Set(),
        others: 0,
        failed: 0,
        count: 0,
      });
      r.live.setState({ start: now, first: undefined, output: 0, chars: 0 });
    },
    // the rate's first token and streamed chars
    thinking: (delta, ctx) => {
      if (top(ctx)) rt(ctx).live.setState((s) => ({ first: s.first ?? Date.now(), chars: s.chars + delta.length }));
    },
    text: (delta, ctx) => {
      if (top(ctx)) rt(ctx).live.setState((s) => ({ first: s.first ?? Date.now(), chars: s.chars + delta.length }));
    },
    response: (p, ctx) => {
      if (p.request.source !== "run" || !top(ctx)) return;
      const r = rt(ctx);
      r.live.setState((s) => ({ output: s.output + (p.assistant?.usage?.output ?? 0), chars: 0 }));
    },
    tool_call: async ({ call }, ctx) => {
      if (call.parentId || !top(ctx) || !ctx.run) return;
      const r = rt(ctx);
      r.calls.set(call.id, Date.now());
      const acc = r.runs.get(ctx.run.id);
      const input = (call.input ?? {}) as { path?: unknown; file_path?: unknown };
      const path = typeof (input.path ?? input.file_path) === "string" ? String(input.path ?? input.file_path) : "";
      if (acc) {
        acc.count++;
        const kind = call.name.split(".").pop();
        if (kind === "bash" || kind === "powershell") acc.commands++;
        else if (kind === "read") path && acc.reads.add(path);
        else if (kind === "edit") path && acc.edits.add(path);
        else if (kind === "write") path && acc.writes.add(path);
        else acc.others++;
      }
      // the file as it was, for the write's diff (Pi-cc wraps the write tool for this; a handler sees it first)
      if (call.name === "write" && path)
        r.before.set(call.id, await readFile(resolve(ctx.cwd, path), "utf8").catch(() => undefined));
    },
    tool_result: ({ call, result }, ctx) => {
      if (call.parentId || !top(ctx) || !ctx.run) return;
      const r = rt(ctx);
      r.calls.delete(call.id);
      const acc = r.runs.get(ctx.run.id);
      if (acc && result.isError) acc.failed++;
    },
    run_end: async (p, ctx) => {
      if (p.source !== "run" || !top(ctx) || !ctx.run) return;
      const r = rt(ctx);
      const now = Date.now();
      const { first, output, start } = r.live.getState();
      r.live.setState({
        start: undefined,
        ...(first && output && { rate: output / Math.max(0.001, (now - first) / 1000), ttft: start && first - start }),
      });
      const acc = r.runs.get(ctx.run.id);
      r.runs.delete(ctx.run.id);
      void refreshGit(ctx);
      if (!acc || acc.count < 2 || !r.config.getState().enableAgentSummary) return;
      const data: RunSummary = {
        commands: acc.commands,
        reads: acc.reads.size,
        edits: acc.edits.size,
        writes: acc.writes.size,
        others: acc.others,
        failed: acc.failed,
        durationMs: now - acc.start,
      };
      // as Pi-cc's custom entry; the TUI shows it (live, and on resume) with the renderer of its type
      await ctx.session?.appendEntry(`${ctx.plugin}:agent-summary`, data);
    },
  },
  cli: {
    themes,
    transcript: TranscriptSlot,
    prompt: PromptSlot,
    aboveInput: AboveInput,
    statusBar: StatusBar,
    complete,
    entries: {
      "tool:**": tool,
      thinking: { Render: Thinking },
      assistant: { Render: Assistant },
      user: { Render: User },
      "builtin:compaction:summary": { Render: Compaction },
      header: { Render: Header },
      [`${SELF}:agent-summary`]: { Render: RunSummaryLine },
      [`${SELF}:session-reference`]: { Render: ReferenceLine },
      [`${SELF}:context`]: { Render: ContextView },
    },
  },
};

export default plugin;
