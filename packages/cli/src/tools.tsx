import { stripVTControlCharacters } from "node:util";
import type { BashUpdate, ToolCall, ToolResult } from "@hortus/core";
import { Box, Text } from "ink";
import type { ComponentType, FunctionComponent } from "react";
import type { TextEntry, ToolSibling } from "./entry.ts";
import { theme } from "./themes.ts";
import { type Span, wrapSpans } from "./markdown.ts";

/** What a tool call's block shows. */
export interface ToolView {
  call: ToolCall;
  /** undefined while the tool runs */
  result?: ToolResult;
  /** the latest `ctx.update` while the tool runs, then the result's `details` */
  details?: unknown;
  /** columns the block's content has */
  width: number;
  /** whether blocks show everything (Ctrl+O toggles it for every block) */
  expanded?: boolean;
  /** the call's input as streamed so far (`call.input` is empty until it's complete) */
  partial?: string;
  /**
   * the calls of the same assistant message in order, this one included, with their results and details so far: a
   * renderer may draw nothing for some, to show them as a group
   */
  siblings?: ToolSibling[];
}

/** What a text entry's block shows, for a plugin's `cli.entries[kind]`. */
export interface EntryView {
  entry: TextEntry;
  /** columns the block has */
  width: number;
}

/** A text entry's renderer (`cli.entries` for a kind other than `tool:*`): like `ToolRenderer`, over an `EntryView`. */
export interface EntryRenderer {
  Render: ComponentType<EntryView & { Default: ComponentType<EntryView> }>;
  text?: (view: EntryView, Default: (view: EntryView) => string) => string;
}

/** A text entry's renderer whose text is known. */
export interface EntryBlock {
  Render: FunctionComponent<EntryView>;
  text: (view: EntryView) => string;
}

/**
 * What the host draws around a tool block: `background` (default: by status, `toolRunning`/`toolDone`/`toolError`; a
 * color, or false for none) and `padding` (a blank row above and below; default: when there's a background).
 */
export interface ToolChrome {
  background?: string | false;
  padding?: boolean;
}

/** A tool's block, as a plugin's `cli.tools` gives it. */
export interface ToolRenderer {
  /** the block's chrome; fields left out are the replaced renderer's */
  chrome?: (view: ToolView) => ToolChrome;
  /** draws the block inside the host's background; `Default` is the renderer this one replaced */
  Render: ComponentType<ToolView & { Default: ComponentType<ToolView> }>;
  /**
   * What `Render` shows as plain text, one line per screen row at `view.width`, for selection and copy; `Default` is the
   * replaced renderer's (so a wrapper passing `Default` a changed view returns `Default(changed)`). Without it, `Render`
   * is rendered to a string, which sees only its first render: state it sets itself (useState, effects) isn't in the
   * copy.
   */
  text?: (view: ToolView, Default: (view: ToolView) => string) => string;
}

/** A renderer whose text is known, as every built-in one is. */
export interface ToolBlock {
  // a function component, so it fits `ToolRenderer.Render` (it just ignores `Default`)
  Render: FunctionComponent<ToolView>;
  text: (view: ToolView) => string;
  chrome?: (view: ToolView) => ToolChrome;
}

/** Splits styled lines into screen rows of at most `width` columns, wrapping the way the transcript wraps text. */
export function wrapLines(lines: Span[][], width: number): Span[][] {
  return lines.flatMap((spans) => wrapSpans(spans, Math.max(1, width)));
}

/**
 * A renderer drawing `lines` (styled, unwrapped) and copying exactly what it draws: rows are wrapped here, not by Ink.
 * Enough for most tools; reach for a component when a block needs layout or state.
 */
export function linesRenderer(lines: (view: ToolView) => Span[][]): ToolBlock {
  return {
    // biome-ignore lint/correctness/noComponentHookFactories: made once per renderer, not per render
    Render: (view) => (
      <Box flexDirection="column">
        {wrapLines(lines(view), view.width).map((spans, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
          <Text key={i} wrap="truncate">
            {spans.length
              ? spans.map(({ text, ...style }, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional
                  <Text key={j} {...style}>
                    {text}
                  </Text>
                ))
              : " "}
          </Text>
        ))}
      </Box>
    ),
    text: (view) =>
      wrapLines(lines(view), view.width)
        .map((spans) => spans.map((s) => s.text).join(""))
        .join("\n"),
  };
}

