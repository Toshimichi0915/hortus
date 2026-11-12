import { basename } from "node:path";
import {
  cliOf,
  createStore,
  type EntryView,
  type StoreApi,
  type Slots,
  type ToolSibling,
  type ToolView,
  useStore,
  useTheme,
  usePluginCtx,
  useSession,
  useBorderColor,
  useUi,
} from "@hortus/cli";
import { type Ctx, type SessionInfo, stateOf, type ToolCall, type ToolResult } from "@hortus/core";
import { Box, Text, useInput } from "ink";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { type Config, DEFAULTS } from "./config.ts";
import {
  collapsedSummary,
  type DiffLine,
  duration,
  editDiff,
  expandable,
  inputBody,
  resultText,
  type RunSummary,
  stats,
  summarize,
  summaryParts,
  thinkingTitle,
  tokens,
  toolDuration,
  writeDiff,
} from "./format.ts";

/** Pi's names for the entry kinds this plugin pushes or sends (`cli.entries` keys are fixed: install it as "cc-extensions"). */
export const SELF = "cc-extensions";

export interface Live {
  /** the running turn's start, while one runs */
  start?: number;
  /** its first streamed token */
  first?: number;
  /** output tokens the turn's replies reported */
  output: number;
  /** chars streamed since the last reply, estimated at 4 a token */
  chars: number;
  /** the last turn's average output rate (tok/s) and time to first token */
  rate?: number;
  ttft?: number;
  git?: { branch?: string; status: string; add: number; del: number };
}

export interface AgentInfo {
  name: string;
  displayName: string;
  description: string;
  model?: string;
  thinking?: string;
}

/** Per-agent state (`ctx.state`), shared by handlers, commands and components (`usePluginCtx`). */
export interface Runtime {
  config: StoreApi<Config>;
  live: StoreApi<Live>;
  /** top-level tool calls' start times, while they run (finished ones have `durationMs`) */
  calls: Map<string, number>;
  /** a write's file as it was before (undefined: it didn't exist), by call id */
  before: Map<string, string | undefined>;
  /** per run: its tool counts */
  runs: Map<
    string,
    {
      start: number;
      commands: number;
      reads: Set<string>;
      edits: Set<string>;
      writes: Set<string>;
      others: number;
      failed: number;
      count: number;
    }
  >;
  sessions: SessionInfo[];
  agents: AgentInfo[];
  /** config.json saves, one after another (the last one set wins) */
  saving: Promise<void>;
}

export function rt(ctx: Ctx): Runtime {
  return stateOf(
    ctx,
    "rt",
    (): Runtime => ({
      config: createStore<Config>()(() => DEFAULTS),
      live: createStore<Live>()(() => ({ output: 0, chars: 0 })),
      calls: new Map(),
      before: new Map(),
      runs: new Map(),
      sessions: [],
      agents: [],
      saving: Promise.resolve(),
    }),
  );
}

const useRt = () => rt(usePluginCtx());
const useConfig = () => useStore(useRt().config);

/** Re-renders every `ms` while `on`, for spinners and clocks. */
function useTick(on: boolean, ms = 80) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [on, ms]);
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const spinner = () => FRAMES[Math.floor(Date.now() / 80) % FRAMES.length] as string;
const HINT = "ctrl+o to show more";

/** Pi-cc's bright success check (its own token, so a theme can recolor it). */
const okColor = (t: Record<string, string>) => t.ccToolSuccess || t.green;

type Status = "pending" | "success" | "error";
const statusOf = (result?: ToolResult): Status => (!result ? "pending" : result.isError ? "error" : "success");

function Icon({ status }: { status: Status }) {
  const t = useTheme();
  if (status === "pending") return <Text color={t.dim}>{spinner()}</Text>;
  return status === "error" ? <Text color={t.red}>✗</Text> : <Text color={okColor(t)}>✓</Text>;
}

/** `Title payload detail`, one row, cut at the width. */
function Headline({ call, extra }: { call: ToolCall; extra?: ReactNode }) {
  const t = useTheme();
  const cfg = useConfig();
  const cwd = useSession((s) => s.cwd);
  const s = summarize(call.name, call.input, cwd ?? process.cwd(), cfg.toolLabelClip);
  return (
    <Text wrap="truncate-end">
      <Text color={t.toolTitle}>{s.title}</Text>
      {s.payload && <Text color={t.muted}> {s.payload}</Text>}
      {s.detail && <Text color={t.dim}>{s.detail}</Text>}
      {extra}
    </Text>
  );
}

