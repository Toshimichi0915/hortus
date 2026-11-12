import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type CliPlugin,
  createStore,
  type EntryRenderer,
  type StoreApi,
  theme,
  usePluginCtx,
  useStore,
  useTheme,
  useUi,
} from "@hortus/cli";
import {
  type Ctx,
  findSkills,
  hortusDir,
  type Message,
  type PluginEntry,
  projectRoot,
  type SessionState,
  tool,
  withToolLock,
  stateOf as pluginState,
} from "@hortus/core";
import { Box, Text } from "ink";
import type { ComponentType } from "react";
import { z } from "zod";
import { LspClient } from "./lsp.ts";

/**
 * Pi's pi-lens: language-aware feedback while the agent writes. After each `write`/`edit` it formats (deferred to the
 * end of the run by default), runs the configured linters and the file's language server, and appends new errors to
 * the tool result (delta mode: only those the edit introduced); warnings reach the model at its next request.
 * A read guard blocks edits to files the branch never read, a git guard (opt-in) blocks commit/push while errors stay
 * unresolved. Situational tools (LSP navigation, ast-grep, diagnostic marks) start inactive and are activated per
 * session by `pi_lens_activate_tools`. The LSP state is a status, the findings a panel above the input, and an opt-in
 * turn summary a plugin message. Pi's flags are `~/.hortus/lens.json` keys (pi-lens's own config keys).
 */

// ── Config (`~/.hortus/lens.json`) ────────────────────────────────────────────────────────────────────────────────

const Runner = z.object({
  command: z.string(),
  /** `{file}` is replaced by the absolute path */
  args: z.array(z.string()).default(["{file}"]),
  extensions: z.array(z.string()),
  /** runs only when one of these exists in the project root (none: always, when installed) */
  markers: z.array(z.string()).optional(),
  /** for output lines that name none */
  severity: z.enum(["error", "warning", "info"]).default("warning"),
});
type Runner = z.infer<typeof Runner>;
const Server = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  extensions: z.array(z.string()),
});
type Server = z.infer<typeof Server>;
const on = (enabled: boolean) => z.object({ enabled: z.boolean().default(enabled) }).prefault({});

const ConfigSchema = z.object({
  lens: on(true),
  lsp: z
    .object({
      enabled: z.boolean().default(true),
      waitMs: z.number().default(3000),
      servers: z.record(z.string(), Server).default({}),
    })
    .prefault({}),
  format: z
    .object({ enabled: z.boolean().default(true), mode: z.enum(["deferred", "immediate"]).default("deferred") })
    .prefault({}),
  formatters: z.record(z.string(), Runner).default({}),
  runners: z.record(z.string(), Runner).default({}),
  readGuard: on(true),
  contextInjection: on(true),
  turnSummary: on(false),
  guard: on(false),
  delta: on(true),
  tools: z.object({ lazy: z.boolean().default(true), disabled: z.array(z.string()).default([]) }).prefault({}),
  ui: z
    .object({
      hideLspStatus: z.boolean().default(false),
      compactLspStatus: z.boolean().default(false),
      compactWidget: z.boolean().default(false),
    })
    .prefault({}),
  widget: z.object({ visible: z.boolean().default(true) }).prefault({}),
  astGrep: z.object({ command: z.string().default("ast-grep") }).prefault({}),
});
export type LensConfig = z.infer<typeof ConfigSchema>;

const JS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const DEFAULT_SERVERS: Record<string, Server> = {
  typescript: { command: "typescript-language-server", args: ["--stdio"], extensions: JS },
  pyright: { command: "pyright-langserver", args: ["--stdio"], extensions: [".py"] },
  gopls: { command: "gopls", args: [], extensions: [".go"] },
  "rust-analyzer": { command: "rust-analyzer", args: [], extensions: [".rs"] },
};
const DEFAULT_RUNNERS: Record<string, Runner> = {
  ruff: {
    command: "ruff",
    args: ["check", "--output-format=concise", "{file}"],
    extensions: [".py"],
    severity: "error",
  },
  eslint: {
    command: "eslint",
    args: ["--format", "unix", "{file}"],
    extensions: JS,
    markers: ["eslint.config.js", "eslint.config.mjs", ".eslintrc.json", ".eslintrc.js"],
    severity: "warning",
  },
  shellcheck: { command: "shellcheck", args: ["-f", "gcc", "{file}"], extensions: [".sh"], severity: "warning" },
};
const DEFAULT_FORMATTERS: Record<string, Runner> = {
  prettier: {
    command: "prettier",
    args: ["--write", "{file}"],
    extensions: [...JS, ".json", ".css", ".md"],
    markers: [".prettierrc", ".prettierrc.json", "prettier.config.js"],
    severity: "info",
  },
  biome: {
    command: "biome",
    args: ["format", "--write", "{file}"],
    extensions: JS,
    markers: ["biome.json"],
    severity: "info",
  },
  "ruff-format": {
    command: "ruff",
    args: ["format", "{file}"],
    extensions: [".py"],
    markers: ["ruff.toml", "pyproject.toml"],
    severity: "info",
  },
  gofmt: { command: "gofmt", args: ["-w", "{file}"], extensions: [".go"], severity: "info" },
};

export async function loadLensConfig(): Promise<LensConfig> {
  const raw = await readFile(join(hortusDir(), "lens.json"), "utf8").then(JSON.parse, () => ({}));
  const c = ConfigSchema.parse(raw);
  return {
    ...c,
    lsp: { ...c.lsp, servers: { ...DEFAULT_SERVERS, ...c.lsp.servers } },
    runners: { ...DEFAULT_RUNNERS, ...c.runners },
    formatters: { ...DEFAULT_FORMATTERS, ...c.formatters },
  };
}

