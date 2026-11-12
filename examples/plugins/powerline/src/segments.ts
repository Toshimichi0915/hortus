import { hostname } from "node:os";
import { basename } from "node:path";
import { type Span, type Theme, theme } from "@hortus/cli";
import type {
  BuiltinSegment,
  Currency,
  CustomItem,
  Layout,
  Preset,
  SegmentId,
  SegmentOptions,
  Separator,
} from "./config.ts";

// ── Colors ─────────────────────────────────────────────────────────────────

export type Semantic =
  | "model"
  | "path"
  | "gitDirty"
  | "gitClean"
  | "thinking"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  | "thinkingMax"
  | "context"
  | "contextWarn"
  | "contextError"
  | "cacheHit"
  | "cacheHitWarn"
  | "cacheHitError"
  | "cost"
  | "tokens"
  | "separator";

const DEFAULT_COLORS: Record<Semantic, string> = {
  model: "#d787af",
  path: "#00afaf",
  gitDirty: "warning",
  gitClean: "success",
  thinking: "thinkingOff",
  thinkingMinimal: "thinkingMinimal",
  thinkingLow: "thinkingLow",
  thinkingMedium: "thinkingMedium",
  thinkingHigh: "rainbow",
  thinkingXhigh: "rainbow",
  thinkingMax: "rainbow",
  context: "dim",
  contextWarn: "warning",
  contextError: "error",
  cacheHit: "success",
  cacheHitWarn: "warning",
  cacheHitError: "error",
  cost: "text",
  tokens: "muted",
  separator: "dim",
};
const RAINBOW = ["#b281d6", "#d787af", "#febc38", "#e4c00f", "#89d281", "#00afaf", "#178fb9", "#b281d6"];

/** Pi's theme color names, as hortus theme tokens. */
const PI_COLORS: Record<string, keyof Theme> = {
  text: "text",
  muted: "muted",
  dim: "dim",
  accent: "accent",
  success: "green",
  warning: "yellow",
  error: "red",
  border: "border",
  borderAccent: "accent",
  borderMuted: "borderIdle",
  thinkingOff: "dim",
  thinkingMinimal: "thinking",
  thinkingLow: "blue",
  thinkingMedium: "green",
};

/** `text` in `color`: a Pi theme color name, `#rrggbb`, or "rainbow" (unknown names draw as text). */
export function paint(color: string | undefined, text: string, bold?: boolean): Span[] {
  if (color === "rainbow") {
    let i = 0;
    return [...text].map((ch) =>
      ch === " " || ch === ":" ? { text: ch } : { text: ch, color: RAINBOW[i++ % 8], bold },
    );
  }
  if (color === undefined) return [{ text, bold }];
  const hex = /^#[0-9a-fA-F]{6}$/.test(color);
  return [{ text, color: hex ? color : theme[PI_COLORS[color] ?? "text"], bold }];
}

// ── Icons and separators ───────────────────────────────────────────────────

/** POWERLINE_NERD_FONTS=1/0 forces it; else a guess from the terminal's name. */
export function hasNerdFonts() {
  if (process.env.POWERLINE_NERD_FONTS === "1") return true;
  if (process.env.POWERLINE_NERD_FONTS === "0") return false;
  if (process.env.GHOSTTY_RESOURCES_DIR) return true;
  const term = (process.env.TERM_PROGRAM ?? process.env.TERM ?? "").toLowerCase();
  return ["iterm", "wezterm", "kitty", "ghostty", "alacritty", "kaku"].some((t) => term.includes(t));
}

const NERD_ICONS = {
  model: "",
  folder: "",
  branch: "",
  git: "",
  github: "",
  gitlab: "",
  bitbucket: "",
  tokens: "",
  context: "",
  time: "",
  cache: "",
  input: "",
  output: "",
  host: "",
  session: "",
  auto: "\u{F0068}",
};
export type Icons = typeof NERD_ICONS;
const ASCII_ICONS: Icons = {
  model: "",
  folder: "dir",
  branch: "⎇",
  git: "⎇",
  github: "⎇",
  gitlab: "⎇",
  bitbucket: "⎇",
  tokens: "⊛",
  context: "◫",
  time: "◷",
  cache: "cache",
  input: "in:",
  output: "out:",
  host: "host",
  session: "id",
  auto: "AC",
};
export const icons = (overrides: Record<string, string>): Icons => {
  const base = hasNerdFonts() ? NERD_ICONS : ASCII_ICONS;
  return { ...base, ...Object.fromEntries(Object.entries(overrides).filter(([k]) => Object.hasOwn(base, k))) };
};

