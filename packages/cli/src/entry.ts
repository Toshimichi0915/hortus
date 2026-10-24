import type { Message, ToolCall, ToolResult } from "@phi/core";

export interface Entry {
  id: number;
  kind: "info" | "user" | "thinking" | "assistant" | "tool" | "toolOk" | "toolError" | "error";
  text: string;
}

let nextId = 0;
export function entry(kind: Entry["kind"], text: string): Entry {
  return { id: nextId++, kind, text };
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

export const styles: Record<Entry["kind"], Style> = {
  info: { color: theme.dim },
  user: { color: theme.text, backgroundColor: "#213b49" },
  thinking: { color: theme.thinking, italic: true },
  assistant: {},
  // pending / success / error tool blocks
  tool: { backgroundColor: "#34383a" },
  toolOk: { backgroundColor: "#254131" },
  toolError: { backgroundColor: "#5b282a" },
  error: { color: theme.red },
};

/** Keeps the first (or last) `n` lines, noting how many were cut. */
function preview(text: string, n: number, fromEnd = false) {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length <= n) return lines;
  const more = `... (${lines.length - n} ${fromEnd ? "earlier" : "more"} lines)`;
  return fromEnd ? [more, ...lines.slice(-n)] : [...lines.slice(0, n), more];
}

/** A tool call block like pi's: a one-line header, then a short preview of the input or result. */
export function formatTool(call: ToolCall, result?: ToolResult): string {
  const i = (call.input ?? {}) as Record<string, unknown>;
  const out = result && (result.image ? "[image]" : result.output);
  let head: string;
  let body: string[] = [];
  if (call.name === "bash") {
    head = `$ ${i.command}`;
    if (out) body = preview(out, 5, true);
  } else if (call.name === "read") {
    const from = Number(i.offset ?? 1);
    const range = i.offset || i.limit ? `:${from}${i.limit ? `-${from + Number(i.limit) - 1}` : ""}` : "";
    head = `read ${i.path}${range}`;
    if (out) body = preview(out, 10);
  } else if (call.name === "write") {
    head = `write ${i.path}`;
    body = result?.isError && out ? preview(out, 10) : preview(String(i.content ?? ""), 10);
  } else if (call.name === "edit") {
    head = `edit ${i.path}`;
    const edits = (Array.isArray(i.edits) ? i.edits : []) as { oldText?: string; newText?: string }[];
    const diff = edits.flatMap((e) => [
      ...String(e.oldText ?? "")
        .split("\n")
        .map((l) => `- ${l}`),
      ...String(e.newText ?? "")
        .split("\n")
        .map((l) => `+ ${l}`),
    ]);
    body = result?.isError && out ? preview(out, 10) : preview(diff.join("\n"), 10);
  } else {
    head = `${call.name} ${JSON.stringify(call.input)}`;
    if (out) body = preview(out, 10);
  }
  // blank rows pad the block's background above and below, as pi does
  return ["", head, ...(body.length ? ["", ...body] : []), ""].join("\n");
}

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
    sum((u) => u.cached),
    input,
  );
  return `↑ ${k(input)} ↓ ${k(sum((u) => u.output))} ${ctx} CH ${hit}`;
}