// ── State ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Finding {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
}
export interface Mark {
  file: string;
  /** a substring of the finding's message */
  match: string;
  disposition: "false-positive" | "defer" | "flagged";
  note?: string;
}
/** What the session branch's `lens:*` entries rebuild: marks and activated situational tools. */
export interface Saved {
  marks: Mark[];
  active: string[];
}
interface SummaryEvent {
  file: string;
  kind: "diagnostic" | "format";
  tool: string;
}
export interface TurnSummary {
  files: { file: string; events: SummaryEvent[] }[];
  counts: { diagnostics: number; formats: number };
}
/** Per session: what the pipelines found, and what the next request should hear. */
interface SessionLens {
  findings: Map<string, Finding[]>;
  /** mutated this run (deferred format, turn summary) */
  touched: Set<string>;
  /** mutated this turn (turn-end findings) */
  turnFiles: Set<string>;
  /** injected into the next request, once */
  pending: string[];
  /** one-shot read-guard exemptions (`/lens-allow-edit`) */
  allow: Set<string>;
  summary: SummaryEvent[];
}
interface State {
  config: LensConfig;
  enabled: boolean;
  context: boolean;
  widget: boolean;
  /** by `<server id>\0<root>` */
  lsp: Map<string, LspClient>;
  failed: Set<string>;
  sessions: Map<string, SessionLens>;
  /** the situational tools held back from a run (by run id), for `pi_lens_activate_tools` to add */
  held: Map<string, string[]>;
  health: { checks: number; last?: { file: string; ms: number; findings: number; ran: string[] } };
  /** bumped when anything the TUI draws changes */
  ui: StoreApi<{ v: number }>;
}

const EMPTY: Saved = { marks: [], active: [] };
export const saved = (s: SessionState, plugin = "lens") => (s.data[plugin] as Saved | undefined) ?? EMPTY;

function stateOf(ctx: Ctx): State {
  return pluginState(
    ctx,
    "st",
    (): State => ({
      config: ConfigSchema.parse({}),
      enabled: true,
      context: true,
      widget: true,
      lsp: new Map(),
      failed: new Set(),
      sessions: new Map(),
      held: new Map(),
      health: { checks: 0 },
      ui: createStore(() => ({ v: 0 })),
    }),
  );
}
const bump = (st: State) => st.ui.setState((s) => ({ v: s.v + 1 }));
function sesOf(st: State, id = "none"): SessionLens {
  let s = st.sessions.get(id);
  if (!s) {
    s = { findings: new Map(), touched: new Set(), turnFiles: new Set(), pending: [], allow: new Set(), summary: [] };
    st.sessions.set(id, s);
  }
  return s;
}
const ses = (ctx: Ctx) => sesOf(stateOf(ctx), ctx.session?.id);

// ── Running external tools ────────────────────────────────────────────────────────────────────────────────────────

function installed(command: string): boolean {
  if (isAbsolute(command) || command.includes("/")) return existsSync(command);
  return (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, command)));
}
const rootOf = async (cwd: string) => {
  const git = await projectRoot(cwd);
  return git ? dirname(git) : cwd;
};
const applies = (r: Runner, file: string, root: string) =>
  r.extensions.includes(extname(file)) &&
  (!r.markers || r.markers.some((m) => existsSync(join(root, m)))) &&
  installed(r.command);

function exec(cmd: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((done) =>
    execFile(cmd, args, { cwd, signal, maxBuffer: 16 << 20 }, (_e, stdout, stderr) => done(`${stdout}${stderr}`)),
  );
}

/** gcc-style lines (`file:line:col: [error|warning:] message`), as ruff/eslint/shellcheck/tsc print them. */
export function parseLines(out: string, file: string, source: string, fallback: Finding["severity"]): Finding[] {
  const found: Finding[] = [];
  for (const l of out.split("\n")) {
    const m = /^(.*?):(\d+):(\d+):?\s*(.*)$/.exec(l.trim());
    if (!m || resolve(m[1] as string) !== file) continue;
    const sev = /^(error|warning|info|note)\b:?\s*/i.exec(m[4] as string);
    const severity = (sev?.[1]?.toLowerCase().replace("note", "info") ?? fallback) as Finding["severity"];
    const message = sev ? (m[4] as string).slice(sev[0].length) : (m[4] as string);
    found.push({ file, line: Number(m[2]), col: Number(m[3]), severity, message, source });
  }
  return found;
}

const LANGS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".rs": "rust",
};
const languageId = (file: string) => LANGS[extname(file)] ?? extname(file).slice(1);

/** The running (or newly started) language server for `file`, or none (disabled, not installed, or it failed). */
async function lspFor(ctx: Ctx, file: string): Promise<LspClient | undefined> {
  const st = stateOf(ctx);
  if (!st.config.lsp.enabled) return;
  const entry = Object.entries(st.config.lsp.servers).find(([, s]) => s.extensions.includes(extname(file)));
  if (!entry || !installed(entry[1].command)) return;
  const [id, server] = entry;
  const root = await rootOf(ctx.cwd);
  const key = `${id}\0${root}`;
  let c = st.lsp.get(key);
  if (!c?.alive) {
    if (st.failed.has(id)) return;
    c = new LspClient(id, server.command, server.args, root);
    st.lsp.set(key, c);
    const started = await c.ready.then(
      () => true,
      () => false,
    );
    if (!started) {
      st.failed.add(id);
      st.lsp.delete(key);
      updateStatus(ctx);
      return;
    }
    updateStatus(ctx);
  }
  return c;
}