const Changes = ({ added, removed }: { added: number; removed: number }) => {
  const t = useTheme();
  return (
    <Text>
      {" "}
      <Text color={t.dim}>(</Text>
      <Text color={t.green}>+{added}</Text> <Text color={t.red}>-{removed}</Text>
      <Text color={t.dim}>)</Text>
    </Text>
  );
};

/** A diff, one row a line; `max` rows at most, then how many more. */
function Diff({ lines, max, indent = "" }: { lines: DiffLine[]; max?: number; indent?: string }) {
  const t = useTheme();
  const shown = max === undefined ? lines : lines.slice(0, max);
  const color = (op: DiffLine["op"]) =>
    op === "+" ? t.toolDiffAdded : op === "-" ? t.toolDiffRemoved : t.toolDiffContext;
  return (
    <>
      {shown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
        <Text key={i} color={color(l.op)}>
          {indent}
          {l.op} {l.text}
        </Text>
      ))}
      {shown.length < lines.length && (
        <Text color={t.dim}>
          {indent}… {lines.length - shown.length} more lines · {HINT}
        </Text>
      )}
    </>
  );
}

/** The expanded card's body: `├ Input` (rail) then `└ Output`, as Pi-cc's ExpandedToolIoView (uncapped: Ctrl+O is its transcript mode). */
function InputOutput({ call, result, footer }: { call: ToolCall; result?: ToolResult; footer?: string }) {
  const t = useTheme();
  const input = inputBody(call.input);
  const out = result ? resultText(result).replace(/\t/g, "   ").replace(/\n+$/, "") : "Pending…";
  const body = result?.isError ? t.red : t.toolOutput;
  const head = (corner: string, label: string) => (
    <Text>
      <Text color={t.dim}>{corner} </Text>
      <Text color={t.accent} bold>
        {label}
      </Text>
    </Text>
  );
  return (
    <Box flexDirection="column">
      {input.trim() && (
        <>
          {head("├", "Input")}
          {input.split("\n").map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            <Box key={i}>
              <Text color={t.dim}>│ </Text>
              <Text color={t.muted}>{l}</Text>
            </Box>
          ))}
          <Text color={t.dim}>│</Text>
        </>
      )}
      {head("└", "Output")}
      {(out.trim() ? out : "(empty)").split("\n").map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
        <Box key={i} paddingLeft={2}>
          <Text color={out.trim() ? body : t.dim}>{l}</Text>
        </Box>
      ))}
      {footer && (
        <Box paddingLeft={2}>
          <Text color={t.muted}>{footer}</Text>
        </Box>
      )}
    </Box>
  );
}

const SHELL = new Set(["bash", "powershell", "sh", "zsh"]);

/** A call's elapsed time: its result's `durationMs` (core's), else running since its tool_call (until now). */
function elapsed(r: Runtime, call: ToolCall, result?: ToolResult) {
  if (result?.durationMs !== undefined) return toolDuration(result.durationMs);
  const start = r.calls.get(call.id);
  return start === undefined || result ? undefined : toolDuration(Date.now() - start);
}

interface CodemodeCall {
  tool: string;
  status: "running" | "done" | "error";
}

