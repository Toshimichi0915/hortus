import type { ToolCall, ToolResult } from "@hortus/core";
import { Box, Text } from "ink";
import type { ComponentType, FunctionComponent } from "react";
import stringWidth from "string-width";
import { theme } from "./entry.ts";
import { cutCols, type Span, wrap } from "./markdown.ts";

/** What a tool call's block shows. */
export interface ToolView {
  call: ToolCall;
  /** undefined while the tool runs */
  result?: ToolResult;
  /** the latest `ToolContext.update` while the tool runs, then the result's `details` */
  details?: unknown;
  /** columns the block's content has */
  width: number;
}

/** A tool's block, as a plugin's `cli.tools` gives it. */
export interface ToolRenderer {
  /** draws the block inside the host's background; `Default` is the renderer this one replaced */
  Render: ComponentType<ToolView & { Default: ComponentType<ToolView> }>;
  /**
   * What `Render` shows as plain text, one line per screen row at `view.width`, for selection and copy. Without it,
   * `Render` is rendered to a string, which sees only its first render: state it sets itself (useState, effects)
   * isn't in the copy.
   */
  text?: (view: ToolView) => string;
}

/** A renderer whose text is known, as every built-in one is. */
export interface ToolBlock {
  // a function component, so it fits `ToolRenderer.Render` (it just ignores `Default`)
  Render: FunctionComponent<ToolView>;
  text: (view: ToolView) => string;
}

/** Splits styled lines into screen rows of at most `width` columns, wrapping the way the transcript wraps text. */
export function wrapLines(lines: Span[][], width: number): Span[][] {
  return lines.flatMap((spans) => {
    let col = 0;
    return wrap(spans.map((s) => s.text).join(""), Math.max(1, width)).map((text) => {
      const w = stringWidth(text);
      const row = cutCols(spans, col, col + w);
      col += w;
      return row;
    });
  });
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

const output = (r?: ToolResult) => r && (r.image ? `${r.output ? `${r.output}\n` : ""}[image]` : r.output);
const muted = (lines: string[]) => lines.map((text): Span[] => [{ text, color: theme.muted }]);

/** pi's tool block: a bold one-line header, then a blank line and a short preview of the input or result. */
const block = (head: string, body: Span[][]): Span[][] => [
  [{ text: head, bold: true, color: theme.text }],
  ...(body.length ? [[], ...body] : []),
];

const input = (call: ToolCall) => (call.input ?? {}) as Record<string, unknown>;

/** Any tool without a renderer of its own: its name and JSON input, then the start of its output. */
export const genericTool = linesRenderer(({ call, result }) => {
  const out = output(result);
  return block(`${call.name} ${JSON.stringify(call.input)}`, out ? muted(preview(out, 10)) : []);
});

/** The built-in tools' renderers, by tool name. */
export const builtinTools: Record<string, ToolBlock> = {
  bash: linesRenderer(({ call, result }) => {
    const out = output(result);
    return block(`$ ${input(call).command}`, out ? muted(preview(out, 5, true)) : []);
  }),
  read: linesRenderer(({ call, result }) => {
    const i = input(call);
    const from = Number(i.offset ?? 1);
    const range = i.offset || i.limit ? `:${from}${i.limit ? `-${from + Number(i.limit) - 1}` : ""}` : "";
    const out = output(result);
    return block(`read ${i.path}${range}`, out ? muted(preview(out, 10)) : []);
  }),
  write: linesRenderer(({ call, result }) => {
    const i = input(call);
    const out = output(result);
    return block(`write ${i.path}`, muted(preview(result?.isError && out ? out : String(i.content ?? ""), 10)));
  }),
  edit: linesRenderer(({ call, result }) => {
    const i = input(call);
    const out = output(result);
    if (result?.isError && out) return block(`edit ${i.path}`, muted(preview(out, 10)));
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
      `edit ${i.path}`,
      preview(diff.join("\n"), 10).map((text): Span[] => [
        { text, color: text.startsWith("+ ") ? theme.green : text.startsWith("- ") ? theme.red : theme.muted },
      ]),
    );
  }),
};
