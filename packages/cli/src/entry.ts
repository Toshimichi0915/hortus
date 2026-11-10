import type { Message, ToolCall, ToolResult } from "@hortus/core";

/** A transcript entry shown as (wrapped) text. */
export interface TextEntry {
  id: number;
  kind: "info" | "user" | "thinking" | "assistant" | "error";
  text: string;
}
/** A tool call's block, drawn by its tool's renderer (see `ToolRenderer`); replaced as updates and the result arrive. */
export interface ToolEntry {
  id: number;
  kind: "tool";
  call: ToolCall;
  result?: ToolResult;
  /** the latest `tool_update` while running, then the result's `details` */
  details?: unknown;
}
export type Entry = TextEntry | ToolEntry;

let nextId = 0;
export function entry(kind: TextEntry["kind"], text: string): TextEntry {
  return { id: nextId++, kind, text };
}
export function toolEntry(call: ToolCall, result?: ToolResult): ToolEntry {
  return { id: nextId++, kind: "tool", call, result, details: result?.details };
}

interface Style {
  color?: string;
  backgroundColor?: string;
  italic?: boolean;
}

/** pi's dark theme: the okhsl() colors of its dark.json, as hex. */
export const theme = {
  text: "#dee0e1",
  muted: "#9da5a9",
  dim: "#7e888e",
  accent: "#a798d7",
  border: "#5fa8cc",
  borderIdle: "#6c767b",
  green: "#68b78d",
  red: "#ea7f81",
  yellow: "#cd9a22",
  blue: "#69add0",
  thinking: "#96a0a4",
};

export const styles: Record<TextEntry["kind"], Style> = {
  info: { color: theme.dim },
  user: { color: theme.text, backgroundColor: "#213b49" },
  thinking: { color: theme.thinking, italic: true },
  assistant: {},
  error: { color: theme.red },
};

/** A tool block's background: running, done, failed. */
export const toolBackground = ({ result }: ToolEntry) => (!result ? "#34383a" : result.isError ? "#5b282a" : "#254131");

const pad = (n: number) => String(n).padStart(2, "0");
/** Local time as fixed-width `YYYY-MM-DD HH:MM`, so titles line up. */
export const stamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const k = (n: number) => `${(n / 1000).toFixed(1)}K`;
const pct = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(1)}%` : "-");

/** Totals over `messages`, context fill from the last reply, and the cache hit rate of all input. */
export function usageLine(messages: Message[], window?: number) {
  const usages = messages.flatMap((m) => (m.role === "assistant" && m.usage ? [m.usage] : []));
  const sum = (f: (u: (typeof usages)[number]) => number) => usages.reduce((n, u) => n + f(u), 0);
  const input = sum((u) => u.input);
  const last = usages.at(-1);
  const ctx = window ? `${pct(last ? last.input + last.output : 0, window)}/${(window / 1e6).toFixed(1)}M` : "-/-";
  const hit = pct(
    sum((u) => u.cacheRead),
    input,
  );
  return `↑ ${k(input)} ↓ ${k(sum((u) => u.output))} ${ctx} CH ${hit}`;
}