const THINKING_NERD: Record<string, string> = {
  minimal: "\u{F0E7} min",
  low: "\u{F10C} low",
  medium: "\u{F192} med",
  high: "\u{F111} high",
  xhigh: "\u{F06D} xhi",
};
const THINKING_ASCII: Record<string, string> = {
  minimal: "[min]",
  low: "[low]",
  medium: "[med]",
  high: "[high]",
  xhigh: "[xhi]",
};

export function separator(style: Separator) {
  const nerd = hasNerdFonts();
  switch (style) {
    case "powerline":
      return nerd ? "" : ">";
    case "slash":
      return "/";
    case "pipe":
      return "|";
    case "block":
      return nerd ? "█" : "#";
    case "none":
      return " ";
    case "ascii":
      return ">";
    case "dot":
      return nerd ? "·" : ".";
    case "chevron":
      return "›";
    case "star":
      return "✦";
    default:
      return nerd ? "" : "|";
  }
}

// ── Presets ────────────────────────────────────────────────────────────────

export interface PresetDef {
  left: BuiltinSegment[];
  right: BuiltinSegment[];
  secondary?: BuiltinSegment[];
  separator: Separator;
  options: SegmentOptions;
  colors: Partial<Record<Semantic, string>>;
}
const MINIMAL_COLORS = { model: "text", path: "text", gitClean: "dim" };
const allGit = { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true };
export const PRESETS: Record<Preset, PresetDef> = {
  default: {
    left: ["model", "thinking", "shell_mode", "path", "git", "queue", "context_pct", "cache_read", "cost"],
    right: [],
    secondary: ["extension_statuses"],
    separator: "powerline-thin",
    colors: {},
    options: { model: { showThinkingLevel: false }, path: { mode: "basename" }, git: allGit },
  },
  minimal: {
    left: ["shell_mode", "path", "git"],
    right: ["context_pct"],
    separator: "slash",
    colors: MINIMAL_COLORS,
    options: {
      path: { mode: "basename" },
      git: { showBranch: true, showStaged: false, showUnstaged: false, showUntracked: false },
    },
  },
  compact: {
    left: ["model", "shell_mode", "git"],
    right: ["queue", "cost", "context_pct"],
    separator: "powerline-thin",
    colors: {},
    options: { model: { showThinkingLevel: false }, git: { ...allGit, showUntracked: false } },
  },
  full: {
    left: ["hostname", "model", "thinking", "shell_mode", "path", "git", "queue", "subagents"],
    right: ["token_in", "token_out", "cache_read", "cost", "context_pct", "time_spent", "time", "extension_statuses"],
    separator: "powerline",
    colors: {},
    options: {
      model: { showThinkingLevel: false },
      path: { mode: "abbreviated", maxLength: 50 },
      git: allGit,
      time: { format: "24h", showSeconds: false },
    },
  },
  nerd: {
    left: ["hostname", "model", "thinking", "shell_mode", "path", "git", "queue", "session", "subagents"],
    right: [
      "token_in",
      "token_out",
      "cache_read",
      "cache_write",
      "cost",
      "context_pct",
      "context_total",
      "time_spent",
      "time",
      "extension_statuses",
    ],
    separator: "powerline",
    colors: { model: "accent", path: "success", tokens: "muted", cost: "warning" },
    options: {
      model: { showThinkingLevel: false },
      path: { mode: "abbreviated", maxLength: 60 },
      git: allGit,
      time: { format: "24h", showSeconds: true },
    },
  },
  ascii: {
    left: ["model", "shell_mode", "path", "git"],
    right: ["queue", "token_total", "cost", "context_pct"],
    separator: "ascii",
    colors: MINIMAL_COLORS,
    options: { model: { showThinkingLevel: true }, path: { mode: "abbreviated", maxLength: 40 }, git: allGit },
  },
};