const SEVERITY = ["error", "error", "warning", "info", "info"] as const;

/** Runs every applicable linter and the file's language server over `file` as it is on disk. */
async function check(ctx: Ctx, file: string): Promise<Finding[]> {
  const st = stateOf(ctx);
  const started = Date.now();
  const root = await rootOf(ctx.cwd);
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return [];
  const ran: string[] = [];
  const runs = Object.entries(st.config.runners)
    .filter(([, r]) => applies(r, file, root))
    .map(async ([name, r]) => {
      ran.push(name);
      const out = await exec(
        r.command,
        r.args.map((a) => a.replaceAll("{file}", file)),
        root,
        ctx.signal,
      );
      return parseLines(out, file, name, r.severity);
    });
  const lsp = (async () => {
    const c = await lspFor(ctx, file);
    if (!c) return [];
    ran.push(c.id);
    const diags = await c.check(file, text, languageId(file), st.config.lsp.waitMs).catch(() => []);
    return diags.map(
      (d): Finding => ({
        file,
        line: d.range.start.line + 1,
        col: d.range.start.character + 1,
        severity: SEVERITY[d.severity ?? 1] ?? "error",
        message: d.code === undefined ? d.message : `${d.message} (${d.code})`,
        source: d.source ?? c.id,
      }),
    );
  })();
  const findings = (await Promise.all([...runs, lsp])).flat();
  st.health.checks++;
  st.health.last = { file, ms: Date.now() - started, findings: findings.length, ran };
  return findings;
}

/** Runs the file's formatter; resolves with its name when the file changed. */
async function format(ctx: Ctx, file: string): Promise<string | undefined> {
  const st = stateOf(ctx);
  const root = await rootOf(ctx.cwd);
  const found = Object.entries(st.config.formatters).find(([, f]) => applies(f, file, root));
  if (!found) return;
  const [name, f] = found;
  return withToolLock(file, async () => {
    const before = await readFile(file, "utf8").catch(() => undefined);
    await exec(
      f.command,
      f.args.map((a) => a.replaceAll("{file}", file)),
      root,
    );
    return before !== undefined && (await readFile(file, "utf8")) !== before ? name : undefined;
  });
}

// ── Findings ──────────────────────────────────────────────────────────────────────────────────────────────────────

const savedOf = (ctx: Ctx) => (ctx.session ? saved(ctx.session.getState(), ctx.plugin) : EMPTY);
const hidden = (f: Finding, marks: Mark[]) =>
  marks.some((m) => m.file === f.file && m.disposition !== "flagged" && f.message.includes(m.match));
const visible = (ctx: Ctx, findings: Finding[]) => findings.filter((f) => !hidden(f, savedOf(ctx).marks));
const sameFinding = (a: Finding, b: Finding) => a.message === b.message && a.source === b.source;
const show = (ctx: Ctx, f: Finding) =>
  `  ${relative(ctx.cwd, f.file) || f.file}:${f.line}:${f.col} ${f.severity}: ${f.message} [${f.source}]`;
const unresolved = (ctx: Ctx) =>
  [...ses(ctx).findings.values()].flatMap((fs) => visible(ctx, fs)).filter((f) => f.severity === "error");

/** Pi-lens's LSP status: active servers green, failed ones red (a status of its own), else a dim "inactive". */
function updateStatus(ctx: Ctx) {
  const st = stateOf(ctx);
  if (st.config.ui.hideLspStatus) {
    void ctx.status("lens-lsp");
    return void ctx.status("lens-lsp-failed");
  }
  const active = [...new Set([...st.lsp.values()].filter((c) => c.alive).map((c) => c.id))];
  const compact = st.config.ui.compactLspStatus;
  const failed = st.failed.size ? (compact ? "LSP ✗" : `LSP Failed: ${[...st.failed].join(", ")}`) : undefined;
  void ctx.status(
    "lens-lsp",
    active.length
      ? { text: compact ? "LSP ✓" : `LSP Active: ${active.join(", ")}`, color: "green" }
      : failed
        ? undefined
        : { text: compact ? "LSP ✗" : "LSP Inactive", color: "dim" },
  );
  void ctx.status("lens-lsp-failed", failed && { text: failed, color: "red" });
}

const mutationPath = (call: { name: string; input: unknown }) =>
  (call.name === "write" || call.name === "edit") && typeof (call.input as { path?: unknown })?.path === "string"
    ? ((call.input as { path: string }).path as string)
    : undefined;

/** Whether the branch has a successful `read` (or an own write/edit) of `file`. */
function readOnBranch(messages: readonly Message[], cwd: string, file: string, self: string): boolean {
  const failed = new Set(
    messages.flatMap((m) => (m.role === "tool" ? m.results.filter((r) => r.isError).map((r) => r.id) : [])),
  );
  return messages.some(
    (m) =>
      m.role === "assistant" &&
      m.toolCalls.some((c) => {
        const p = (c.input as { path?: unknown })?.path;
        return (
          ["read", "write", "edit", "read_symbol"].includes(c.name) &&
          typeof p === "string" &&
          resolve(cwd, p) === file &&
          c.id !== self &&
          !failed.has(c.id)
        );
      }),
  );
}