/** One Claude Code-style card: `✓ Title payload`, then `↳ summary` (collapsed) or the whole call (Ctrl+O). */
function Card({ view }: { view: ToolView }) {
  const t = useTheme();
  const r = useRt();
  const cfg = useConfig();
  const { call, result, expanded, details } = view;
  const status = statusOf(result);
  useTick(status === "pending");
  const name = call.name;
  const time = SHELL.has(name) ? elapsed(r, call, result) : undefined;
  const row = (children: ReactNode, color = t.muted) => (
    <Text color={color} wrap="truncate-end">
      {"   ↳ "}
      {children}
    </Text>
  );
  const hint = (show: boolean) => show && <Text color={t.dim}> · {HINT}</Text>;

  // edit/write: their diff, from the input (and, for a write, the file as it was)
  if ((name === "edit" || name === "write") && status === "success") {
    const isWrite = name === "write";
    const content = String((call.input as { content?: unknown })?.content ?? "");
    const prior = r.before.get(call.id);
    const diff = isWrite ? writeDiff(content, prior) : editDiff(call.input);
    const s = stats(diff);
    const inBody = isWrite && !expanded && cfg.writeDiffCollapsedLines === 0;
    return (
      <Box flexDirection="column">
        <Box>
          <Icon status={status} />
          <Text> </Text>
          <Headline call={call} extra={isWrite && !inBody && <Changes {...s} />} />
        </Box>
        {expanded ? (
          <Diff lines={diff} indent="  " />
        ) : inBody ? (
          row(
            <>
              diff <Text color={t.green}>+{s.added}</Text> <Text color={t.red}>-{s.removed}</Text>
              {r.before.has(call.id) && prior !== undefined ? " · overwritten" : " · created"}
              {hint(true)}
            </>,
          )
        ) : (
          <>
            {row(
              <>
                diff <Text color={t.green}>+{s.added}</Text> <Text color={t.red}>-{s.removed}</Text>
              </>,
            )}
            <Diff
              lines={diff}
              max={isWrite ? cfg.writeDiffCollapsedLines : cfg.editDiffCollapsedLines}
              indent="     "
            />
          </>
        )}
      </Box>
    );
  }

  let body: ReactNode;
  if (expanded) body = <InputOutput call={call} result={result} footer={time} />;
  else if (name === "codemode" && Array.isArray((details as { calls?: unknown })?.calls)) {
    const calls = (details as { calls: CodemodeCall[] }).calls;
    body = (
      <Box flexDirection="column">
        {row(
          <>
            {calls.length} {calls.length === 1 ? "call" : "calls"}
            {result && ` · ${collapsedSummary(name, result)}`}
            {hint(true)}
          </>,
        )}
        {calls.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: calls are positional
          <Text key={i} wrap="truncate-end">
            <Text color={t.dim}>{`     ${i === calls.length - 1 ? "└" : "├"} `}</Text>
            <Icon status={c.status === "running" ? "pending" : c.status === "error" ? "error" : "success"} />
            <Text color={t.toolTitle}> {c.tool}</Text>
          </Text>
        ))}
      </Box>
    );
  } else if (!result)
    body = row(
      <>
        Pending…{time && ` · ${time}`}
        {hint(true)}
      </>,
    );
  else
    body = row(
      <>
        {collapsedSummary(name, result)}
        {time && <Text color={t.dim}> · {time}</Text>}
        {hint(expandable(call.input, result))}
      </>,
      result.isError ? t.red : t.muted,
    );
  return (
    <Box flexDirection="column">
      <Box>
        <Icon status={status} />
        <Text> </Text>
        <Headline call={call} />
      </Box>
      {body}
    </Box>
  );
}

const GROUPABLE = (c: ToolCall) => c.name !== "edit" && c.name !== "write";

/** This call's message's calls (it and its siblings), in order. */
const batchOf = (view: ToolView): ToolSibling[] => view.siblings ?? [{ call: view.call, result: view.result }];

/** `Read×2, Bash×1`: each title once, in first-seen order. */
const counts = (calls: ToolCall[]) => {
  const n = new Map<string, number>();
  for (const c of calls) {
    const title = summarize(c.name, {}).title;
    n.set(title, (n.get(title) ?? 0) + 1);
  }
  return [...n].map(([title, k]) => `${title}×${k}`).join(", ");
};

/** Pi-cc's tool group (mode "on"): several calls of one message in one card, one row each. */
function Group({ members }: { members: ToolSibling[] }) {
  const t = useTheme();
  const r = useRt();
  const statuses = members.map((m) => statusOf(m.result));
  const status: Status = statuses.includes("error") ? "error" : statuses.includes("pending") ? "pending" : "success";
  useTick(status === "pending");
  const tally = (["pending", "success", "error"] as const)
    .map((k) => [k, statuses.filter((s) => s === k).length] as const)
    .filter(([, n]) => n);
  const label = { pending: "running", success: "done", error: "failed" };
  const color = { pending: t.dim, success: t.green, error: t.red };
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Icon status={status} />
        <Text color={t.toolTitle}> {counts(members.map((m) => m.call))}</Text>
        {tally.map(([k, n], i) => (
          <Text key={k}>
            <Text color={t.dim}>{i ? " · " : "  "}</Text>
            <Text color={color[k]}>{n}</Text>
            <Text color={t.muted}> {label[k]}</Text>
          </Text>
        ))}
      </Text>
      {members.map((m, i) => {
        const time = SHELL.has(m.call.name) && m.result ? elapsed(r, m.call, m.result) : undefined;
        return (
          <Box key={m.call.id}>
            <Text color={t.dim}> {i === members.length - 1 ? "└" : "├"} </Text>
            <Icon status={statusOf(m.result)} />
            <Text> </Text>
            <Headline call={m.call} extra={time && <Text color={t.dim}> · {time}</Text>} />
          </Box>
        );
      })}
    </Box>
  );
}