export function mergeOptions(a: SegmentOptions = {}, b: SegmentOptions = {}): SegmentOptions {
  return {
    model: { ...a.model, ...b.model },
    path: { ...a.path, ...b.path },
    git: { ...a.git, ...b.git },
    time: { ...a.time, ...b.time },
    cost: { ...a.cost, ...b.cost },
    context: { ...a.context, ...b.context },
    cache_read: { ...a.cache_read, ...b.cache_read },
  };
}

/** The preset's rows with `layout` applied, custom items appended by position, and disabled segments removed. */
export function rows(preset: PresetDef, custom: CustomItem[], layout: Layout | null, disabled: SegmentId[]) {
  const placed = new Set([...(layout?.left ?? []), ...(layout?.right ?? []), ...(layout?.secondary ?? [])]);
  const row = (pos: CustomItem["position"], configured: SegmentId[] | undefined, base: SegmentId[]) => {
    const segs = configured ? [...configured] : base.filter((id) => !placed.has(id));
    if (!configured)
      for (const c of custom) if (c.position === pos && !placed.has(`custom:${c.id}`)) segs.push(`custom:${c.id}`);
    return segs.filter((id) => !disabled.includes(id));
  };
  return [
    ...row("left", layout?.left, preset.left),
    ...row("right", layout?.right, preset.right),
    ...row("secondary", layout?.secondary, preset.secondary ?? []),
  ];
}

// ── Segments ───────────────────────────────────────────────────────────────

export interface GitStatus {
  branch: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
}
/** Pi's token counts: `input` is the uncached part. */
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SegmentContext {
  model?: { id: string; provider: string; reasoning: boolean };
  /** an effort level, or "auto" (the provider's default) */
  thinking: string;
  sessionId?: string;
  sessionName?: string;
  cwd: string;
  usage: Tokens & { cost: number };
  /** the last request's prompt tokens */
  last?: Tokens;
  contextTokens: number | null;
  contextWindow: number;
  git: GitStatus;
  gitHost: "github" | "gitlab" | "bitbucket" | "other" | null;
  statuses: Record<string, string>;
  hidden: Set<string>;
  custom: Map<string, CustomItem>;
  options: SegmentOptions;
  colors: Record<string, string>;
  icons: Icons;
  startTime: number;
  /** USD → currency rate, undefined while unknown */
  rate: (c: Currency) => number | undefined;
}

export const SEP_DOT = " · ";
const withIcon = (icon: string, text: string) => (icon ? `${icon} ${text}` : text);

