import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Ctx, hortusDir, type Plugin } from "@hortus/core";

/** One timed step of a run; `children` nest by the ids and parents events carry. */
export interface Span {
  id: string;
  name: string;
  /** epoch ms */
  start: number;
  end?: number;
  error?: string;
  attrs?: Record<string, unknown>;
  children: Span[];
}

/**
 * Each running run's root span and every span in it by id (request ids, tool call ids); a subrun's `parent` is the run
 * whose tree holds its root (under the tool call that started it).
 */
const runs = new Map<string, { root: Span; spans: Map<string, Span>; parent?: string; holder?: Span }>();
/** How many runs are being traced (none once `close` flushed them). */
export const openRuns = () => runs.size;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Opens span `id` under `parent` (a span id in the run, else the root); nothing outside a traced run. */
function open(ctx: Ctx, id: string, name: string, parent: string | undefined, attrs?: Record<string, unknown>) {
  const run = ctx.run && runs.get(ctx.run.id);
  if (!run) return;
  const span: Span = { id, name, start: Date.now(), children: [], ...(attrs && { attrs }) };
  ((parent && run.spans.get(parent)) || run.root).children.push(span);
  run.spans.set(id, span);
}

function close(ctx: Ctx, id: string, error?: unknown, attrs?: Record<string, unknown>) {
  const span = ctx.run && runs.get(ctx.run.id)?.spans.get(id);
  if (!span) return;
  span.end = Date.now();
  if (error !== undefined) span.error = message(error);
  if (attrs) span.attrs = { ...span.attrs, ...attrs };
}

/** Ends every span of each tree still open (now), then appends each tree as a line of `~/.hortus/traces.jsonl`. */
async function write(roots: Span[]) {
  if (!roots.length) return;
  const now = Date.now();
  const end = (s: Span): void => {
    s.end ??= now;
    s.children.forEach(end);
  };
  roots.forEach(end);
  await mkdir(hortusDir(), { recursive: true });
  await appendFile(join(hortusDir(), "traces.jsonl"), roots.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

/**
 * Traces every run as a span tree: the run, each provider request (under the tool whose `ctx.complete` sent it) and each
 * tool call (under its `parentId` for `ctx.runTool` calls), failures closed with their error. Each finished run is
 * appended to `~/.hortus/traces.jsonl` as one line; runs still open at exit (a tool ignoring the abort) are written in
 * `close`, their open spans ended then. A subrun's tree nests under the tool call (else the run) that started it, and is
 * written with its parent's, or on its own when it outlives it.
 */
export default {
  on: {
    run_start: ({ source, model, provider }, ctx) => {
      if (source !== "run" || !ctx.run) return;
      const root: Span = { id: ctx.run.id, name: "run", start: Date.now(), attrs: { model, provider }, children: [] };
      const { runId, toolCallId } = ctx.run.parent ?? {};
      const parent = runId ? runs.get(runId) : undefined;
      const holder = parent && ((toolCallId && parent.spans.get(toolCallId)) || parent.root);
      holder?.children.push(root);
      runs.set(ctx.run.id, { root, spans: new Map([[root.id, root]]), ...(holder && { parent: runId, holder }) });
    },
    request: ({ id, source, model }, ctx) => open(ctx, id, "request", ctx.callId, { source, model }),
    response: ({ id, error, meta, assistant }, ctx) =>
      close(ctx, id, error, { stopReason: meta?.stopReason, usage: assistant?.usage }),
    tool_call: ({ call }, ctx) => open(ctx, call.id, `tool ${call.name}`, call.parentId),
    tool_result: ({ call, result }, ctx) => close(ctx, call.id, result.isError ? result.output : undefined),
    run_end: async ({ error, aborted }, ctx) => {
      const run = ctx.run && runs.get(ctx.run.id);
      if (!run || !ctx.run) return;
      runs.delete(ctx.run.id);
      // subruns still open leave this tree, to be written on their own when they end
      for (const r of runs.values())
        if (r.parent === ctx.run.id && r.holder) {
          r.holder.children.splice(r.holder.children.indexOf(r.root), 1);
          delete r.parent;
          delete r.holder;
        }
      if (error !== undefined) run.root.error = message(error);
      if (aborted) run.root.attrs = { ...run.root.attrs, aborted };
      run.root.end = Date.now();
      // a subrun's tree goes out with its parent's, unless that one was written already
      if (!run.parent || !runs.has(run.parent)) await write([run.root]);
    },
    // runs exit cut off before their run_end
    close: async () => {
      const open = [...runs.values()].flatMap((r) => (r.parent && runs.has(r.parent) ? [] : [r.root]));
      runs.clear();
      for (const root of open) root.attrs = { ...root.attrs, exit: true };
      await write(open);
    },
  },
} satisfies Plugin;