/** Compact mode: one line for a message's calls (`Ran for 8s · Bash×2, Read×1`); edit/write keep their title line. */
function Compact({ members }: { members: ToolSibling[] }) {
  const t = useTheme();
  const r = useRt();
  const running = members.some((m) => !m.result);
  useTick(running);
  // running: since the first started; done: the longest (a message's calls run in parallel)
  const starts = members.flatMap((m) => r.calls.get(m.call.id) ?? []);
  const durations = members.flatMap((m) => (m.result?.durationMs !== undefined ? [m.result.durationMs] : []));
  const took = running
    ? starts.length
      ? duration(Date.now() - Math.min(...starts))
      : ""
    : durations.length
      ? duration(Math.max(...durations))
      : "";
  const failed = members.filter((m) => m.result?.isError).length;
  return (
    <Text wrap="truncate-end">
      <Icon status={running ? "pending" : failed ? "error" : "success"} />
      <Text color={t.muted}>
        {" "}
        {running ? "Running..." : took ? `Ran for ${took}` : "Ran"}, {counts(members.map((m) => m.call))}
      </Text>
      {failed > 0 && <Text color={t.red}> · {failed} failed</Text>}
      <Text color={t.dim}> · {HINT}</Text>
    </Text>
  );
}

/** Every tool's block (`tool:*` and the built-ins'): Pi-cc's card, group or compact line by `mode`. */
export function ToolCard(props: ToolView & { Default: ComponentType<ToolView> }) {
  const { Default, ...view } = props;
  const cfg = useConfig();
  const batch = batchOf(view);
  const off = cfg.mode === "off" || cfg.excludeRenderers.some((n) => n.toLowerCase() === view.call.name.toLowerCase());
  if (off) return <Default {...view} />;
  if (!view.expanded) {
    const members = batch.filter((e) => GROUPABLE(e.call));
    const self = GROUPABLE(view.call);
    if (cfg.mode === "compact") {
      if (!self) return <EditTitle view={view} />;
      // the first of the message's calls draws the line, the others nothing (no rows: see "a block that draws nothing")
      return members[0]?.call.id === view.call.id ? <Compact members={members} /> : null;
    }
    if (self && members.length > 1) return members[0]?.call.id === view.call.id ? <Group members={members} /> : null;
  }
  return <Card view={view} />;
}

/** Compact mode's edit/write row: the title with its change counts. */
function EditTitle({ view }: { view: ToolView }) {
  const r = useRt();
  const { call, result } = view;
  const content = String((call.input as { content?: unknown })?.content ?? "");
  const s = stats(call.name === "write" ? writeDiff(content, r.before.get(call.id)) : editDiff(call.input));
  useTick(!result);
  return (
    <Box>
      <Icon status={statusOf(result)} />
      <Text> </Text>
      <Headline call={call} extra={result && !result.isError && <Changes {...s} />} />
    </Box>
  );
}

/** Thinking (Pi-cc's compact thinking): a status heading and the last lines, all of it with Ctrl+O. */
export function Thinking({ entry, width, Default }: EntryView & { Default: ComponentType<EntryView> }) {
  const t = useTheme();
  const cfg = useConfig();
  const expanded = useUi((s) => s.expanded);
  const active = !!entry.live;
  useTick(active, cfg.animationIntervalMs);
  if (cfg.mode === "off") return <Default entry={entry} width={width} />;
  const titled = cfg.useSummaryTitlesAsThinkingTitle ? thinkingTitle(entry.text) : undefined;
  const source = (titled?.body ?? entry.text).trim();
  const all = source ? source.split("\n") : [];
  const n = active ? cfg.previewLines : (cfg.completedPreviewLines ?? cfg.previewLines);
  const shown = expanded ? all : n > 0 ? all.slice(-n) : [];
  const hidden = all.length - shown.length;
  const { startedAt, endedAt } = entry;
  const took = startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined;
  const since = active && startedAt !== undefined ? duration(Date.now() - startedAt) : "";
  const label = active
    ? (titled?.title ?? "Thinking...")
    : took !== undefined
      ? `Thought for ${duration(took) || "1s"}`
      : (titled?.title ?? "Thought");
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        {active ? (
          <Shimmer text={label} bold={!!titled} />
        ) : (
          <Text color={t.dim} italic>
            {label}
          </Text>
        )}
        {since && (
          <Text color={t.dim} italic>
            {" "}
            · {since}
          </Text>
        )}
        {hidden > 0 && <Text color={t.dim}> · {HINT}</Text>}
      </Text>
      {shown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
        <Text key={i} color={t.dim} italic>
          {l || " "}
        </Text>
      ))}
    </Box>
  );
}

