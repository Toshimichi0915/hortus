import {
  contextTokens,
  type Message,
  type MessageMeta,
  type ToolCall,
  type ToolResult,
  type Usage,
} from "@hortus/core";
import { theme } from "./themes.ts";

export { theme } from "./themes.ts";

/**
 * A text entry's kind: a built-in one, or a plugin's `<plugin>:<type>` (its messages', or its own for `cli.push`).
 */
export type TextKind = "info" | "warn" | "error" | "user" | "thinking" | "assistant" | "header" | `${string}:${string}`;

/**
 * A transcript entry shown as (wrapped) text, unless a plugin's `cli.entries[kind]` draws it. `header` is the
 * transcript's first row on every session, shown only when a plugin renders it.
 */
export interface TextEntry {
  id: number;
  kind: TextKind;
  text: string;
  /** a plugin message's */
  meta?: MessageMeta;
  /**
   * the session entry it shows: its message's (`message.entryId`), or a plugin entry's (`data`); none for UI-only
   * entries and streamed text before its message is saved
   */
  entryId?: string;
  /** the message it shows (user, assistant, a plugin's), once saved */
  message?: Message;
  /** a session plugin entry's data (kind `<plugin>:<type>`, its entry type) */
  data?: unknown;
  /** still streaming (thinking, assistant text) */
  live?: boolean;
  /** thinking: when its first delta came, and (once done) when the next text or tool call did; epoch ms */
  startedAt?: number;
  endedAt?: number;
}
/** A call of a tool block's assistant message, with its result and details so far. */
export interface ToolSibling {
  call: ToolCall;
  result?: ToolResult;
  details?: unknown;
}
/** A tool call's block, drawn by its tool's renderer (see `ToolRenderer`); replaced as updates and the result arrive. */
export interface ToolEntry {
  id: number;
  kind: "tool";
  call: ToolCall;
  result?: ToolResult;
  /** the latest `tool_update` while running, then the result's `details` */
  details?: unknown;
  /** the input streamed so far (`tool_input`), until the call itself arrives */
  partial?: string;
  /** the calls of the same assistant message, in order, this one included */
  siblings?: ToolSibling[];
}
export type Entry = TextEntry | ToolEntry;

let nextId = 0;
export function entry(kind: TextKind, text: string, meta?: MessageMeta, more?: Partial<TextEntry>): TextEntry {
  return { id: nextId++, kind, text, ...(meta && { meta }), ...more };
}
export function toolEntry(call: ToolCall, result?: ToolResult): ToolEntry {
  return { id: nextId++, kind: "tool", call, result, details: result?.details };
}

/**
 * `entries` with each tool block of a message whose calls include one of `ids` (all, without `ids`) given its
 * `siblings` anew from the blocks as they are now; `batches` maps a call id to its message's calls.
 */
export function withSiblings(entries: Entry[], batches: Map<string, ToolCall[]>, ids?: Set<string>): Entry[] {
  const blocks = new Map<string, ToolEntry>();
  for (const e of entries) if (e.kind === "tool") blocks.set(e.call.id, e);
  return entries.map((e) => {
    const all = e.kind === "tool" ? batches.get(e.call.id) : undefined;
    if (e.kind !== "tool" || !all || (ids && !all.some((c) => ids.has(c.id)))) return e;
    const siblings = all.map((c): ToolSibling => {
      const b = blocks.get(c.id);
      return {
        call: b?.call ?? c,
        ...(b?.result && { result: b.result }),
        ...(b?.details !== undefined && { details: b.details }),
      };
    });
    return { ...e, siblings };
  });
}

interface Style {
  color?: string;
  backgroundColor?: string;
  italic?: boolean;
}

/** How a text entry of `kind` is drawn, in the current theme. */
export function styleOf(kind: string): Style {
  switch (kind) {
    case "info":
      return { color: theme.dim };
    case "user":
      return { color: theme.userMessageText, backgroundColor: theme.userBackground };
    case "thinking":
      return { color: theme.thinking, italic: true };
    case "warn":
      return { color: theme.yellow };
    case "error":
      return { color: theme.red };
    case "assistant":
      return { color: theme.assistantText };
    default:
      // a plugin's `<plugin>:<type>`
      return {
        color: theme.customMessageText,
        ...(theme.customMessageBg && { backgroundColor: theme.customMessageBg }),
      };
  }
}

/** A tool block's background: running, done, failed. */
export const toolBackground = ({ result }: ToolEntry) =>
  !result ? theme.toolRunning : result.isError ? theme.toolError : theme.toolDone;

const pad = (n: number) => String(n).padStart(2, "0");
/** Local time as fixed-width `YYYY-MM-DD HH:MM`, so titles line up. */
export const stamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const k = (n: number) => `${(n / 1000).toFixed(1)}K`;
const pct = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(1)}%` : "-");

/**
 * Totals over `messages` (replies, plus tool results' own `usage`; cost too, when known) and `extra` (the session's
 * `usage`: subruns not started from a tool), context fill from the last reply, and the cache hit rate of all input.
 */
export function usageLine(messages: Message[], window?: number, extra?: Usage) {
  const replies = messages.flatMap((m) => (m.role === "assistant" && m.usage ? [m.usage] : []));
  const usages = [
    ...replies,
    ...(extra ? [extra] : []),
    ...messages.flatMap((m) =>
      m.role === "tool"
        ? m.results.flatMap((r) => (r.usage ? [r.usage] : []))
        : m.role === "assistant"
          ? m.toolCalls.flatMap((c) => (c.result?.usage ? [c.result.usage] : []))
          : [],
    ),
  ];
  const sum = (f: (u: (typeof usages)[number]) => number) => usages.reduce((n, u) => n + f(u), 0);
  const input = sum((u) => u.input);
  const ctx = window ? `${pct(contextTokens(messages), window)}/${(window / 1e6).toFixed(1)}M` : "-/-";
  const hit = pct(
    sum((u) => u.cacheRead),
    input,
  );
  // only when a provider (or wrapper) reports it
  const cost = usages.some((u) => u.cost !== undefined) ? ` $${sum((u) => u.cost ?? 0).toFixed(3)}` : "";
  return `↑ ${k(input)} ↓ ${k(sum((u) => u.output))} ${ctx} CH ${hit}${cost}`;
}