// ── Tools ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const pos = (path: string, line?: number, character?: number) => ({
  textDocument: { uri: pathToFileURL(path).href },
  position: { line: (line ?? 1) - 1, character: (character ?? 1) - 1 },
});
interface Location {
  uri?: string;
  targetUri?: string;
  range?: { start: { line: number; character: number } };
  targetSelectionRange?: { start: { line: number; character: number } };
}
const showLocation = (cwd: string, l: Location) => {
  const r = l.range ?? l.targetSelectionRange;
  const p = fileURLToPath(l.uri ?? l.targetUri ?? "file:///");
  return `${relative(cwd, p) || p}:${(r?.start.line ?? 0) + 1}:${(r?.start.character ?? 0) + 1}`;
};
const hoverText = (h: { contents?: unknown } | null) => {
  const c = h?.contents;
  const one = (x: unknown) => (typeof x === "string" ? x : ((x as { value?: string })?.value ?? ""));
  return Array.isArray(c) ? c.map(one).join("\n") : one(c);
};
interface TextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}
/** Applies a WorkspaceEdit's text edits to disk; returns the files changed. */
async function applyWorkspaceEdit(edit: {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: { textDocument: { uri: string }; edits: TextEdit[] }[];
}): Promise<string[]> {
  const byUri = { ...edit.changes };
  for (const d of edit.documentChanges ?? [])
    byUri[d.textDocument.uri] = [...(byUri[d.textDocument.uri] ?? []), ...d.edits];
  const files: string[] = [];
  for (const [uri, edits] of Object.entries(byUri)) {
    const file = fileURLToPath(uri);
    await withToolLock(file, async () => {
      const lines = (await readFile(file, "utf8")).split("\n");
      const offset = (p: { line: number; character: number }) =>
        lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
      let text = lines.join("\n");
      for (const e of [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start)))
        text = text.slice(0, offset(e.range.start)) + e.newText + text.slice(offset(e.range.end));
      await writeFile(file, text);
    });
    files.push(file);
  }
  return files;
}

const OPS = {
  definition: "textDocument/definition",
  typeDefinition: "textDocument/typeDefinition",
  declaration: "textDocument/declaration",
  implementation: "textDocument/implementation",
  references: "textDocument/references",
  hover: "textDocument/hover",
  signatureHelp: "textDocument/signatureHelp",
  documentSymbol: "textDocument/documentSymbol",
  workspaceSymbol: "workspace/symbol",
  rename: "textDocument/rename",
  prepareCallHierarchy: "textDocument/prepareCallHierarchy",
  incomingCalls: "callHierarchy/incomingCalls",
  outgoingCalls: "callHierarchy/outgoingCalls",
} as const;

async function clientWithFile(ctx: Ctx, path: string) {
  const file = resolve(ctx.cwd, path);
  const c = await lspFor(ctx, file);
  if (!c) throw new Error(`No language server for ${path} (see /lens-tools)`);
  await c.sync(file, await readFile(file, "utf8"), languageId(file));
  return { c, file };
}

interface DocSymbol {
  name: string;
  range?: TextEdit["range"];
  location?: { range: TextEdit["range"] };
  children?: DocSymbol[];
}
const flatten = (s: DocSymbol[]): DocSymbol[] => s.flatMap((x) => [x, ...flatten(x.children ?? [])]);

const lspNavigation = tool({
  name: "lsp_navigation",
  description:
    "IDE-style LSP navigation: definition, typeDefinition, declaration, implementation, references, hover, signatureHelp, documentSymbol, workspaceSymbol (query), rename (newName; applied), prepareCallHierarchy, incomingCalls, outgoingCalls. Lines and characters are 1-based.",
  inputSchema: z.object({
    operation: z.enum(Object.keys(OPS) as [keyof typeof OPS, ...(keyof typeof OPS)[]]),
    path: z.string(),
    line: z.number().int().min(1).optional(),
    character: z.number().int().min(1).optional(),
    query: z.string().optional(),
    newName: z.string().optional(),
  }),
  execute: async ({ operation, path, line, character, query, newName }, ctx) => {
    const { c, file } = await clientWithFile(ctx, path);
    const at = pos(file, line, character);
    if (operation === "workspaceSymbol") {
      const r = (await c.request(OPS[operation], { query: query ?? "" })) as ({
        name: string;
        location: Location;
      } | null)[];
      return (r ?? []).map((s) => `${s?.name} ${showLocation(ctx.cwd, s?.location ?? {})}`).join("\n") || "No symbols";
    }
    if (operation === "documentSymbol") {
      const r = (await c.request(OPS[operation], { textDocument: at.textDocument })) as DocSymbol[] | null;
      return (
        flatten(r ?? [])
          .map((s) => `${s.name} :${((s.range ?? s.location?.range)?.start.line ?? 0) + 1}`)
          .join("\n") || "No symbols"
      );
    }
    if (operation === "incomingCalls" || operation === "outgoingCalls") {
      const [item] = ((await c.request(OPS.prepareCallHierarchy, at)) as unknown[] | null) ?? [];
      if (!item) return "No call hierarchy item here";
      const r = (await c.request(OPS[operation], { item })) as {
        from?: Location & { name: string };
        to?: Location & { name: string };
      }[];
      return (
        (r ?? [])
          .map((x) => {
            const it = x.from ?? x.to;
            return `${it?.name} ${showLocation(ctx.cwd, it ?? {})}`;
          })
          .join("\n") || "No calls"
      );
    }
    if (operation === "rename") {
      if (!newName) throw new Error("rename needs newName");
      const edit = await c.request(OPS.rename, { ...at, newName });
      if (!edit) return "Nothing to rename here";
      const files = await applyWorkspaceEdit(edit as Parameters<typeof applyWorkspaceEdit>[0]);
      return `Renamed in ${files.map((f) => relative(ctx.cwd, f)).join(", ")}`;
    }
    const r = await c.request(
      OPS[operation],
      operation === "references" ? { ...at, context: { includeDeclaration: true } } : at,
    );
    if (operation === "hover") return hoverText(r as { contents?: unknown }) || "No hover info";
    if (operation === "signatureHelp") return JSON.stringify(r);
    const locs = (Array.isArray(r) ? r : r ? [r] : []) as Location[];
    return locs.map((l) => showLocation(ctx.cwd, l)).join("\n") || "No results";
  },
});

