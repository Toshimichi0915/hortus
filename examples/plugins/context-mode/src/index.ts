/**
 * context-mode (port of the Pi package's extension and MCP server): keeps large output out of the context window.
 * - Tools run code in a subprocess and return only what it prints (`ctx_execute`, `ctx_execute_file`,
 *   `ctx_batch_execute`); large output is indexed into a per-session knowledge base instead of returned, and
 *   `ctx_search` brings back the sections that match (`ctx_index`, `ctx_fetch_and_index` index files and pages).
 * - `tool_call` blocks bash commands that would dump HTTP responses into the context (curl/wget to stdout, fetch, ...).
 * - Session continuity: tool results and prompts become session events (`context-mode:events` entries); each run's
 *   first request gets an `<active_memory>` of the important ones, and the first request after a compaction a
 *   `<session_resume>` snapshot built from all of them (at `compact`), pointing at `ctx_search` for details.
 * - `/ctx-stats` and `/ctx-doctor`.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type Ctx, hortusDir, type Plugin, type PluginEntry, type SessionState, tool } from "@hortus/core";
import { z } from "zod";
import {
  activeMemory,
  addEvent,
  buildResumeSnapshot,
  extractEvents,
  extractUserEvents,
  type SessionEvent,
} from "./events.ts";
import { type Chunk, KnowledgeBase, snippet } from "./store.ts";

/** its knowledge bases' directory in ~/.hortus */
const PLUGIN = "context-mode";
/** output over this (bytes) with an `intent` is indexed and searched for it */
const INTENT_SEARCH_THRESHOLD = 5_000;
/** output over this (bytes) is always indexed, never returned */
const LARGE_OUTPUT_THRESHOLD = 102_400;
const OUTPUT_CAP = 100 * 1024 * 1024;

interface Resume {
  snapshot?: string;
  compactCount: number;
  consumed: boolean;
}

/** What the plugin keeps per agent (`ctx.state`). */
interface State {
  /** knowledge bases by session id */
  kbs: Map<string, KnowledgeBase>;
  /** `<active_memory>` waiting for a run's first request, by run id */
  pending: Map<string, string>;
  /** snapshots built at `compact`, saved at `compacted`, by session id */
  snapshots: Map<string, string>;
  /** raw bytes the tools processed vs returned, by session id */
  bytes: Map<string, { processed: number; returned: number }>;
}

const state = (ctx: Ctx) => {
  const s = ctx.state as Partial<State>;
  s.kbs ??= new Map();
  s.pending ??= new Map();
  s.snapshots ??= new Map();
  s.bytes ??= new Map();
  return s as State;
};
const kbDir = () => join(hortusDir(), PLUGIN);
const sessionId = (ctx: Ctx) => ctx.session?.id ?? "none";
function kb(ctx: Ctx): KnowledgeBase {
  const { kbs } = state(ctx);
  const id = sessionId(ctx);
  // an in-memory session (no file) gets an in-memory knowledge base
  const k = kbs.get(id) ?? new KnowledgeBase(ctx.session?.path ? join(kbDir(), `${id}.json`) : undefined);
  kbs.set(id, k);
  return k;
}
/** what its entries replayed, `state.data[<plugin>]` */
interface Saved {
  events?: SessionEvent[];
  resume?: Resume;
}
const savedOf = (s: SessionState | undefined, plugin: string) => s?.data[plugin] as Saved | undefined;
const events = (ctx: Ctx) => savedOf(ctx.session?.getState(), ctx.plugin)?.events ?? [];
const resumeOf = (ctx: Ctx) => savedOf(ctx.session?.getState(), ctx.plugin)?.resume;
async function record(ctx: Ctx, evs: SessionEvent[]) {
  if (evs.length > 0) await ctx.session?.appendEntry(`${ctx.plugin}:events`, evs);
}
function count(ctx: Ctx, processed: string, returned: string) {
  const { bytes } = state(ctx);
  const b = bytes.get(sessionId(ctx)) ?? { processed: 0, returned: 0 };
  b.processed += Buffer.byteLength(processed);
  b.returned += Buffer.byteLength(returned);
  bytes.set(sessionId(ctx), b);
}