/** Pi-cc's sweep over an active heading: a few characters lit at a time. */
function Shimmer({ text, bold }: { text: string; bold: boolean }) {
  const t = useTheme();
  const chars = [...text];
  const w = Math.max(1, Math.min(5, Math.ceil(chars.length * 0.28)));
  const frame = Math.floor(Date.now() / 90);
  const start = (frame % (chars.length + w)) - w;
  const cut = (a: number, b: number) => chars.slice(Math.max(0, a), Math.max(0, b)).join("");
  return (
    <Text italic bold={bold}>
      <Text color={t.dim}>{cut(0, start)}</Text>
      <Text color={t.text} bold>
        {cut(start, start + w)}
      </Text>
      <Text color={t.dim}>{cut(start + w, chars.length)}</Text>
    </Text>
  );
}

/** A `✓ Title · hint` line, and with Ctrl+O its body: Pi-cc's message display (skills, compaction summaries). */
export function DisplayLine({ title, body }: { title: string; body: string }) {
  const t = useTheme();
  const expanded = useUi((s) => s.expanded);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={okColor(t)}>✓</Text>
        <Text color={t.toolTitle}> {title}</Text>
        {!expanded && body.trim() && <Text color={t.dim}> · {HINT}</Text>}
      </Text>
      {expanded && body.trim() && <Text color={t.muted}>{body.trim()}</Text>}
    </Box>
  );
}

const LOGO = ["██████  ", "██  ██  ", "████  ██", "██    ██", "        "];

/** `#rrggbb` lightened (+) or darkened (-) by `f`. */
const shade = (hex: string, f: number) => {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const out = c.map((v) => Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

/** The startup header (Pi-cc's), heading every session's transcript: the logo in an accent gradient, hortus's keys, and the hero line. */
export function Header({ width }: EntryView) {
  const t = useTheme();
  const cfg = useConfig();
  if (!cfg.showStartupHeader) return null;
  const tips = [
    <Text key="v">
      <Text color={t.accent} bold>
        hortus
      </Text>
      <Text color={t.dim}> · Claude Code style</Text>
    </Text>,
    <Text key="k">
      {[
        ["esc", "interrupt"],
        ["ctrl+c/ctrl+d", "clear/exit"],
        ["/", "commands"],
        ["@", "sessions"],
        ["ctrl+o", "more"],
      ].map(([k, d], i) => (
        <Text key={k}>
          {i > 0 && <Text color={t.muted}> · </Text>}
          <Text color={t.dim}>{k}</Text>
          <Text color={t.muted}> {d}</Text>
        </Text>
      ))}
    </Text>,
    <Text key="h" color={t.dim}>
      /ccstyle sets the style, /context shows what fills the context.
    </Text>,
    <Text key="b"> </Text>,
    <Text key="y">
      <Text color={t.accent}>There are many agent harnesses, but this one is </Text>
      <Text color={t.mdLink} bold>
        yours
      </Text>
      <Text color={t.accent}>.</Text>
    </Text>,
  ];
  const logo = LOGO.map((line, row) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
    <Text key={row}>
      {[...line].map((ch, col) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
        <Text key={col} color={shade(t.accent, -0.18 * Math.cos((col / 8 + row * 0.08) * Math.PI * 0.5))}>
          {ch}
        </Text>
      ))}
    </Text>
  ));
  if (width < 48)
    return (
      <Box flexDirection="column" alignItems="center">
        {logo}
        {tips[4]}
      </Box>
    );
  return (
    <Box>
      <Box flexDirection="column" width={10}>
        {logo}
      </Box>
      <Box flexDirection="column">{tips}</Box>
    </Box>
  );
}