const readSymbol = tool({
  name: "read_symbol",
  description: "Read one symbol's (function, class, method…) source by name, from the file's language server.",
  inputSchema: z.object({ path: z.string(), symbol: z.string() }),
  execute: async ({ path, symbol }, ctx) => {
    const { c, file } = await clientWithFile(ctx, path);
    const syms = flatten(
      ((await c.request(OPS.documentSymbol, { textDocument: pos(file).textDocument })) as DocSymbol[] | null) ?? [],
    );
    const s = syms.find((x) => x.name === symbol);
    const r = s?.range ?? s?.location?.range;
    if (!r) throw new Error(`No symbol ${symbol} in ${path}; symbols: ${syms.map((x) => x.name).join(", ")}`);
    const lines = (await readFile(file, "utf8")).split("\n").slice(r.start.line, r.end.line + 1);
    return lines.map((l, i) => `${r.start.line + i + 1}\t${l}`).join("\n");
  },
});

const symbolSearch = tool({
  name: "symbol_search",
  description: "Find symbols by name across the project (the language server of `path`'s language).",
  inputSchema: z.object({ query: z.string(), path: z.string().describe("any file of the language to search") }),
  execute: (input, ctx) => lspNavigation.execute({ operation: "workspaceSymbol", ...input } as never, ctx),
});

const lensDiagnostics = tool({
  name: "lens_diagnostics",
  description:
    "pi-lens diagnostics: with `paths`, check those files now (linters + language server); without, the session's current findings. Marked false-positive/deferred findings are left out.",
  inputSchema: z.object({
    paths: z.array(z.string()).optional(),
    severity: z.enum(["error", "warning", "all"]).default("all"),
  }),
  execute: async ({ paths, severity }, ctx) => {
    const s = ses(ctx);
    for (const p of paths ?? []) s.findings.set(resolve(ctx.cwd, p), await check(ctx, resolve(ctx.cwd, p)));
    bump(stateOf(ctx));
    const files = paths ? paths.map((p) => resolve(ctx.cwd, p)) : [...s.findings.keys()];
    const shown = files
      .flatMap((f) => visible(ctx, s.findings.get(f) ?? []))
      .filter((f) => severity === "all" || f.severity === severity);
    return shown.length ? shown.map((f) => show(ctx, f)).join("\n") : "No diagnostics";
  },
});

const diagnosticMark = tool({
  name: "lens_diagnostic_mark",
  description:
    "Record a disposition for a diagnostic: false-positive (hidden from now on), defer (hidden this session) or flagged (kept, to fix). `match` is a substring of its message.",
  inputSchema: z.object({
    path: z.string(),
    match: z.string(),
    disposition: z.enum(["false-positive", "defer", "flagged"]),
    note: z.string().optional(),
  }),
  execute: async ({ path, ...mark }, ctx) => {
    if (!ctx.session) throw new Error("No session to keep the mark in");
    await ctx.session.appendEntry(`${ctx.plugin}:mark`, { file: resolve(ctx.cwd, path), ...mark } satisfies Mark);
    bump(stateOf(ctx));
    return `Marked ${mark.disposition}: ${mark.match}`;
  },
});

interface SgMatch {
  file: string;
  text: string;
  replacement?: string;
  range: { start: { line: number; column: number } };
}
async function astGrep(ctx: Ctx, args: string[], paths?: string[]) {
  const st = stateOf(ctx);
  if (!installed(st.config.astGrep.command)) throw new Error(`${st.config.astGrep.command} is not installed`);
  const out = await exec(
    st.config.astGrep.command,
    ["run", ...args, "--json=compact", ...(paths ?? ["."])],
    ctx.cwd,
    ctx.signal,
  );
  try {
    return JSON.parse(out) as SgMatch[];
  } catch {
    throw new Error(out.trim() || "ast-grep failed");
  }
}
const sgLine = (m: SgMatch) =>
  `${m.file}:${m.range.start.line + 1}:${m.range.start.column + 1}: ${m.text.split("\n")[0]}`;

const astGrepSearch = tool({
  name: "ast_grep_search",
  description: "AST-aware structural code search (ast-grep patterns, e.g. `console.log($A)`).",
  inputSchema: z.object({ pattern: z.string(), lang: z.string().optional(), paths: z.array(z.string()).optional() }),
  execute: async ({ pattern, lang, paths }, ctx) => {
    const ms = await astGrep(ctx, ["--pattern", pattern, ...(lang ? ["--lang", lang] : [])], paths);
    return ms.map(sgLine).join("\n") || "No matches";
  },
});

const astGrepReplace = tool({
  name: "ast_grep_replace",
  description: "AST-aware structural rewrite (ast-grep pattern + rewrite). Dry run unless `apply: true`.",
  inputSchema: z.object({
    pattern: z.string(),
    rewrite: z.string(),
    lang: z.string().optional(),
    paths: z.array(z.string()).optional(),
    apply: z.boolean().default(false),
  }),
  execute: async ({ pattern, rewrite, lang, paths, apply }, ctx) => {
    const args = ["--pattern", pattern, "--rewrite", rewrite, ...(lang ? ["--lang", lang] : [])];
    const ms = await astGrep(ctx, args, paths);
    if (apply && ms.length) await astGrep(ctx, [...args, "--update-all"], paths);
    const lines = ms.map((m) => `${sgLine(m)}\n    → ${m.replacement ?? rewrite}`);
    return ms.length
      ? `${apply ? "Applied" : "Would apply"} ${ms.length} rewrite(s):\n${lines.join("\n")}`
      : "No matches";
  },
});