// ── Routing: keep raw HTTP bodies out of the context ──────────────────────────

const BLOCKED_HTTP = [
  /\bfetch\s*\(/,
  /\brequests\.get\s*\(/,
  /\brequests\.post\s*\(/,
  /\bhttp\.get\s*\(/,
  /\bhttp\.request\s*\(/,
  /\burllib\.request/,
  /\bInvoke-WebRequest\b/,
];
/** `cmd` without heredocs and quoted strings, so words inside arguments don't count. */
export const stripQuoted = (cmd: string) =>
  cmd
    .replace(/<<-?\s*["']?(\w+)["']?[\s\S]*?\n\s*\1/g, "")
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
/** A curl/wget segment is safe when silent and writing the body to a file (not stdout), without verbose output. */
export function isSafeCurlWget(segment: string): boolean {
  const s = segment.trim();
  const curl = /\bcurl\b/i.test(s);
  if (!curl && !/\bwget\b/i.test(s)) return true;
  const toFile = (curl ? /\s(-o|--output)\s/ : /\s(-O|--output-document)\s/).test(s) || /\s>>?\s*/.test(s);
  if (!toFile) return false;
  if (
    (curl ? /\s(-o|--output)\s+(-|\/dev\/stdout)(\s|$)/ : /\s(-O|--output-document)\s+(-|\/dev\/stdout)(\s|$)/).test(s)
  )
    return false;
  if (/\s(-v|--verbose|--trace)\b/.test(s)) return false;
  return (curl ? /\s-[a-zA-Z]*s|--silent/ : /\s-[a-zA-Z]*q|--quiet/).test(s);
}
/** Why a bash command is blocked, if it is. */
export function blockReason(command: string): string | undefined {
  const stripped = stripQuoted(command);
  const hint = "Use context-mode tools (ctx_execute, ctx_fetch_and_index) instead of inline HTTP clients. ";
  if (BLOCKED_HTTP.some((p) => p.test(stripped)))
    return `${hint}Raw fetch/requests/http output floods the context window.`;
  if (
    /(^|\s|&&|\||;)(curl|wget)\s/i.test(stripped) &&
    stripped.split(/\s*(?:&&|\|\||;)\s*/).some((s) => !isSafeCurlWget(s))
  )
    return `${hint}Raw curl/wget output floods the context window. For an escape hatch, use silent + file output: \`curl -s -o /tmp/x.json URL\` or \`wget -q -O /tmp/x.json URL\`.`;
}

// ── Running code ──────────────────────────────────────────────────────────────

const LANGUAGES = ["javascript", "typescript", "python", "shell"] as const;
type Language = (typeof LANGUAGES)[number];
// ponytail: four runtimes (node, node's type stripping, python3, bash), not context-mode's twelve; add one by its
// file extension and command here
const RUNTIME: Record<Language, { ext: string; cmd: string }> = {
  javascript: { ext: "cjs", cmd: "node" },
  typescript: { ext: "cts", cmd: "node" },
  python: { ext: "py", cmd: "python3" },
  shell: { ext: "sh", cmd: "bash" },
};

interface Exec {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** Runs `code` from a script in a temp dir, in `cwd`; JS/TS as an async function body (top-level `await`, `require`). */
async function run(
  language: Language,
  code: string,
  cwd: string,
  signal: AbortSignal,
  timeout?: number,
): Promise<Exec> {
  const dir = await mkdtemp(join(tmpdir(), ".ctx-mode-"));
  try {
    const { ext, cmd } = RUNTIME[language];
    const file = join(dir, `script.${ext}`);
    const js = language === "javascript" || language === "typescript";
    await writeFile(
      file,
      js ? `(async () => {\n${code}\n})().catch((e) => { console.error(e); process.exitCode = 1; });\n` : code,
    );
    return await new Promise<Exec>((done) => {
      const child = spawn(cmd, [file], { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const kill = () => child.kill("SIGKILL");
      const timer = timeout
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, timeout)
        : undefined;
      child.stdout.on("data", (d) => {
        stdout += d;
        if (stdout.length + stderr.length > OUTPUT_CAP) kill();
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      const finish = (exitCode: number) => {
        clearTimeout(timer);
        done({ stdout, stderr, exitCode, timedOut });
      };
      child.on("error", (e) => {
        stderr += String(e);
        finish(127);
      });
      child.on("close", (c) => finish(c ?? 1));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Indexes `output` as plain text and returns only the titles and first lines of the sections matching `intent`. */
function intentSearch(k: KnowledgeBase, output: string, intent: string, source: string): string {
  const lines = output.split("\n").length;
  const kb = (Buffer.byteLength(output) / 1024).toFixed(1);
  const indexed = k.index(output, source, true);
  const results = k.search(intent, 5, source);
  const terms = k.terms(source);
  const out = [`Indexed ${indexed.total} sections from "${source}" into knowledge base.`];
  if (results.length === 0) out.push(`No sections matched intent "${intent}" in ${lines}-line output (${kb}KB).`);
  else {
    out.push(`${results.length} sections matched "${intent}" (${lines} lines, ${kb}KB):`, "");
    for (const r of results) out.push(`  - ${r.title}: ${r.content.split("\n")[0]?.slice(0, 120)}`);
  }
  if (terms.length > 0) out.push("", `Searchable terms: ${terms.join(", ")}`);
  out.push(
    "",
    results.length === 0
      ? "Use ctx_search(queries: [...]) to explore the indexed content."
      : "Use ctx_search(queries: [...]) to retrieve full content of any section.",
  );
  return out.join("\n");
}

/**
 * What `ctx_execute(_file)` returns for a run: its source echoed, then its output, unless large: with an `intent`, over
 * 5 KB, only the sections matching it; over 100 KB, a pointer to the indexed output.
 */
function present(ctx: Ctx, r: Exec, o: { language: Language; code: string; path?: string; intent?: string }) {
  const echo = `${o.path ? `path=${o.path}\n` : ""}\`\`\`${o.language}\n${o.code.length > 2000 ? `${o.code.slice(0, 2000)}\n… (truncated)` : o.code}\n\`\`\`\n\n`;
  const source = o.path ? `file:${o.path}` : `execute:${o.language}`;
  const k = kb(ctx);
  const big = (s: string, n: number) => Buffer.byteLength(s) > n;
  const intent = o.intent?.trim();
  let text: string;
  let isError = false;
  if (r.timedOut) {
    const partial = r.stdout.trim();
    text = partial
      ? `${partial}\n\n_(timed out — partial output shown above)_`
      : `Execution timed out\n\nstderr:\n${r.stderr}`;
    isError = !partial;
  } else if (r.exitCode !== 0) {
    // a shell exiting 1 with output (grep finding nothing, diff finding something) isn't an error
    const soft = o.language === "shell" && r.exitCode === 1 && r.stdout.trim().length > 0;
    isError = !soft;
    const output = soft ? r.stdout : `Exit code: ${r.exitCode}\n\nstdout:\n${r.stdout}\n\nstderr:\n${r.stderr}`;
    const label = isError ? `${source}:error` : source;
    text =
      intent && big(output, INTENT_SEARCH_THRESHOLD)
        ? intentSearch(k, output, intent, label)
        : big(output, LARGE_OUTPUT_THRESHOLD)
          ? intentSearch(k, output, "errors failures exceptions", label)
          : output;
  } else {
    const stdout = r.stdout || "(no output)";
    if (intent && big(stdout, INTENT_SEARCH_THRESHOLD)) text = intentSearch(k, stdout, intent, source);
    else if (big(stdout, LARGE_OUTPUT_THRESHOLD)) {
      const indexed = k.index(stdout, source);
      text = `Indexed ${indexed.total} sections (${indexed.code} with code) from: ${indexed.source}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${indexed.source}" to scope results.`;
    } else text = stdout;
  }
  count(ctx, r.stdout + r.stderr, echo + text);
  return { output: echo + text, isError };
}

/** Within `cwd`: ctx_execute_file can't reach files the project's own tools wouldn't. */
function inProject(cwd: string, path: string): string {
  const abs = resolve(cwd, path);
  const rel = relative(cwd, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is outside the project (${cwd})`);
  return abs;
}

/** Puts the file's path and content in `FILE_CONTENT_PATH`/`file_path`/`FILE_CONTENT` ahead of `code`. */
function withFileContent(language: Language, path: string, code: string): string {
  const p = JSON.stringify(path);
  const sq = `'${path.replace(/'/g, "'\\''")}'`;
  if (language === "python")
    return `FILE_CONTENT_PATH = ${p}\nfile_path = FILE_CONTENT_PATH\nwith open(FILE_CONTENT_PATH, "r", encoding="utf-8") as _f:\n    FILE_CONTENT = _f.read()\n${code}`;
  if (language === "shell") return `FILE_CONTENT_PATH=${sq}\nfile_path=${sq}\nFILE_CONTENT=$(cat ${sq})\n${code}`;
  return `const FILE_CONTENT_PATH = ${p};\nconst file_path = FILE_CONTENT_PATH;\nconst FILE_CONTENT = require("fs").readFileSync(FILE_CONTENT_PATH, "utf-8");\n${code}`;
}

/** HTML as markdown enough to chunk by heading: headings, list items and paragraphs kept, other markup dropped. */
export function htmlToMarkdown(html: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
  return html
    .replace(/<(script|style|noscript|head|svg|nav|footer)[\s\S]*?<\/\1>/gi, "")
    .replace(
      /<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, n, t) => `\n\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`,
    )
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n\n```\n$1\n```\n\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|\/p|\/div|\/tr|\/ul|\/ol)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => entities[e] ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The session events as chunks of the `session-events` source, so `ctx_search` (and the snapshot's calls) reach them. */
const eventChunks = (ctx: Ctx): Chunk[] =>
  events(ctx).map((e) => ({
    source: "session-events",
    title: `${e.category}: ${e.type}`,
    content: e.data,
    code: false,
  }));

function statsText(ctx: Ctx): string {
  if (!ctx.session) return "context-mode: no active session";
  const evs = events(ctx);
  const lines = [
    "## context-mode stats",
    "",
    `- Session: \`${ctx.session.id.slice(0, 8)}...\``,
    `- Events captured: ${evs.length}`,
    `- Compactions: ${resumeOf(ctx)?.compactCount ?? 0}`,
  ];
  const byCategory = new Map<string, number>();
  for (const e of evs) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + 1);
  if (byCategory.size > 0) {
    lines.push("- Event breakdown:");
    for (const [category, n] of byCategory) lines.push(`  - ${category}: ${n}`);
  }
  const k = kb(ctx);
  lines.push(`- Knowledge base: ${k.sources().size} sources, ${k.chunks.length} sections`);
  const b = state(ctx).bytes.get(ctx.session.id);
  if (b && b.processed > 0)
    lines.push(
      `- Output processed: ${(b.processed / 1024).toFixed(1)}KB, returned to context: ${(b.returned / 1024).toFixed(1)}KB`,
    );
  return lines.join("\n");
}

const languageSchema = z.enum(LANGUAGES).describe("Runtime language");
const timeoutSchema = z.coerce.number().optional().describe("Max execution time in ms; none by default (Esc stops it)");
const intentSchema = z
  .string()
  .optional()
  .describe(
    "What you're looking for in the output. When provided and output is large (>5KB), indexes output into knowledge base and returns section titles + previews — not full content. Use ctx_search(queries: [...]) to retrieve specific sections.",
  );

export default {
  tools: [
    tool({
      name: "ctx_execute",
      effects: { code: ["code"] },
      description: `Run code in a subprocess (${LANGUAGES.join(", ")}; JS/TS as an async function body). Only what your code prints enters your context: the bytes it processes never do.

WHEN: you would derive an answer FROM data (filter, count, aggregate, parse); output size can't be predicted (repo-wide greps, list endpoints, log scans). Pass an \`intent\` when output may be large: over ~5KB it is indexed and only matching section titles come back, retrievable with ctx_search.
WHEN NOT: a short command whose whole output you need (pwd, git status); file edits.`,
      prompt:
        "context-mode active. Hierarchy: ctx_batch_execute > ctx_execute > ctx_execute_file > ctx_search. Read/edit files → ctx_execute_file. Multi-command research → ctx_batch_execute. Web pages → ctx_fetch_and_index then ctx_search. Index docs → ctx_index. Stats → ctx_stats.",
      inputSchema: z.object({
        language: languageSchema,
        code: z.string().describe("Source to run. Print (console.log, print, echo) only a summary."),
        timeout: timeoutSchema,
        cwd: z.string().optional().describe("Working directory (default: the project's)"),
        intent: intentSchema,
      }),
      execute: async ({ language, code, timeout, cwd, intent }, ctx) => {
        const r = await run(language, code, resolve(ctx.cwd, cwd ?? "."), ctx.signal, timeout);
        const { output, isError } = present(ctx, r, { language, code, intent });
        if (isError) throw new Error(output);
        return output;
      },
    }),
    tool({
      name: "ctx_execute_file",
      effects: { reads: ["path"], code: ["code"] },
      description: `Read a file into a FILE_CONTENT variable and run code over it; only what you print enters your context, the file's bytes stay in the subprocess.

WHEN: you want to KNOW SOMETHING ABOUT a file (counts, matches, parsed structure) without seeing all of it; large logs, CSV, JSON.
WHEN NOT: you will edit the file (read it so the edit matches); you need one known line.`,
      inputSchema: z.object({
        path: z.string().describe("File path, absolute or relative to the project"),
        language: languageSchema,
        code: z.string().describe("Code processing FILE_CONTENT; print a summary"),
        timeout: timeoutSchema,
        intent: intentSchema,
      }),
      execute: async ({ path, language, code, timeout, intent }, ctx) => {
        const abs = inProject(ctx.cwd, path);
        const r = await run(language, withFileContent(language, abs, code), ctx.cwd, ctx.signal, timeout);
        const { output, isError } = present(ctx, r, { language, code, path, intent });
        if (isError) throw new Error(output);
        return output;
      },
    }),
    tool({
      name: "ctx_index",
      description: `Store content in the searchable knowledge base: markdown split by headings, code blocks kept whole. Nothing is echoed back; retrieve sections with ctx_search.

WHEN: docs, API references, READMEs, large tool output you'll consult again. WHEN NOT: logs and build output (use ctx_execute_file).`,
      inputSchema: z.object({
        content: z.string().optional().describe("Raw text/markdown to index. Provide this OR path."),
        path: z.string().optional().describe("File to read and index (its content never enters context)"),
        source: z.string().optional().describe("Label for the indexed content"),
      }),
      execute: async ({ content, path, source }, ctx) => {
        if (!content && !path) throw new Error("Either content or path must be provided");
        // ponytail: one file per call; context-mode also walks directories (globs, .gitignore, depth and file caps)
        const text = content || (await readFile(resolve(ctx.cwd, path ?? ""), "utf8"));
        const label = source ?? path ?? "untitled";
        const indexed = kb(ctx).index(text, label);
        count(ctx, text, "");
        return `Indexed ${indexed.total} sections (${indexed.code} with code) from: ${label}\nUse ctx_search(queries: ["..."]) to query this content. Use source: "${label}" to scope results.`;
      },
    }),
    tool({
      name: "ctx_search",
      description: `Search the knowledge base: content indexed this session (ctx_index, ctx_fetch_and_index, ctx_batch_execute, large ctx_execute output) and the session's own memory (source "session-events": files, errors, decisions, git, goals). Batch every question into one call.

RETURNS: per query, the best sections with snippets around the matched terms. Use 2-4 specific technical terms per query.`,
      inputSchema: z.object({
        queries: z.array(z.string()).min(1).describe("Search queries; batch all questions in one call"),
        limit: z.coerce.number().optional().describe("Results per query (default: 3)"),
        source: z.string().optional().describe("Only sources whose label contains this"),
      }),
      execute: async ({ queries, limit = 3, source }, ctx) => {
        const k = kb(ctx);
        const extra = eventChunks(ctx);
        if (k.chunks.length === 0 && extra.length === 0)
          throw new Error(
            "Knowledge base is empty — no content has been indexed yet. Gather and index first: ctx_batch_execute(commands, queries), ctx_fetch_and_index(url), or ctx_index(content, source).",
          );
        // ponytail: no flood guard (context-mode throttles and finally blocks rapid repeated searches)
        let total = 0;
        const sections = queries.map((q) => {
          if (total > 40 * 1024) return `## ${q}\n(output cap reached)\n`;
          const results = k.search(q, limit, source, extra);
          if (results.length === 0) return `## ${q}\nNo results found.`;
          const text = results
            .map((r) => `--- [current-session | ${r.source}] ---\n### ${r.title}\n\n${snippet(r.content, q)}`)
            .join("\n\n");
          total += text.length;
          return `## ${q}\n\n${text}`;
        });
        return sections.join("\n\n---\n\n");
      },
    }),
    tool({
      name: "ctx_fetch_and_index",
      description: `Fetch a URL, convert HTML to markdown (JSON pretty-printed, text as is) and index it. The page's bytes never enter your context; query it with ctx_search(source: "<label>").

WHEN: docs, changelogs, API references from the web. WHEN NOT: SPA pages that need JavaScript to render.`,
      inputSchema: z.object({
        url: z.string().describe("The URL to fetch"),
        source: z.string().optional().describe("Label for the indexed content (default: the URL)"),
      }),
      execute: async ({ url, source }, ctx) => {
        // ponytail: one URL per call and no on-disk TTL cache (context-mode batches `requests` and caches 24h)
        const res = await ctx.fetch(url, { signal: ctx.signal });
        if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
        const body = await res.text();
        const type = res.headers.get("content-type") ?? "";
        let text = body;
        if (type.includes("json")) {
          try {
            text = JSON.stringify(JSON.parse(body), null, 2);
          } catch {
            // not JSON after all: index as text
          }
        } else if (type.includes("html") || /^\s*<(!doctype|html)/i.test(body)) text = htmlToMarkdown(body);
        if (!text.trim()) throw new Error(`Fetched ${url} but got empty content`);
        const label = source ?? url;
        const indexed = kb(ctx).index(text, label, type.includes("json"));
        count(ctx, body, "");
        return `Fetched and indexed **${indexed.total} sections** (${(Buffer.byteLength(text) / 1024).toFixed(1)}KB) from: ${label}\nFull content indexed — use ctx_search(queries: [...], source: "${label}") for specific lookups.`;
      },
    }),
    tool({
      name: "ctx_batch_execute",
      effects: { code: ["commands"] },
      description: `Run several shell commands in ONE call: every command's output is indexed, and the sections matching \`queries\` come back in the same round trip.

WHEN: 3+ related commands (git log + diff + blame, several gh issue views); gathering AND querying at once. Use concurrency 2-8 for I/O-bound commands, 1 for CPU-bound or stateful ones.`,
      inputSchema: z.object({
        commands: z
          .array(z.object({ label: z.string().describe("Section header for its output"), command: z.string() }))
          .min(1),
        queries: z.array(z.string()).min(1).describe("Search queries over the output: put ALL your questions here"),
        timeout: timeoutSchema,
        concurrency: z.coerce.number().int().min(1).max(8).optional().describe("Commands run in parallel (default 1)"),
        cwd: z.string().optional().describe("Working directory for all commands"),
      }),
      execute: async ({ commands, queries, timeout, concurrency = 1, cwd }, ctx) => {
        for (const c of commands) {
          const reason = blockReason(c.command);
          if (reason) throw new Error(reason);
        }
        const dir = resolve(ctx.cwd, cwd ?? ".");
        const outputs: string[] = [];
        let next = 0;
        // ponytail: a per-command timeout at every concurrency (context-mode shares one budget when sequential)
        await Promise.all(
          Array.from({ length: Math.min(concurrency, commands.length) }, async () => {
            for (let i = next++; i < commands.length; i = next++) {
              const c = commands[i];
              if (!c) break;
              const r = await run("shell", c.command, dir, ctx.signal, timeout);
              const out = [r.stdout, r.stderr].filter(Boolean).join(r.stdout.endsWith("\n") ? "" : "\n");
              const echoed = c.command.replace(/\s+/g, " ").trim();
              outputs[i] =
                `# ${c.label}\n\n$ ${echoed.length > 500 ? `${echoed.slice(0, 500)}…` : echoed}\n\n${out || "(no output)"}${r.timedOut ? "\n(timed out)" : ""}\n`;
            }
          }),
        );
        const stdout = outputs.join("\n");
        const k = kb(ctx);
        const source = `batch:${commands
          .map((c) => c.label)
          .join(",")
          .slice(0, 80)}`;
        const indexed = k.index(stdout, source);
        const sections = k.chunks.filter((c) => c.source === source);
        let size = 0;
        const results = queries.flatMap((q) => {
          if (size > 80 * 1024)
            return [`## ${q}\n(output cap reached — use ctx_search(queries: ["${q}"]) for details)\n`];
          const hits = k.search(q, 3, source);
          if (hits.length === 0) return [`## ${q}`, "", "No matching sections found.", ""];
          return [
            `## ${q}`,
            "",
            ...hits.flatMap((h) => {
              const s = snippet(h.content, q, 3000);
              size += s.length + h.title.length;
              return [`### ${h.title}`, s, ""];
            }),
          ];
        });
        const terms = k.terms(source);
        const text = [
          `Executed ${commands.length} commands (${stdout.split("\n").length} lines, ${(Buffer.byteLength(stdout) / 1024).toFixed(1)}KB). Indexed ${indexed.total} sections. Searched ${queries.length} queries.`,
          "",
          "## Commands",
          "",
          ...commands.map((c) => `- ${c.label}: \`${c.command.replace(/\s+/g, " ").trim().slice(0, 500)}\``),
          "",
          "## Indexed Sections",
          "",
          ...sections.map((s) => `- ${s.title} (${(Buffer.byteLength(s.content) / 1024).toFixed(1)}KB)`),
          "",
          ...results,
          terms.length > 0 ? `\nSearchable terms for follow-up: ${terms.join(", ")}` : "",
        ].join("\n");
        count(ctx, stdout, text);
        return text;
      },
    }),
    tool({
      name: "ctx_stats",
      description:
        "context-mode statistics for this session: events captured, compactions, knowledge base size, output kept out of context.",
      inputSchema: z.object({}),
      execute: async (_, ctx) => statsText(ctx),
    }),
  ],
  entries: {
    events: (entry: PluginEntry<SessionEvent[]>, s, plugin) => {
      let list = savedOf(s, plugin)?.events ?? [];
      for (const ev of entry.data) list = addEvent(list, ev);
      s.data[plugin] = { ...savedOf(s, plugin), events: list };
    },
    resume: (entry: PluginEntry<Resume>, s, plugin) => {
      s.data[plugin] = { ...savedOf(s, plugin), resume: entry.data };
    },
  },
  on: {
    init: () => {
      // knowledge bases of sessions untouched for 14 days go
      if (!existsSync(kbDir())) return;
      for (const f of readdirSync(kbDir())) {
        const path = join(kbDir(), f);
        if (Date.now() - statSync(path).mtimeMs > 14 * 86_400_000) rmSync(path, { force: true });
      }
    },
    input: (p, ctx) => record(ctx, extractUserEvents(p.text)),
    tool_call: (p) => {
      if (p.call.name !== "bash" || p.result) return;
      const { command } = p.call.input as { command?: unknown };
      const reason = typeof command === "string" ? blockReason(command) : undefined;
      if (reason) p.result = { id: p.call.id, output: `Blocked by context-mode: ${reason}`, isError: true };
    },
    tool_result: (p, ctx) => {
      // its own tools are lookups, not work worth remembering
      if (p.call.name.startsWith("ctx_")) return;
      const input = typeof p.call.input === "object" && p.call.input ? (p.call.input as Record<string, unknown>) : {};
      return record(
        ctx,
        extractEvents({ name: p.call.name, input, output: p.result.output, isError: p.result.isError }),
      );
    },
    run_start: (p, ctx) => {
      if (p.source !== "run" || !ctx.run) return;
      const memory = activeMemory(events(ctx));
      if (memory) state(ctx).pending.set(ctx.run.id, memory);
    },
    // Pi's `context` hook: appended to the request, never saved, so the system prompt (and its cache) stays put
    request: async (p, ctx) => {
      if (p.source !== "run" || !ctx.run) return;
      const { pending } = state(ctx);
      const parts: string[] = [];
      const memory = pending.get(ctx.run.id);
      if (memory) parts.push(memory);
      pending.delete(ctx.run.id);
      const resume = resumeOf(ctx);
      if (resume?.snapshot && !resume.consumed) {
        parts.push(resume.snapshot);
        await ctx.session?.appendEntry(`${ctx.plugin}:resume`, { ...resume, consumed: true });
      }
      if (parts.length > 0) p.messages.push({ role: "user", content: parts.join("\n\n") });
    },
    turn_end: (p, ctx) => {
      const u = p.assistant.usage;
      if (!u || u.input + u.output + u.cacheRead + (u.cacheWrite ?? 0) === 0) return;
      const parts = [`tokens_in:${u.input}`, `tokens_out:${u.output}`];
      if (u.cacheWrite) parts.push(`cache_create:${u.cacheWrite}`);
      if (u.cacheRead) parts.push(`cache_read:${u.cacheRead}`);
      if (u.cost !== undefined) parts.push(`cost_usd:${u.cost.toFixed(4)}`);
      return record(ctx, [{ type: "agent_usage", category: "cost", data: parts.join(" "), priority: 2 }]);
    },
    run_end: (_, ctx) => {
      if (ctx.run) state(ctx).pending.delete(ctx.run.id);
    },
    compact: (_, ctx) => {
      const evs = events(ctx);
      if (evs.length > 0)
        state(ctx).snapshots.set(sessionId(ctx), buildResumeSnapshot(evs, (resumeOf(ctx)?.compactCount ?? 0) + 1));
    },
    compacted: async (_, ctx) => {
      const { snapshots } = state(ctx);
      const snapshot = snapshots.get(sessionId(ctx));
      snapshots.delete(sessionId(ctx));
      const resume: Resume = { snapshot, compactCount: (resumeOf(ctx)?.compactCount ?? 0) + 1, consumed: !snapshot };
      await ctx.session?.appendEntry(`${ctx.plugin}:resume`, resume);
    },
  },
  commands: [
    { name: "ctx-stats", description: "Show context-mode session statistics", run: (_, ctx) => statsText(ctx) },
    {
      name: "ctx-doctor",
      description: "Run context-mode diagnostics",
      run: (_, ctx) => {
        const path = ctx.session?.path ? join(kbDir(), `${ctx.session.id}.json`) : "(in memory)";
        const resume = resumeOf(ctx);
        return [
          "## ctx-doctor",
          "",
          `- Knowledge base: \`${path}\``,
          `- Knowledge base exists: ${existsSync(path)}`,
          `- Session ID: \`${ctx.session ? `${ctx.session.id.slice(0, 8)}...` : "none"}\``,
          `- Project dir: \`${ctx.cwd}\``,
          `- Events: ${events(ctx).length}`,
          `- Compactions: ${resume?.compactCount ?? 0}`,
          `- Resume snapshot: ${resume?.snapshot ? (resume.consumed ? "consumed" : "available") : "none"}`,
        ].join("\n");
      },
    },
  ],
} satisfies Plugin;