/** The run summary line: ` │ Ran 2 commands, read 1 file · 15s`, numbers green (red: failures). */
export function RunSummaryLine({ entry }: EntryView) {
  const t = useTheme();
  const data = entry.data as RunSummary | undefined;
  if (!data) return null;
  const parts = summaryParts(data);
  const took = duration(data.durationMs);
  return (
    <Text>
      <Text color={t.mdQuoteBorder}> │ </Text>
      {parts.map((p, i) => {
        const m = /(\d+)/.exec(p.text);
        const at = m?.index ?? 0;
        return (
          <Text key={p.text} italic color={t.mdQuote}>
            {i > 0 && ", "}
            {m ? p.text.slice(0, at) : p.text}
            {m && <Text color={p.failed ? t.red : t.green}>{m[1]}</Text>}
            {m && p.text.slice(at + (m[1]?.length ?? 0))}
          </Text>
        );
      })}
      {took && (
        <Text italic color={t.mdQuote}>
          {" "}
          · {took}
        </Text>
      )}
    </Text>
  );
}

/** `Referenced 1 session` and the titles. */
export function ReferenceLine({ entry }: EntryView) {
  const t = useTheme();
  const sessions = (entry.meta?.details as { sessions?: { title: string }[] } | undefined)?.sessions ?? [];
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text color={t.accent}>
        Referenced {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
      </Text>
      {sessions.length > 0 && <Text color={t.dim}>{sessions.map((s) => s.title).join(", ")}</Text>}
    </Box>
  );
}

export interface ContextReport {
  model: string;
  window?: number;
  rows: { label: string; tokens: number }[];
  files: { label: string; tokens: number }[];
  skills: { label: string; tokens: number }[];
}

/** `/context`: a 10×N grid of the window, then each category (Claude Code's look). */
export function ContextView({ entry }: EntryView) {
  const t = useTheme();
  const r = entry.meta?.details as ContextReport | undefined;
  if (!r) return null;
  const used = r.rows.reduce((n, x) => n + x.tokens, 0);
  const total = r.window ?? used;
  // shares of the window; none without one
  const palette = [t.muted, t.blue, t.yellow, t.accent, t.green];
  const pct = (n: number) => (r.window ? ` (${((n / r.window) * 100).toFixed(1)}%)` : "");
  const cells = 50;
  const grid = r.rows.flatMap((x, i) => {
    // every category that uses anything shows at least one cell
    const n = total && x.tokens ? Math.max(1, Math.round((x.tokens / total) * cells)) : 0;
    return Array.from({ length: n }, () => palette[i % palette.length] as string);
  });
  while (grid.length < cells) grid.push("");
  return (
    <Box flexDirection="column">
      <Text bold color={t.text}>
        Context Usage
      </Text>
      {[0, 1, 2, 3, 4].map((row) => (
        <Text key={row}>
          {grid.slice(row * 10, row * 10 + 10).map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
            <Text key={i} color={c || t.dim}>
              {c ? "⛁ " : "⛶ "}
            </Text>
          ))}
        </Text>
      ))}
      <Text color={t.muted}>
        {r.model} · {tokens(used)}/{r.window ? tokens(r.window) : "?"} tokens{pct(used)}
      </Text>
      {r.rows.map((x, i) => (
        <Text key={x.label}>
          <Text color={palette[i % palette.length]}> ⛁ </Text>
          <Text color={t.text}>{x.label}: </Text>
          <Text color={t.muted}>
            {tokens(x.tokens)} tokens{pct(x.tokens)}
          </Text>
        </Text>
      ))}
      {r.window && (
        <Text>
          <Text color={t.dim}> ⛶ </Text>
          <Text color={t.text}>Free space: </Text>
          <Text color={t.muted}>
            {tokens(Math.max(0, r.window - used))}
            {pct(Math.max(0, r.window - used))}
          </Text>
        </Text>
      )}
      {[
        ["Memory files", r.files],
        ["Skills", r.skills],
      ].map(([title, list]) =>
        (list as ContextReport["files"]).length ? (
          <Box key={title as string} flexDirection="column" marginTop={1}>
            <Text bold color={t.text}>
              {title as string}
            </Text>
            {(list as ContextReport["files"]).map((f) => (
              <Text key={f.label} color={t.muted}>
                {" "}
                └ {f.label}: {tokens(f.tokens)} tokens
              </Text>
            ))}
          </Box>
        ) : null,
      )}
    </Box>
  );
}

/** Ctrl+O in on/compact mode is Pi-cc's transcript mode: everything expanded, the input and bar hidden. */
const useTranscriptMode = () => {
  const cfg = useConfig();
  return useUi((s) => s.expanded) && cfg.mode !== "off";
};

/** The transcript, and in transcript mode its hint line. */
export function TranscriptSlot({ Default }: { Default: ComponentType }) {
  const t = useTheme();
  const on = useTranscriptMode();
  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0}>
      <Default />
      {on && (
        <Text color={t.dim}> Showing detailed transcript · esc/q to exit · ctrl+o to toggle · PgUp/PgDn scroll</Text>
      )}
    </Box>
  );
}