const effectiveConfig = tool({
  name: "effective_config",
  description:
    "The pi-lens configuration in effect (from ~/.hortus/lens.json and defaults), and which tools are enabled.",
  inputSchema: z.object({}),
  execute: async (_input, ctx) => {
    const st = stateOf(ctx);
    return JSON.stringify(
      { enabled: st.enabled, contextInjection: st.context, config: st.config, tools: ctx.tools.map((t) => t.name) },
      null,
      2,
    );
  },
});

/** Situational tools: inactive until `pi_lens_activate_tools` (unless `tools.lazy: false`). */
export const SITUATIONAL: Record<string, string> = {
  ast_grep_search: "AST-aware structural code search (ast-grep patterns).",
  ast_grep_replace: "AST-aware structural code rewrite/refactor (ast-grep patterns).",
  lsp_navigation: "IDE-style LSP navigation: definition, references, implementation, rename, call hierarchy.",
  lens_diagnostic_mark: "Record a disposition for a diagnostic: false-positive / defer / flagged.",
};

const activateTools = tool({
  name: "pi_lens_activate_tools",
  description: `Activate situational tools for the rest of this session (from the next request). Example: \`{"tools": ["lsp_navigation"]}\`.`,
  inputSchema: z.object({ tools: z.array(z.string()).min(1) }),
  execute: async ({ tools }, ctx) => {
    const st = stateOf(ctx);
    const ok = tools.filter((t) => t in SITUATIONAL && !st.config.tools.disabled.includes(t));
    if (!ok.length) throw new Error(`No valid tool names given. Available: ${Object.keys(SITUATIONAL).join(", ")}`);
    if (ctx.session) await ctx.session.appendEntry(`${ctx.plugin}:activate`, ok);
    // the tool constants themselves: core stamps a pushed tool with the pushing plugin, so they keep lens's ctx.state
    for (const name of st.held.get(ctx.run?.id ?? "") ?? [])
      if (ok.includes(name) && !ctx.tools.some((x) => x.name === name))
        ctx.tools.push(...allTools.filter((t) => t.name === name));
    return `Activated: ${ok.join(", ")}. Available starting next turn.`;
  },
});

// ── Turn summary ──────────────────────────────────────────────────────────────────────────────────────────────────

export function turnSummaryLine(d: TurnSummary) {
  const parts = [
    ...(d.counts.diagnostics ? [`${d.counts.diagnostics} diagnostic${d.counts.diagnostics === 1 ? "" : "s"}`] : []),
    ...(d.counts.formats ? [`${d.counts.formats} reformatted`] : []),
  ];
  return parts.length ? `pi-lens: ${parts.join(" · ")}` : "pi-lens: turn summary (empty)";
}
const summaryRows = (d: TurnSummary, expanded: boolean) => [
  turnSummaryLine(d),
  ...(expanded
    ? d.files.map(
        (f) =>
          `  ${f.file}: ${f.events.map((e) => `${e.kind === "format" ? "formatted" : "diagnostic"} (${e.tool})`).join(", ")}`,
      )
    : []),
];

const TurnSummaryEntry: EntryRenderer = {
  Render: ({ entry, width, Default }) => {
    const expanded = useUi((s) => s.expanded);
    useTheme();
    const d = entry.meta?.details as TurnSummary | undefined;
    if (!d) return <Default entry={entry} width={width} />;
    return (
      <Box flexDirection="column">
        {summaryRows(d, expanded).map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
          <Text key={i} color={i ? theme.dim : theme.accent} wrap="truncate">
            {r}
          </Text>
        ))}
      </Box>
    );
  },
  text: ({ entry }) => summaryRows(entry.meta?.details as TurnSummary, false).join("\n"),
};

/** The shown session's findings above the input: totals, then one row per file (`ui.compactWidget`: totals only). */
function Widget({ Default }: { Default: ComponentType }) {
  const ctx = usePluginCtx();
  const st = stateOf(ctx);
  useStore(st.ui);
  useTheme();
  const session = useUi((s) => s.session);
  const s = st.sessions.get(session.id);
  const marks = saved(session.getState(), ctx.plugin).marks;
  const files = [...(s?.findings ?? [])]
    .map(([file, fs]) => ({ file, fs: fs.filter((f) => !hidden(f, marks)) }))
    .filter((x) => x.fs.length);
  const count = (sev: string, fs = files.flatMap((x) => x.fs)) => fs.filter((f) => f.severity === sev).length;
  const cwd = session.getState().cwd ?? process.cwd();
  return (
    <Box flexDirection="column" flexShrink={0}>
      {st.widget && st.enabled && files.length ? (
        <Box flexDirection="column" paddingX={1}>
          <Text color={count("error") ? theme.red : theme.yellow}>
            {`lens · ${count("error")} error(s) · ${count("warning")} warning(s)`}
          </Text>
          {st.config.ui.compactWidget
            ? null
            : files.map(({ file, fs }) => (
                <Text key={file} color={theme.dim} wrap="truncate">
                  {`  ${relative(cwd, file) || file}  ${count("error", fs)}E ${count("warning", fs)}W`}
                </Text>
              ))}
        </Box>
      ) : null}
      <Default />
    </Box>
  );
}

// ── The plugin ────────────────────────────────────────────────────────────────────────────────────────────────────

const allTools = [
  lensDiagnostics,
  symbolSearch,
  readSymbol,
  effectiveConfig,
  activateTools,
  lspNavigation,
  astGrepSearch,
  astGrepReplace,
  diagnosticMark,
];
const ALL = new Set(allTools.map((t) => t.name));

