import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Ctx, hortusDir, stateOf } from "@hortus/core";

export const FETCH_MODES = ["readable", "raw", "answer", "extract"] as const;
export type FetchMode = (typeof FETCH_MODES)[number];
export type Workflow = "none" | "auto-summary";

/** `~/.hortus/<plugin>.json` (Pi's `~/.pi/agent/web-search.json`, minus credentials: those live in secrets.json). */
export interface Config {
  /** default search provider: "auto", "all", a name, or comma-separated names */
  provider?: string;
  workflow?: Workflow;
  /** "provider/model" for auto-summary; default the run's */
  summaryModel?: string;
  summaryTimeoutMs?: number;
  /** extra summary instructions */
  summaryInstructions?: string;
  openaiSearchModel?: string;
  maxInlineContentChars?: number;
  fetch?: { allowedModes?: FetchMode[]; defaultMode?: FetchMode; answerModel?: string };
  github?: { maxRepoSizeMB?: number; cloneDir?: string };
  /** "eager" (default; Pi's "auto" without mid-conversation tool changes) or "dynamic" (`web_enable` loads them) */
  toolActivation?: "eager" | "dynamic";
  /** "deferred": callable from codemode only (Pi's deferred exposure) */
  toolExposure?: "direct" | "deferred";
  tools?: Partial<
    Record<"web_search" | "source_check" | "fetch_content" | "get_search_content", { enabled?: boolean }>
  >;
}

export const configPath = (ctx: Pick<Ctx, "plugin">) => join(hortusDir(), `${ctx.plugin}.json`);

/** Re-read on every use, as Pi does, so `/curator` and hand edits apply to the next call. */
export async function loadConfig(ctx: Pick<Ctx, "plugin">): Promise<Config> {
  try {
    return JSON.parse(await readFile(configPath(ctx), "utf8")) as Config;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Failed to read ${configPath(ctx)}: ${(e as Error).message}`);
  }
}

export async function saveConfig(ctx: Pick<Ctx, "plugin">, patch: Partial<Config>) {
  const path = configPath(ctx);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ ...(await loadConfig(ctx)), ...patch }, null, 2)}\n`);
  await rename(tmp, path);
}

export const maxInline = ({ maxInlineContentChars: n }: Config) => (n && Number.isInteger(n) && n > 0 ? n : 30_000);

/** `fn` over `items`, up to three at a time, results in order (Pi's `p-limit(3)`). */
export async function limit3<T, R>(items: T[], fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  const queue = [...items.entries()];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) out[next[0]] = await fn(next[1], next[0]);
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

/** "provider/model" → its parts (Pi's `parseModelSelector`). */
export function modelRef(value: string | undefined): { provider?: string; model?: string } {
  if (!value) return {};
  const i = value.indexOf("/");
  if (i <= 0 || i === value.length - 1) throw new Error(`Invalid model: ${value}. Use provider/model-id.`);
  return { provider: value.slice(0, i), model: value.slice(i + 1) };
}

/**
 * What a one-off `ctx.complete` (page answers, summaries, extraction) runs with: no thinking (core fits "off" to the
 * model's lowest level when it can't turn thinking off, Pi's `resolveThinkingLevel(model, "off")`), and its window.
 */
export async function quiet(ctx: Ctx, model: string | undefined) {
  const ref = modelRef(model);
  const info = (await ctx.resolve(ref).catch(() => undefined))?.info ?? {};
  return { request: { ...ref, effort: "off" as const }, window: info.contextWindow };
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const isAbort = (e: unknown) => e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));

/** One request in the activity log (Pi's `ActivityEntry`). */
export interface Activity {
  type: "api" | "fetch";
  target: string;
  start: number;
  end?: number;
  /** null while running, 0 aborted */
  status: number | null;
  error?: string;
}

interface ActivityState {
  log: Activity[];
  visible: boolean;
}

export const activityOf = (ctx: Ctx) => stateOf(ctx, "activity", (): ActivityState => ({ log: [], visible: false }));

/** The activity "widget", folded into one status entry: counts, then the latest request. */
export function showActivity(ctx: Ctx) {
  const a = activityOf(ctx);
  if (!a.visible) return void ctx.status("web-activity");
  const n = (f: (e: Activity) => boolean) => a.log.filter(f).length;
  const last = a.log.at(-1);
  const line = last
    ? ` · ${last.type === "api" ? "API" : "GET"} ${last.target.replace(/^https?:\/\//, "").slice(0, 32)} ${
        last.error ? "err" : last.status === null ? "…" : last.status
      } ${(((last.end ?? Date.now()) - last.start) / 1000).toFixed(1)}s`
    : " · no activity yet";
  void ctx.status(
    "web-activity",
    `web ${n((e) => !!e.status && !e.error && e.status < 300)}✓ ${n((e) => !!e.error || (e.status ?? 0) >= 300)}✗ ${n((e) => e.status === null && !e.error)}⋯${line}`,
  );
}

/** `ctx.fetch`, logged in the activity monitor; a non-2xx answer throws `<label> error <status>: <body>`. */
export async function http(
  ctx: Ctx,
  activity: Pick<Activity, "type" | "target">,
  label: string,
  url: string,
  init: RequestInit & { signal: AbortSignal; timeoutMs?: number },
): Promise<Response> {
  const a = activityOf(ctx);
  const entry: Activity = { ...activity, start: Date.now(), status: null };
  a.log = [...a.log.slice(-9), entry];
  showActivity(ctx);
  try {
    const res = await ctx.fetch(url, {
      ...init,
      signal: AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs ?? 60_000)]),
    });
    entry.status = res.status;
    // a redirect is the caller's to follow (fetch_content checks each hop)
    if (!res.ok && !(res.status >= 300 && res.status < 400))
      throw new Error(`${label} error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  } catch (e) {
    if (isAbort(e)) entry.status = 0;
    else entry.error = errorText(e);
    throw e;
  } finally {
    entry.end = Date.now();
    showActivity(ctx);
  }
}