export function formatTokens(n: number) {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

function duration(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

const SYMBOLS: Record<Currency, string> = {
  USD: "$",
  CNY: "¥",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CAD: "CA$",
  AUD: "A$",
  CHF: "CHF ",
  INR: "₹",
  KRW: "₩",
};
export function formatCost(usd: number, currency: Currency, rate: number | undefined) {
  if (rate === undefined) return `-- ${currency}`;
  return `${SYMBOLS[currency]}${(usd * rate).toFixed(currency === "JPY" || currency === "KRW" ? 0 : 2)}`;
}

const hitRate = (t: Tokens) => {
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  return prompt > 0 ? Math.round((t.cacheRead / prompt) * 100) : undefined;
};

/** Notification-style statuses (`[...]`) show above the editor, not in the bar. */
export const isNotification = (v: string) => v.trimStart().startsWith("[");
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
const ANSI = /\x1b\[[0-9;]*m/g;
/** A status value without trailing separators and blanks; undefined when nothing visible is left. */
export function normalizeStatus(v: string, keepAnsi = false) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
  const s = keepAnsi ? v.replace(/(\s|·|[|])+$/, "") : v.replace(/(\x1b\[[0-9;]*m|\s|·|[|])+$/, "");
  return s.replace(ANSI, "").trim() ? s : undefined;
}

type Render = (c: SegmentContext) => Span[] | undefined;

export function color(c: SegmentContext, semantic: Semantic, preset: PresetDef, text: string) {
  return paint(c.colors[semantic] ?? preset.colors[semantic] ?? DEFAULT_COLORS[semantic], text);
}

export function segments(preset: PresetDef): Record<BuiltinSegment, Render> {
  const col = (c: SegmentContext, s: Semantic, text: string) => color(c, s, preset, text);
  const thinkingColor = (level: string): Semantic =>
    (
      ({
        minimal: "thinkingMinimal",
        low: "thinkingLow",
        medium: "thinkingMedium",
        high: "thinkingHigh",
        xhigh: "thinkingXhigh",
        max: "thinkingMax",
      }) as Record<string, Semantic>
    )[level] ?? "thinking";
  const hitColor = (c: SegmentContext, rate: number | undefined, text: string) =>
    col(c, rate === undefined ? "tokens" : rate < 30 ? "cacheHitError" : rate < 70 ? "cacheHitWarn" : "cacheHit", text);
  const pct = (r: number | undefined) => (r === undefined ? "--" : `${r}%`);
  return {
    model: (c) => {
      const o = c.options.model ?? {};
      let name = c.model?.id ?? "no-model";
      if (o.display === "qualified" && c.model)
        name = name.startsWith(`${c.model.provider}/`) ? name : `${c.model.provider}/${name}`;
      else if (name.startsWith("Claude ")) name = name.slice(7);
      let text = withIcon(c.icons.model, name);
      if (o.showThinkingLevel !== false && c.model?.reasoning && c.thinking !== "off") {
        const t = (hasNerdFonts() ? THINKING_NERD : THINKING_ASCII)[c.thinking];
        if (t) text += `${SEP_DOT}${t}`;
      }
      return col(c, "model", text);
    },
    // ponytail: bash mode is a non-goal of the port; the segment never shows
    shell_mode: () => undefined,
    path: (c) => {
      const o = c.options.path ?? {};
      const mode = o.mode ?? "basename";
      let pwd = c.cwd;
      const home = process.env.HOME;
      if (mode === "basename") pwd = basename(pwd) || pwd;
      else {
        if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
        if (pwd.startsWith("/work/")) pwd = pwd.slice(6);
        const max = o.maxLength ?? 40;
        if (mode === "abbreviated" && pwd.length > max) pwd = `…${pwd.slice(-(max - 1))}`;
      }
      return col(c, "path", withIcon(c.icons.folder, pwd));
    },
    git: (c) => {
      const o = c.options.git ?? {};
      const { branch, staged, unstaged, untracked } = c.git;
      const dirty = staged > 0 || unstaged > 0 || untracked > 0;
      if (!branch && !dirty) return;
      const branchColor = dirty ? "gitDirty" : "gitClean";
      const out: Span[] = [];
      if (o.showBranch !== false && branch) {
        const icon = o.hostIcon && c.gitHost ? c.icons[c.gitHost === "other" ? "git" : c.gitHost] : c.icons.branch;
        out.push(...col(c, branchColor, withIcon(icon, branch)));
      }
      const marks: Span[][] = [];
      if (o.showUnstaged !== false && unstaged > 0) marks.push(paint("warning", `*${unstaged}`));
      if (o.showStaged !== false && staged > 0) marks.push(paint("success", `+${staged}`));
      if (o.showUntracked !== false && untracked > 0) marks.push(paint("muted", `?${untracked}`));
      if (marks.length) {
        if (!out.length && o.showBranch === false && c.icons.git) out.push(...col(c, branchColor, `${c.icons.git} `));
        else if (out.length) out.push({ text: " " });
        marks.forEach((m, i) => {
          out.push(...(i ? [{ text: " " }] : []), ...m);
        });
      }
      return out.length ? out : undefined;
    },
    thinking: (c) => {
      const label = (
        { off: "off", minimal: "min", low: "low", medium: "med", high: "high", xhigh: "xhigh" } as Record<
          string,
          string
        >
      )[c.thinking];
      return col(c, thinkingColor(c.thinking), `think:${label ?? c.thinking}`);
    },
    // ponytail: a stub, as Pi's own segment is; count running subruns (`run_start`/`run_end` with `ctx.run.depth > 0`) if wanted
    subagents: () => undefined,
    // always empty: Pi queues prompts typed during a compaction, hortus has nothing to queue (a prompt then runs at once,
    // the compaction applying from its next request; a compaction in progress shows as builtin:compaction's status)
    queue: () => undefined,
    token_in: (c) =>
      c.usage.input ? col(c, "tokens", withIcon(c.icons.input, formatTokens(c.usage.input))) : undefined,
    token_out: (c) =>
      c.usage.output ? col(c, "tokens", withIcon(c.icons.output, formatTokens(c.usage.output))) : undefined,
    token_total: (c) => {
      const t = c.usage.input + c.usage.output + c.usage.cacheRead + c.usage.cacheWrite;
      return t ? col(c, "tokens", withIcon(c.icons.tokens, formatTokens(t))) : undefined;
    },
    // ponytail: no provider tells hortus it bills by subscription, so `subscriptionDisplay` never applies
    cost: (c) => {
      if (!c.usage.cost) return;
      const currency = c.options.cost?.currency ?? "USD";
      return col(c, "cost", formatCost(c.usage.cost, currency, c.rate(currency)));
    },
    context_pct: (c) => {
      const { contextTokens: tokens, contextWindow: window } = c;
      // Pi's fallback: 0% when the window is unknown
      const percent = tokens === null ? null : window > 0 ? (tokens / window) * 100 : 0;
      const percentOnly = c.options.context?.format === "percent";
      const text = percentOnly
        ? percent === null
          ? "?"
          : `${Math.round(percent)}%`
        : tokens !== null && percent !== null
          ? `${formatTokens(tokens)}/${formatTokens(window)} (${percent.toFixed(1)}%)`
          : `?/${formatTokens(window)}`;
      const s: Semantic =
        percent !== null && percent > 90
          ? "contextError"
          : percent !== null && percent > 70
            ? "contextWarn"
            : "context";
      return percentOnly || !c.icons.context ? col(c, s, text) : [{ text: `${c.icons.context} ` }, ...col(c, s, text)];
    },
    context_total: (c) =>
      c.contextWindow ? col(c, "context", withIcon(c.icons.context, formatTokens(c.contextWindow))) : undefined,
    time_spent: (c) => {
      const ms = Date.now() - c.startTime;
      return ms < 1000 ? undefined : [{ text: withIcon(c.icons.time, duration(ms)) }];
    },
    time: (c) => {
      const o = c.options.time ?? {};
      const now = new Date();
      let h = now.getHours();
      let suffix = "";
      if (o.format === "12h") {
        suffix = h >= 12 ? "pm" : "am";
        h = h % 12 || 12;
      }
      let t = `${h}:${String(now.getMinutes()).padStart(2, "0")}`;
      if (o.showSeconds) t += `:${String(now.getSeconds()).padStart(2, "0")}`;
      return [{ text: withIcon(c.icons.time, t + suffix) }];
    },
    session: (c) => [
      { text: withIcon(c.icons.session, c.sessionName?.trim() ? c.sessionName : c.sessionId?.slice(0, 8) || "new") },
    ],
    hostname: (c) => [{ text: withIcon(c.icons.host, hostname().split(".")[0] ?? "") }],
    cache_read: (c) => {
      const format = c.options.cache_read?.format ?? "tokens";
      const { cacheRead, cacheWrite } = c.usage;
      if (format === "request" || format === "session-request") {
        if (!cacheRead && !cacheWrite) return;
        const req = c.last ? hitRate(c.last) : undefined;
        const join = (...p: string[]) => p.filter(Boolean).join(" ");
        if (format === "request") return hitColor(c, req, join(c.icons.cache, pct(req)));
        const session = hitRate(c.usage);
        return [
          ...hitColor(c, session, join(c.icons.cache, pct(session))),
          { text: SEP_DOT },
          ...hitColor(c, req, `last ${pct(req)}`),
        ];
      }
      if (!cacheRead) return;
      const rate = hitRate(c.usage) ?? 0;
      if (format === "percent") return col(c, "tokens", [c.icons.cache, `${rate}%`].filter(Boolean).join(" "));
      const tokens = [c.icons.cache, c.icons.input, formatTokens(cacheRead)].filter(Boolean).join(" ");
      return col(c, "tokens", format === "both" ? `${tokens} (${rate}%)` : tokens);
    },
    cache_write: (c) =>
      c.usage.cacheWrite
        ? col(c, "tokens", [c.icons.cache, c.icons.output, formatTokens(c.usage.cacheWrite)].filter(Boolean).join(" "))
        : undefined,
    extension_statuses: (c) => {
      const parts = Object.entries(c.statuses).flatMap(([k, v]) =>
        c.hidden.has(k) || isNotification(v) ? [] : (normalizeStatus(v) ?? []),
      );
      return parts.length ? [{ text: parts.join(SEP_DOT) }] : undefined;
    },
  };
}

function custom(c: SegmentContext, id: string): Span[] | undefined {
  const item = c.custom.get(id);
  if (!item) return;
  const raw = c.statuses[item.statusKey];
  const value = raw ? normalizeStatus(raw, item.selfColorize) : undefined;
  if (!value) return item.hideWhenMissing ? undefined : [{ text: item.prefix ?? item.id }];
  const text = item.prefix ? `${item.prefix}${SEP_DOT}${value}` : value;
  return item.color && !item.selfColorize ? paint(item.color, text) : [{ text }];
}

// ── Layout ─────────────────────────────────────────────────────────────────

/** Terminal cells of `s`: wide CJK and emoji count two, escapes none. */
export function width(s: string) {
  let n = 0;
  // ponytail: a range check instead of the Unicode width tables; string-width if odd glyphs misalign the bar
  for (const ch of s.replace(ANSI, ""))
    n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u.test(ch) ? 2 : 1;
  return n;
}
const spansWidth = (spans: Span[]) => spans.reduce((n, s) => n + width(s.text), 0);

/**
 * Pi's responsive layout: segments fill the top row in order; the rest overflow onto the secondary row (dropped once
 * full, or continued on more rows with `wrap`). Every row has `padding` blanks at both ends.
 */
export function layout(
  c: SegmentContext,
  preset: PresetDef,
  ids: SegmentId[],
  available: number,
  opts: { separator: Separator; padding: number; wrap: boolean },
): { top: Span[]; secondary: Span[][] } {
  const render = segments(preset);
  const rendered = ids.flatMap((id) => {
    const spans = id.startsWith("custom:") ? custom(c, id.slice(7)) : render[id as BuiltinSegment](c);
    const w = spans ? spansWidth(spans) : 0;
    return spans && w ? [{ spans, w }] : [];
  });
  const sep = separator(opts.separator);
  const sepWidth = width(sep) + 2;
  const base = 2 * opts.padding;
  const fill = (segs: typeof rendered): Span[] => {
    if (!segs.length) return [];
    const pad = { text: " ".repeat(opts.padding) };
    const out: Span[] = [pad];
    segs.forEach((s, i) => {
      if (i) out.push({ text: " " }, ...color(c, "separator", preset, sep), { text: " " });
      out.push(...s.spans);
    });
    return [...out, pad];
  };
  let used = base;
  const top: typeof rendered = [];
  const rest: typeof rendered = [];
  for (const s of rendered) {
    const need = s.w + (top.length ? sepWidth : 0);
    if (!rest.length && used + need <= available) {
      top.push(s);
      used += need;
    } else rest.push(s);
  }
  const lines: (typeof rendered)[] = [[]];
  used = base;
  for (const s of rest) {
    let line = lines[lines.length - 1] as typeof rendered;
    let need = s.w + (line.length ? sepWidth : 0);
    if (used + need > available) {
      if (!opts.wrap) break;
      if (base + s.w > available) continue;
      line = [];
      lines.push(line);
      used = base;
      need = s.w;
    }
    line.push(s);
    used += need;
  }
  return { top: fill(top), secondary: lines.filter((l) => l.length).map(fill) };
}