/** Keeps the first (or last) `n` lines, noting how many were cut. */
function preview(text: string, n: number, fromEnd = false) {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length <= n) return lines;
  const more = `... (${lines.length - n} ${fromEnd ? "earlier" : "more"} lines)`;
  return fromEnd ? [more, ...lines.slice(-n)] : [...lines.slice(0, n), more];
}

/** What a terminal leaves of `s`: each line from its last `\r` (progress bars), without escapes or control characters. */
const screenText = (s: string) =>
  stripVTControlCharacters(s)
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((l) => l.slice(l.lastIndexOf("\r") + 1).replace(/(?!\t)\p{Cc}/gu, ""))
    .join("\n");

const output = (r?: ToolResult) =>
  r && (r.images?.length ? `${r.output ? `${r.output}\n` : ""}${"[image]".repeat(r.images.length)}` : r.output);
const muted = (lines: string[]) => lines.map((text): Span[] => [{ text, color: theme.toolOutput }]);

/** pi's tool block: a bold one-line header, then a blank line and a short preview of the input or result. */
const block = (head: string, body: Span[][]): Span[][] => [
  [{ text: head, bold: true, color: theme.toolTitle }],
  ...(body.length ? [[], ...body] : []),
];

/**
 * The call's input; while it still streams (`input` unset), the string fields `partial` has so far, the last one
 * possibly cut short.
 */
const input = ({ call, partial }: ToolView): Record<string, unknown> => {
  if (call.input) return call.input as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  // ponytail: top-level string fields only (by regex, nested keys too); a partial JSON parser if numbers matter
  for (const [, key, value] of (partial ?? "").matchAll(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)/g)) {
    try {
      fields[key as string] = JSON.parse(`"${value}"`);
    } catch {} // a \u escape cut short
  }
  return fields;
};

/** Any tool without a renderer of its own: its name and JSON input, then the start of its output. */
export const genericTool = linesRenderer(({ call, result, partial }) => {
  const out = output(result);
  return block(
    `${call.name} ${call.input ? JSON.stringify(call.input) : (partial ?? "")}`,
    out ? muted(preview(out, 10)) : [],
  );
});

/** The built-in tools' renderers, by tool name. */
export const builtinTools: Record<string, ToolBlock> = {
  bash: linesRenderer((view) => {
    const { result, details } = view;
    // while running, builtin:bash's live output (`BashUpdate`)
    const live = !result && (details as BashUpdate | undefined)?.output;
    const out = live || output(result);
    return block(`$ ${input(view).command ?? ""}`, out ? muted(preview(screenText(out), 5, true)) : []);
  }),
  read: linesRenderer((view) => {
    const { result } = view;
    const i = input(view);
    const from = Number(i.offset ?? 1);
    const range = i.offset || i.limit ? `:${from}${i.limit ? `-${from + Number(i.limit) - 1}` : ""}` : "";
    const out = output(result);
    return block(`read ${i.path ?? ""}${range}`, out ? muted(preview(out, 10)) : []);
  }),
  write: linesRenderer((view) => {
    const { result } = view;
    const i = input(view);
    const out = output(result);
    return block(`write ${i.path ?? ""}`, muted(preview(result?.isError && out ? out : String(i.content ?? ""), 10)));
  }),
  edit: linesRenderer((view) => {
    const { result } = view;
    const i = input(view);
    const out = output(result);
    if (result?.isError && out) return block(`edit ${i.path ?? ""}`, muted(preview(out, 10)));
    const edits = (Array.isArray(i.edits) ? i.edits : []) as { oldText?: string; newText?: string }[];
    const diff = edits.flatMap((e) => [
      ...String(e.oldText ?? "")
        .split("\n")
        .map((l) => `- ${l}`),
      ...String(e.newText ?? "")
        .split("\n")
        .map((l) => `+ ${l}`),
    ]);
    return block(
      `edit ${i.path ?? ""}`,
      preview(diff.join("\n"), 10).map((text): Span[] => [
        {
          text,
          color: text.startsWith("+ ")
            ? theme.toolDiffAdded
            : text.startsWith("- ")
              ? theme.toolDiffRemoved
              : theme.toolDiffContext,
        },
      ]),
    );
  }),
};