/** Transcript mode owns the keys (Esc/q/Ctrl+C leave it); otherwise the input, with Pi-cc's `❯` before it. */
export function PromptSlot({ Default }: { Default: Slots["prompt"] }) {
  const on = useTranscriptMode();
  return on ? <TranscriptKeys /> : <Prompt Default={Default} />;
}

function TranscriptKeys() {
  const ctx = usePluginCtx();
  useInput((input, key) => {
    const cli = cliOf(ctx);
    if (key.escape || input === "q" || (key.ctrl && input === "c")) cli.toggleExpanded();
    // Pi-cc's transcript keys: ↑/↓ a row, Home/End (g/G) the ends
    else if (key.upArrow) cli.scroll(-1);
    else if (key.downArrow) cli.scroll(1);
    else if (key.home || input === "g") cli.scroll("top");
    else if (key.end || input === "G") cli.scroll("bottom");
  });
  return null;
}

/** Pi-cc's `❯ ` before the input, in the input box's border color. */
function Prompt({ Default }: { Default: Slots["prompt"] }) {
  const cfg = useConfig();
  const color = useBorderColor();
  return cfg.enableEditorPrefix ? <Default prefix={<Text color={color}>❯ </Text>} /> : <Default />;
}

/** Pi-cc's working row while a turn runs: `⠋ Working... (↓ 1.2k tokens · 12s)`; hidden in transcript mode. */
export function AboveInput({ Default }: { Default: ComponentType }) {
  const t = useTheme();
  const r = useRt();
  const cfg = useConfig();
  const on = useTranscriptMode();
  const busy = useUi((s) => s.busy);
  const live = useStore(r.live);
  useTick(busy && cfg.enableWorkingMessage, 200);
  if (on) return null;
  const n = live.output + Math.round(live.chars / 4);
  const since = live.start ? Date.now() - live.start : 0;
  const parts = [n > 0 && `↓ ${n.toLocaleString("en-US")} tokens`, since >= 3000 && duration(since)].filter(Boolean);
  return (
    <>
      <Default />
      {busy && cfg.enableWorkingMessage && (
        <Text>
          <Text color={t.accent}>{spinner()}</Text>
          <Text color={t.muted}> Working...</Text>
          {parts.length > 0 && <Text color={t.dim}> ({parts.join(" · ")})</Text>}
        </Text>
      )}
    </>
  );
}

/** git flags by role: conflict/behind red, modified yellow, untracked muted, ahead green. */
const flagColor = (t: Record<string, string>, ch: string) =>
  ch === "=" || ch === "⇣" ? t.red : ch === "!" ? t.yellow : ch === "?" ? t.muted : ch === "⇡" ? t.green : t.dim;

const EFFORT_SYMBOL: Record<string, string> = { low: "◎", medium: "◔", high: "◕", xhigh: "◉", max: "●" };