export default {
  tools: allTools,
  entries: {
    mark: (e: PluginEntry<Mark>, state, plugin) => {
      const d = saved(state, plugin);
      state.data[plugin] = { ...d, marks: [...d.marks, e.data] };
    },
    activate: (e: PluginEntry<string[]>, state, plugin) => {
      const d = saved(state, plugin);
      state.data[plugin] = { ...d, active: [...new Set([...d.active, ...e.data])] };
    },
  },
  commands: [
    {
      name: "lens-toggle",
      description: "Toggle pi-lens on/off for this agent",
      run: (_a, ctx) => {
        const st = stateOf(ctx);
        st.enabled = !st.enabled;
        bump(st);
        return st.enabled ? "pi-lens enabled." : "pi-lens disabled. Run /lens-toggle again to resume.";
      },
    },
    {
      name: "lens-context-toggle",
      description: "Toggle automatic context injection (findings added to the next request)",
      run: (_a, ctx) => {
        const st = stateOf(ctx);
        st.context = !st.context;
        return st.context
          ? "pi-lens context injection enabled — findings will be added to the next turn."
          : "pi-lens context injection disabled — findings are still cached (lens_diagnostics) but not added to model context.";
      },
    },
    {
      name: "lens-widget-toggle",
      description: "Show or hide the pi-lens diagnostics panel above the input",
      run: (_a, ctx) => {
        const st = stateOf(ctx);
        st.widget = !st.widget;
        bump(st);
        return st.widget ? "pi-lens widget shown." : "pi-lens widget hidden.";
      },
    },
    {
      name: "lens-allow-edit",
      args: "<path>",
      description: "Allow one edit to a file without a prior read",
      run: (arg, ctx) => {
        if (!arg.trim()) return "Usage: /lens-allow-edit <path>";
        const file = resolve(ctx.cwd, arg.trim());
        ses(ctx).allow.add(file);
        return `Read guard override armed for next edit: ${file}`;
      },
    },
    {
      name: "lens-health",
      description: "Show pi-lens runtime health",
      run: (_a, ctx) => {
        const st = stateOf(ctx);
        const { last } = st.health;
        const lsp = [...st.lsp.values()];
        return [
          "PI-LENS HEALTH",
          `Enabled: ${st.enabled} · context injection: ${st.context}`,
          `Checks run: ${st.health.checks}`,
          last
            ? `Last dispatch: ${relative(ctx.cwd, last.file)} (${last.ms}ms, ${last.findings} diagnostics; ${last.ran.join(", ") || "no runners"})`
            : "No dispatch latency reports yet.",
          `Unresolved errors: ${unresolved(ctx).length}`,
          lsp.length
            ? `LSP servers:\n${lsp.map((c) => `  ${c.alive ? "✓" : "✗"} ${c.id} (${relative(ctx.cwd, c.root) || "."})`).join("\n")}`
            : "LSP servers: none started",
          ...(st.failed.size ? [`LSP failed: ${[...st.failed].join(", ")}`] : []),
        ].join("\n");
      },
    },
    {
      name: "lens-tools",
      description: "Show which linters, formatters and language servers pi-lens finds",
      run: (_a, ctx) => {
        const { config } = stateOf(ctx);
        const row = (kind: string, name: string, command: string) =>
          `  ${installed(command) ? "✓" : "✗"} ${name} (${kind}: ${command})`;
        return [
          "PI-LENS TOOLS STATUS",
          ...Object.entries(config.runners).map(([n, r]) => row("lint", n, r.command)),
          ...Object.entries(config.formatters).map(([n, r]) => row("format", n, r.command)),
          ...Object.entries(config.lsp.servers).map(([n, s]) => row("lsp", n, s.command)),
          row("search", "ast-grep", config.astGrep.command),
        ].join("\n");
      },
    },
  ],
  on: {
    init: async (_p, ctx) => {
      const st = stateOf(ctx);
      st.config = await loadLensConfig();
      st.enabled = st.config.lens.enabled;
      st.context = st.config.contextInjection.enabled;
      st.widget = st.config.widget.visible;
    },
    session_open: async (_p, ctx) => {
      sesOf(stateOf(ctx), ctx.session?.id);
      updateStatus(ctx);
    },
    session_closed: async ({ session }, ctx) => {
      stateOf(ctx).sessions.delete(session.id);
    },
    close: async (_p, ctx) => {
      const st = stateOf(ctx);
      await Promise.all([...st.lsp.values()].map((c) => c.stop()));
      st.lsp.clear();
    },
    skills: async ({ skills }) => {
      skills.push(...(await findSkills(fileURLToPath(new URL("../skills", import.meta.url)))));
    },
    run_start: async (p, ctx) => {
      const { config } = stateOf(ctx);
      const active = savedOf(ctx).active;
      const held: string[] = [];
      p.tools = p.tools.filter((t) => {
        if (!ALL.has(t.name) || t.plugin !== ctx.plugin) return true;
        if (config.tools.disabled.includes(t.name)) return false;
        if (config.tools.lazy && t.name in SITUATIONAL && !active.includes(t.name)) return !held.push(t.name);
        return true;
      });
      if (ctx.run) stateOf(ctx).held.set(ctx.run.id, held);
    },
    prompt: async (p, ctx) => {
      const held = stateOf(ctx).held.get(ctx.run?.id ?? "") ?? [];
      p.system.push(
        [
          "pi-lens checks every file you write or edit (linters, language server) and appends new errors to the tool result: fix them before moving on. Warnings arrive with your next request.",
          ...(held.length
            ? [
                "Situational tools (activate with pi_lens_activate_tools first):",
                ...held.map((name) => `- ${name}: ${SITUATIONAL[name]}`),
              ]
            : []),
        ].join("\n"),
      );
    },
    run_end: async (p, ctx) => {
      const st = stateOf(ctx);
      if (ctx.run) st.held.delete(ctx.run.id);
      if (p.source !== "run" || !st.enabled) return;
      const s = ses(ctx);
      if (st.config.format.enabled && st.config.format.mode === "deferred") {
        const formatted: string[] = [];
        for (const file of s.touched) {
          const by = await format(ctx, file).catch(() => undefined);
          if (!by) continue;
          formatted.push(relative(ctx.cwd, file));
          s.summary.push({ file, kind: "format", tool: by });
        }
        if (formatted.length)
          s.pending.push(
            `pi-lens formatted after your last turn: ${formatted.join(", ")}. Re-read before editing them.`,
          );
      }
      s.touched.clear();
      if (st.config.turnSummary.enabled && s.summary.length && ctx.session) {
        const files = [...new Set(s.summary.map((e) => e.file))].map((file) => ({
          file: relative(ctx.cwd, file) || file,
          events: s.summary.filter((e) => e.file === file),
        }));
        const details: TurnSummary = {
          files,
          counts: {
            diagnostics: s.summary.filter((e) => e.kind === "diagnostic").length,
            formats: s.summary.filter((e) => e.kind === "format").length,
          },
        };
        await ctx.send({
          content: turnSummaryLine(details),
          meta: { plugin: ctx.plugin, type: "turn-summary", details, display: true },
        });
      }
      s.summary = [];
      updateStatus(ctx);
    },
    tool_call: async ({ call }, ctx) => {
      const st = stateOf(ctx);
      if (!st.enabled) return;
      if (
        st.config.guard.enabled &&
        call.name === "bash" &&
        /\bgit\s+(commit|push)\b/.test(String((call.input as { command?: unknown })?.command))
      ) {
        const errs = unresolved(ctx);
        if (errs.length)
          throw new Error(
            `pi-lens guard: ${errs.length} unresolved error(s); fix or mark them (lens_diagnostic_mark) before committing:\n${errs.map((f) => show(ctx, f)).join("\n")}`,
          );
      }
      const path = mutationPath(call);
      if (!path) return;
      const file = resolve(ctx.cwd, path);
      if (!existsSync(file)) return;
      const s = ses(ctx);
      if (st.config.readGuard.enabled && ctx.session && !s.allow.delete(file)) {
        if (!readOnBranch(ctx.session.getState().messages, ctx.cwd, file, call.id))
          throw new Error(
            `pi-lens read guard: read ${path} before editing it (the user can allow one edit with /lens-allow-edit ${path}).`,
          );
      }
      // the delta baseline: what the file had before this edit
      if (st.config.delta.enabled && !s.findings.has(file)) s.findings.set(file, await check(ctx, file));
    },
    tool_result: async ({ call, result }, ctx) => {
      const st = stateOf(ctx);
      const path = mutationPath(call);
      if (!st.enabled || !path || result.isError) return;
      const file = resolve(ctx.cwd, path);
      const s = ses(ctx);
      s.touched.add(file);
      s.turnFiles.add(file);
      const notes: string[] = [];
      if (st.config.format.enabled && st.config.format.mode === "immediate") {
        const by = await format(ctx, file).catch(() => undefined);
        if (by) {
          notes.push(`pi-lens: formatted by ${by}; re-read before your next edit.`);
          s.summary.push({ file, kind: "format", tool: by });
        }
      }
      const before = s.findings.get(file);
      const findings = await check(ctx, file);
      s.findings.set(file, findings);
      for (const f of findings) s.summary.push({ file, kind: "diagnostic", tool: f.source });
      const errors = visible(ctx, findings).filter((f) => f.severity === "error");
      const fresh =
        st.config.delta.enabled && before ? errors.filter((e) => !before.some((b) => sameFinding(b, e))) : errors;
      if (fresh.length)
        notes.push(
          `🔴 pi-lens: ${fresh.length} error(s) in ${path} — fix before continuing:\n${fresh.map((f) => show(ctx, f)).join("\n")}` +
            (fresh.length < errors.length ? `\n(${errors.length - fresh.length} pre-existing not shown)` : ""),
        );
      if (notes.length) result.output = `${result.output}\n\n${notes.join("\n\n")}`;
      updateStatus(ctx);
      bump(st);
    },
    turn_end: async (_p, ctx) => {
      const st = stateOf(ctx);
      const s = ses(ctx);
      const warnings = [...s.turnFiles].flatMap((f) =>
        visible(ctx, s.findings.get(f) ?? []).filter((x) => x.severity === "warning"),
      );
      s.turnFiles.clear();
      if (st.enabled && warnings.length)
        s.pending.push(`pi-lens warnings in files you changed:\n${warnings.map((f) => show(ctx, f)).join("\n")}`);
    },
    request: async (p, ctx) => {
      const st = stateOf(ctx);
      if (p.source !== "run" || !ctx.session) return;
      const s = ses(ctx);
      if (!s.pending.length || !st.enabled || !st.context) return;
      const text = s.pending.join("\n\n");
      s.pending = [];
      const last = p.messages.at(-1);
      if (last?.role === "user" && !last.meta) last.content = `${last.content}\n\n${text}`;
      else p.messages.push({ role: "user", content: text });
    },
  },
  cli: { aboveInput: Widget, entries: { "lens:turn-summary": TurnSummaryEntry } },
} satisfies CliPlugin;