/** Pi-cc's footer: chip lines (model, context gauge, cache, rate, cost, tokens / cwd, git), plugin statuses after. */
export function StatusBar({ Default }: { Default: ComponentType }) {
  const t = useTheme();
  const r = useRt();
  const cfg = useConfig();
  const on = useTranscriptMode();
  const status = useUi((s) => s.status);
  const effort = useUi((s) => s.effort);
  const statuses = useUi((s) => s.statuses);
  const messages = useSession((s) => s.messages);
  const extra = useSession((s) => s.usage);
  const name = useSession((s) => s.name);
  const cwd = useSession((s) => s.cwd) ?? process.cwd();
  const live = useStore(r.live);
  if (on) return null;
  if (!cfg.enableCustomFooter) return <Default />;

  const replies = messages.flatMap((m) => (m.role === "assistant" && m.usage ? [m.usage] : []));
  const last = replies.at(-1);
  const cost = [...replies, ...(extra ? [extra] : [])].reduce((n, u) => n + (u.cost ?? 0), 0);
  const glyph = cfg.footerNerdIcons
    ? { git: " ", cache: "󰆼 ", tokens: "\u{f04a0}" }
    : { git: "", cache: "", tokens: "Σ" };
  const chips: Record<string, ReactNode> = {};
  if (status) {
    const sym = effort && EFFORT_SYMBOL[effort];
    const thinking = effort && (t[`thinking${effort[0]?.toUpperCase()}${effort.slice(1)}`] ?? t.border);
    chips.model = (
      <Text>
        <Text color={t.accent}>{status.model.includes("/") ? status.model : `${status.name}/${status.model}`}</Text>
        {sym && (
          <Text color={thinking}>
            {" "}
            {sym} {effort}
          </Text>
        )}
      </Text>
    );
  }
  if (status?.window) {
    const pct = last ? ((last.input + last.output) / status.window) * 100 : 0;
    const fill = Math.round((Math.min(100, pct) / 100) * 10);
    chips.context = (
      <Text>
        <Text color={pct >= 95 ? t.red : pct >= 80 ? t.yellow : t.accent}>{"█".repeat(fill)}</Text>
        <Text color={t.dim}>{"░".repeat(10 - fill)}</Text>
        <Text color={t.muted}>
          {" "}
          {Math.floor(pct)}%/{tokens(status.window)}
        </Text>
      </Text>
    );
  }
  if (last && last.cacheRead > 0 && last.input > 0)
    chips.cache = <Text color={t.muted}>{`${glyph.cache}${Math.floor((last.cacheRead * 100) / last.input)}%`}</Text>;
  if (cfg.footerTokenRate && live.rate && live.rate > 0) {
    const v = live.rate >= 1000 ? `${(live.rate / 1000).toFixed(1)}k` : `${Math.round(live.rate)}`;
    const ttft = cfg.footerTokenRateTtft && live.ttft ? ` (TTFT: ${(live.ttft / 1000).toFixed(1)}s)` : "";
    chips.rate = <Text color={t.muted}>{`avg ${v} tok/s${ttft}`}</Text>;
  }
  if (cost > 0) {
    const value = cost * (cfg.footerCurrencyRate ?? 1);
    let text: string;
    try {
      text = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: cfg.footerCurrency,
        maximumFractionDigits: 3,
      }).format(value);
    } catch {
      text = `$${value.toFixed(3)}`;
    }
    chips.cost = <Text color={t.dim}>{text}</Text>;
  }
  if (cfg.footerSessionTokens) {
    const total = [...replies, ...(extra ? [extra] : [])].reduce((n, u) => n + u.input + u.output, 0);
    if (total > 0) chips.tokens = <Text color={t.muted}>{`${glyph.tokens} ${tokens(total)}`}</Text>;
  }
  chips.cwd = (
    <Text>
      <Text color={t.accent}>{basename(cwd) || cwd}</Text>
      {name && (
        <Text>
          <Text color={t.muted}> in </Text>
          <Text color={t.green}>{name}</Text>
        </Text>
      )}
    </Text>
  );
  const git = live.git;
  if (git?.branch)
    chips.git = (
      <Text>
        <Text color={t.thinkingMedium}>{`${glyph.git}${git.branch}`}</Text>
        {git.status && (
          <Text>
            <Text color={t.dim}> [</Text>
            {[...git.status].map((ch, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: flags are positional
              <Text key={i} color={flagColor(t, ch)}>
                {ch}
              </Text>
            ))}
            <Text color={t.dim}>]</Text>
          </Text>
        )}
        {(git.add > 0 || git.del > 0) && (
          <Text>
            <Text color={t.dim}>(</Text>
            <Text color={t.green}>+{git.add}</Text> <Text color={t.red}>−{git.del}</Text>
            <Text color={t.dim}>)</Text>
          </Text>
        )}
      </Text>
    );
  // plugins' statuses: where a line names their key, else after line 1's chips
  const placed = new Set([...cfg.footerLine1Keys, ...cfg.footerLine2Keys, ...cfg.footerLine3Keys]);
  for (const [key, { text, color }] of Object.entries(statuses))
    chips[key] = <Text color={(color && t[color]) || t.dim}>{text}</Text>;
  const lines = [
    [...cfg.footerLine1Keys, ...Object.keys(statuses).filter((k) => !placed.has(k))],
    cfg.footerLine2Keys,
    cfg.footerLine3Keys,
  ].map((keys) => keys.filter((k) => chips[k] !== undefined && !cfg.footerHiddenKeys.includes(k)));
  return (
    <Box flexDirection="column">
      {lines.map((keys, i) =>
        keys.length ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
          <Text key={i} wrap="truncate-end">
            {keys.map((k, j) => (
              <Text key={k}>
                {j > 0 && <Text color={t.dim}> · </Text>}
                {chips[k]}
              </Text>
            ))}
          </Text>
        ) : null,
      )}
    </Box>
  );
}
