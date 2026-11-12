import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { type CliPlugin, linesRenderer, type Span as Row, theme, type ToolView } from "@hortus/cli";
import {
  type Ctx,
  hortusDir,
  type PluginEntry,
  type Session,
  type SessionState,
  tool,
  type Tool,
  type ToolCtx,
  truncate,
  withToolLock,
} from "@hortus/core";
import { z } from "zod";
import {
  allocate,
  diffAnchors,
  diffRows,
  emptyRegistry,
  type FileAnchors,
  findEcho,
  numbered,
  ownerOf,
  parseRef,
  payloadLines,
  RangeStaleError,
  type Registry,
  resolveRange,
  row,
  SEP,
  splitLines,
  stripPrefixes,
  wasMinted,
} from "./hashline.ts";

const NAME = "hashline-edit";

/** `~/.hortus/hashline-edit.json`; every field optional. */
export interface Config {
  /** edits answer with the post-edit diff, and `write` with the file's anchored rows (default true) */
  autoRead: boolean;
  /** "full": the first run of a session gets every git-listed project file attached as anchored rows (default "off") */
  autoReadAll: "off" | "full";
  /** context rows around a diff's change (default 1) */
  diffContextLines: number;
}

async function loadConfig(): Promise<Config> {
  const defaults: Config = { autoRead: true, autoReadAll: "off", diffContextLines: 1 };
  try {
    return { ...defaults, ...JSON.parse(await readFile(join(hortusDir(), `${NAME}.json`), "utf8")) };
  } catch {
    return defaults;
  }
}

/** The session's anchors, as its `hashline-edit:*` entries left them. */
export const registry = (state: SessionState) => (state.data[NAME] as Registry | undefined) ?? emptyRegistry();

const sessionOf = (ctx: Ctx) => {
  if (!ctx.session) throw new Error("[E_REGISTRY] hashline tools need a session to keep their anchors in.");
  return ctx.session;
};

/**
 * Saves `file` as `path`'s anchors (unless they are what the session has). Call it with no `await` after the
 * `allocate` that made `file` (`appendEntry` applies the entry before it returns, so that read-modify-append is atomic):
 * `minted` must not move in between, or two files would mint the same anchors.
 */
function commit(session: Session, path: string, file: FileAnchors, minted: number) {
  const old = registry(session.getState()).files[path];
  if (old && JSON.stringify(old) === JSON.stringify(file)) return Promise.resolve();
  // ponytail: each entry holds the file's whole anchor and checksum lists; store spans instead if session files grow
  return session.appendEntry(`${NAME}:file`, { path, minted, ...file });
}

const serve = (file: FileAnchors, anchors: string[]) => {
  const live = new Set(file.anchors);
  file.served = [...new Set([...file.served, ...anchors.filter((a) => live.has(a))])];
};

const cwdOf = (ctx: Ctx) => ctx.cwd;
const display = (cwd: string, abs: string) => {
  const rel = relative(cwd, abs);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : abs;
};

/** A text file split into lines, LF-normalized, with what writing it back needs. */
async function load(path: string) {
  const raw = await readFile(path, "utf8");
  if (raw.includes("\0")) throw new Error(`[E_BINARY] ${path} is binary; read takes text files and images only.`);
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const text = raw.slice(bom.length);
  // ponytail: line endings follow the first one (as builtin:edit); track them per line if mixed-ending files matter
  const crlf = text.includes("\r\n") && text.indexOf("\r\n") <= text.indexOf("\n");
  const lf = text.replace(/\r\n/g, "\n");
  return { bom, crlf, eol: lf.endsWith("\n"), empty: lf === "", lines: splitLines(lf) };
}
type Loaded = Awaited<ReturnType<typeof load>>;
const serialize = (f: Loaded, lines: string[], eol: boolean) =>
  f.bom + `${lines.join("\n")}${eol ? "\n" : ""}`.replace(/\n/g, f.crlf ? "\r\n" : "\n");

const staleMessage = (reg: Registry, hash: string, next = "Call read() on the target file for fresh anchors.") =>
  `[E_STALE_ANCHOR] "${hash}" ${
    wasMinted(reg, hash)
      ? "is stale: it was valid earlier in this session, but its line was edited or its anchors were freed since."
      : "was never served in this session, so it addresses no line here."
  } ${next}`;

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

/** The `anchor│line` rows a read serves, with pi's pagination hints; `shown` are the anchors it served. */
function preview(file: FileAnchors, f: Loaded, offset = 1, limit?: number, unlimited = false) {
  const total = f.empty ? 0 : f.lines.length;
  if (total === 0)
    return offset === 1
      ? {
          text: `${row(file.anchors[0] ?? "", "")}\n[File is empty. Use replace to insert content.]`,
          shown: file.anchors,
        }
      : { text: `Offset ${offset} is beyond end of file (0 lines). Use replace to insert content.`, shown: [] };
  if (offset > total)
    return {
      text: `Offset ${offset} is beyond end of file (${total} lines total). Use offset=1 to read from the start, or offset=${total} to read the last line.`,
      shown: [],
    };
  const end = limit ? Math.min(offset - 1 + limit, total) : total;
  const rows = f.lines.slice(offset - 1, end).map((line, i) => row(file.anchors[offset - 1 + i] ?? "", line));
  if (unlimited) return { text: rows.join("\n"), shown: file.anchors.slice(offset - 1, end) };
  const t = truncate(rows.join("\n"));
  if (t.shown === 0) {
    // ponytail: pi still shows the other rows around an oversized one; here the read stops at it
    const kb = (Buffer.byteLength(rows[0] ?? "") / 1024).toFixed(1);
    return {
      text: `${row(file.anchors[offset - 1] ?? "", `[Line ${offset} is ${kb}KB, exceeds 50.0KB; content not shown. Use bash: sed -n '${offset}p' <path> | head -c ${MAX_BYTES}]`)}`,
      shown: [],
    };
  }
  const shown = file.anchors.slice(offset - 1, offset - 1 + t.shown);
  const last = offset + t.shown - 1;
  const hint = (size: string) =>
    `\n\n[Showing lines ${offset}-${last} of ${total}${size}. Use offset=${shown.at(-1) ?? last + 1} to continue.]`;
  if (t.truncated) return { text: t.content + hint(t.shown < MAX_LINES ? " (50.0KB limit)" : ""), shown };
  return { text: end < total ? t.content + hint("") : t.content, shown };
}

const imageTypes = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** What a read reports as `details`: the first line it served (for the line-number gutter of its block). */
export interface ReadDetails {
  offset: number;
}

const readGuidelines = [
  "Remember to use the hashline tools for every file read and edit: `read`, `replace`, `insert`.",
  "`read`: call again after an edit when you need anchors you lack — post-edit diff `+`/` ` rows and served `anchor│content` rows already carry fresh anchors for the changed range.",
];

const readWrap = (Default: Tool): Tool =>
  tool({
    ...Default,
    description:
      "Read a text file as `anchor│content` rows: a 5-character lowercase anchor (letters only), `│`, then the line. Target edits by anchor, never by content or line number. `offset` takes a 1-indexed line number or a served anchor; with an anchor, `limit` counts lines from that anchor row onward — no line-number math. Page long files with `offset` and `limit`; when output says truncated, continue from the hinted `offset`. A stale anchor is refused with the current rows and fresh anchors. Images attach visually; binary and directories are rejected; an empty file returns one empty row you can replace to seed content.",
    prompt: readGuidelines.map((g) => `- ${g}`).join("\n"),
    sequential: true,
    inputSchema: z.object({
      path: z.string().describe("Path to the file to read (relative or absolute)"),
      offset: z
        .union([z.number().int().min(1), z.string()])
        .optional()
        .describe("Line number (1-indexed) or a served anchor to start reading from"),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Maximum number of lines to read from offset; counted from the anchor row when `offset` is an anchor",
        ),
    }),
    execute: async (input, ctx) => {
      const abs = resolve(cwdOf(ctx), input.path);
      if (imageTypes.has(extname(abs).toLowerCase())) return Default.execute({ path: input.path } as never, ctx);
      const f = await load(abs);
      const session = sessionOf(ctx);
      // from here to `commit`, synchronous: see commit
      const reg = registry(session.getState());
      const { file, minted } = allocate(reg.minted, reg.files[abs], f.lines);
      let offset = input.offset;
      if (typeof offset === "string") {
        if (/^\s*\d+\s*$/.test(offset)) offset = Number(offset);
        else {
          const hash = parseRef(offset, "offset", []);
          const owner = ownerOf(reg, hash);
          if (owner === undefined)
            throw new Error(staleMessage(reg, hash, "Use a line number, or read again for fresh anchors."));
          if (owner !== abs)
            throw new Error(
              `[E_STALE_ANCHOR] "${hash}" is owned by ${owner}. Use a line number, or read ${owner} to use that anchor.`,
            );
          const at = file.anchors.indexOf(hash);
          if (at < 0) throw new Error(staleMessage(reg, hash, `Call read() on ${input.path} for fresh anchors.`));
          offset = at + 1;
        }
      }
      const p = preview(file, f, offset, input.limit);
      serve(file, p.shown);
      const saved = commit(session, abs, file, minted);
      ctx.update({ offset: offset ?? 1 } satisfies ReadDetails);
      await saved;
      return p.text;
    },
  });

/** What `replace`/`insert` report as `details`, for their blocks. */
export interface EditDetails {
  path: string;
  diff: string;
  /** each diff row's line number (none for ` ...`) */
  numbers: (number | null)[];
}

interface Planned {
  /** 0-based lines replaced, inclusive */
  from: number;
  to: number;
  lines: string[];
  /** the new line keeping `from`'s anchor (insert's anchor line) */
  carry?: number;
  /** the text ended with a newline: at the end of a file without one, the file gets one */
  lastEnds: boolean;
  /** lines in `lines` that only restate the anchor line (not counted as added or removed) */
  folded: number;
}

const block = (title: string, items: string[]) => (items.length ? `\n\n${title}:\n${items.join("\n")}` : "");

/**
 * One anchored edit: finds the file owning `refs` (checked against `given`), re-aligns its anchors with the file on
 * disk, lets `plan` resolve the change against them, writes it, and allocates anchors for the result (lines outside the
 * change keep theirs). Answers with the post-edit diff (`autoRead`) or a summary.
 */
async function edit(
  ctx: ToolCtx,
  given: string | undefined,
  refs: string[],
  warnings: string[],
  verb: "replaced" | "inserted",
  noun: string,
  plan: (f: Loaded, file: FileAnchors, path: string) => Planned,
): Promise<string> {
  const session = sessionOf(ctx);
  const cwd = cwdOf(ctx);
  const reg = registry(session.getState());
  const owners = refs.map((r) => ownerOf(reg, r));
  const missing = owners.indexOf(undefined);
  if (missing >= 0) throw new Error(staleMessage(reg, refs[missing] ?? ""));
  const abs = owners[0] as string;
  if (new Set(owners).size > 1)
    throw new Error(
      `[E_BAD_SHAPE] The anchors are owned by different files (${owners.join(", ")}); edit one file per call.`,
    );
  if (given !== undefined && resolve(cwd, given) !== abs)
    throw new Error(`[E_BAD_SHAPE] Provided "path" "${given}" does not match anchor ownership "${abs}".`);
  const path = display(cwd, abs);
  const config = await loadConfig();
  return withToolLock(abs, async () => {
    const f = await load(abs);
    // re-aligned with the file as it is now (it may have changed since it was read)
    const before = registry(session.getState());
    const cur = allocate(before.minted, before.files[abs], f.lines);
    let p: Planned;
    try {
      p = plan(f, cur.file, path);
    } catch (e) {
      // the error shows these rows with their anchors: they count as served
      if (e instanceof RangeStaleError) serve(cur.file, e.fresh);
      await commit(session, abs, cur.file, cur.minted);
      throw e;
    }
    await commit(session, abs, cur.file, cur.minted);
    const old = f.lines.slice(p.from, p.to + 1);
    if (old.length === p.lines.length && old.every((l, i) => l === p.lines[i])) {
      const loc = cur.file.anchors[p.from] ?? "";
      const text = `${noun} for ${loc} is identical to current content:\n  ${loc}: ${old.join("\\n").slice(0, 200)}`;
      return `No changes made to ${path}\nClassification: noop\n${text}${block(
        "Warnings",
        warnings.filter((w) => !w.startsWith("[H_")),
      )}`;
    }
    let lines = [...f.lines.slice(0, p.from), ...p.lines, ...f.lines.slice(p.to + 1)];
    let eol = f.eol || (p.to === f.lines.length - 1 && (p.lastEnds || p.lines.at(-1) === ""));
    if (!lines.length) [lines, eol] = [[""], false];
    await writeFile(abs, serialize(f, lines, eol));

    const span = { start: p.from, end: p.to, count: lines.length - (f.lines.length - old.length), carry: p.carry };
    const now = registry(session.getState());
    const prev = now.files[abs];
    const aligned = prev?.anchors.join() === cur.file.anchors.join();
    const next = allocate(now.minted, prev, lines, aligned ? span : undefined);
    const d = diffRows(
      { lines: f.lines, anchors: cur.file.anchors },
      { lines, anchors: next.file.anchors },
      span,
      config.diffContextLines,
    );
    serve(next.file, f.empty || lines.join() === "" ? next.file.anchors : diffAnchors(d.diff));
    const saved = commit(session, abs, next.file, next.minted);
    ctx.update({ path, diff: d.diff, numbers: d.numbers.map((n) => n ?? null) } satisfies EditDetails);
    await saved;

    const notices =
      block(
        "Warnings",
        warnings.filter((w) => !w.startsWith("[H_")),
      ) +
      block(
        "Hints",
        warnings.filter((w) => w.startsWith("[H_")),
      );
    if (config.autoRead) return d.diff + notices;
    if (lines.join() === "") return `File is empty. Use replace on ${next.file.anchors[0]}${SEP} to insert content.`;
    const [added, removed] = [p.lines.length - p.folded, old.length - p.folded];
    return `Successfully ${verb} in ${path}. Added ${added} line(s), removed ${removed} line(s).${notices}`;
  });
}

const TEXT_ENDING_NOTE =
  "A trailing line break sets the newline of the last line written instead of adding a blank line; a lone newline writes one blank line.";
const pathField = z
  .string()
  .optional()
  .describe("Path to the file the anchors were served for; optional, but must match anchor ownership when passed.");

const sharedGuidelines = [
  "`replace`/`insert`: same-file calls in one message apply in order, each against the file as the previous one left it; anchors of untouched lines stay valid, so if you already know all the edits and their anchors, send them together instead of one turn at a time.",
  "`replace`/`insert`: anchors resolve the file; `path` is optional but must match anchor ownership when passed.",
  "`replace`/`insert`: in the post-edit diff, `-anchor│` rows are dead anchors; `+anchor│` and ` anchor│` rows carry live anchors for the next edit. Rows the diff does not show keep their anchors, so a follow-up edit on them needs no re-read.",
  "`replace`/`insert`: `text` is written exactly as received; escapes are decoded once when the call is parsed, and the tool never decodes again — `\\uXXXX` is the character, `\\\\uXXXX` the literal text.",
];

const replaceTool = tool({
  name: "replace",
  effects: { reads: ["path"], writes: ["path"] },
  description:
    "Replace a range of lines (or a single line) in a text file by anchor. Deleting every line empties the file, and the result names the empty-line anchor, so a follow-up `replace` can seed content without a `read`.",
  prompt: [
    "`replace`: same-message calls must target disjoint ranges.",
    '`replace`: a pure deletion (`text: ""`) is the cheap way to clear a large range: it verifies only the first and last line against the served record and removes the interior as it currently stands.',
    "`replace`: for a single line, use the same anchor for `remove_from` and `remove_to`.",
    ...sharedGuidelines,
  ]
    .map((g) => `- ${g}`)
    .join("\n"),
  sequential: true,
  inputSchema: z.object({
    path: pathField,
    remove_from: z.string().describe("5-char anchor of the FIRST line to remove."),
    remove_to: z.string().describe("5-char anchor of the LAST line to remove."),
    text: z
      .string()
      .describe(`The exact text to write in place of the removed range. "" deletes the range. ${TEXT_ENDING_NOTE}`),
  }),
  execute: async (input, ctx) => {
    const warnings: string[] = [];
    const from = parseRef(input.remove_from, "remove_from", warnings);
    const to = parseRef(input.remove_to, "remove_to", warnings);
    return edit(ctx, input.path, [from, to], warnings, "replaced", "Replacement", (f, file, path) => {
      const lines = stripPrefixes(payloadLines(input.text), warnings);
      const [start, end] = resolveRange(file, f.lines, from, to, lines.length === 0, path, warnings);
      return { from: start, to: end, lines, lastEnds: input.text.endsWith("\n"), folded: 0 };
    });
  },
});

const insertTool = tool({
  name: "insert",
  effects: { reads: ["path"], writes: ["path"] },
  description:
    "Insert text next to an existing line without removing anything. The anchor line stays in place, and `anchor` is a bare 5-character anchor from any served `anchor│content` row.",
  prompt: [
    "`insert`: a missing or extra `+anchor│` blank row at either block edge in the diff is the classic insert slip.",
    ...sharedGuidelines,
  ]
    .map((g) => `- ${g}`)
    .join("\n"),
  sequential: true,
  inputSchema: z.object({
    path: pathField,
    anchor: z.string().describe("5-char anchor of the line to insert next to."),
    direction: z.enum(["after", "before"]).describe('"after" or "before"'),
    text: z
      .string()
      .describe(
        `The exact text to insert; an empty string inserts one blank line. ${TEXT_ENDING_NOTE} Never include the anchor line.`,
      ),
  }),
  execute: async (input, ctx) => {
    const warnings: string[] = [];
    const anchor = parseRef(input.anchor, "anchor", warnings);
    return edit(ctx, input.path, [anchor], warnings, "inserted", "Insertion", (f, file, path) => {
      const [at] = resolveRange(file, f.lines, anchor, anchor, false, path, warnings);
      const text = input.text || "\n";
      const added = stripPrefixes(payloadLines(text), warnings);
      const line = f.lines[at] ?? "";
      if (f.empty) return { from: at, to: at, lines: added, lastEnds: text.endsWith("\n"), folded: 0 };
      const after = input.direction === "after";
      return {
        from: at,
        to: at,
        lines: after ? [line, ...added] : [...added, line],
        carry: after ? 0 : added.length,
        lastEnds: after && text.endsWith("\n"),
        folded: 1,
      };
    });
  },
});

/** pi's auto-read-all budget: 1.5 bytes per token of the model's context window, from 200 KB to 2 MB. */
export const autoReadBudget = (contextWindow = 0) =>
  Math.min(2_000_000, Math.max(200_000, Math.floor(contextWindow * 1.5)));

/** Every git-listed project file as anchored rows (pi's auto-read-all "full" mode), within a byte budget. */
async function autoReadAll(session: Session, cwd: string, budget: number) {
  // ponytail: pi also ranks changed files and source dirs first, and caps each top-level dir's share; here it's git's
  // order
  const skipDirs =
    /(^|\/)(\.git|node_modules|dist|build|out|target|vendor|coverage|\.next|\.turbo|\.venv|venv|__pycache__|\.cache)\//;
  let listed: string[];
  try {
    const { stdout } = await promisify(execFile)(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    listed = stdout.split("\0").filter(Boolean);
  } catch {
    return undefined;
  }
  const files = listed.filter((p) => !skipDirs.test(p) && !imageTypes.has(extname(p).toLowerCase())).slice(0, 500);
  const sections: string[] = [];
  const omitted: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const abs = resolve(cwd, file);
    try {
      const size = (await stat(abs)).size;
      if (size > 200_000 || (sections.length && bytes + size > budget)) {
        omitted.push(file);
        continue;
      }
      const f = await load(abs);
      const reg = registry(session.getState());
      const { file: anchors, minted } = allocate(reg.minted, reg.files[abs], f.lines);
      const text = `=== ${file} ===\n${preview(anchors, f, 1, undefined, true).text}`;
      serve(anchors, anchors.anchors);
      await commit(session, abs, anchors, minted);
      sections.push(text);
      bytes += Buffer.byteLength(text) + 1;
    } catch {
      omitted.push(file);
    }
  }
  if (!sections.length) return undefined;
  const not = omitted.length
    ? ` Not attached: ${omitted.slice(0, 20).join(", ")}${omitted.length > 20 ? `, ... (+${omitted.length - 20} more)` : ""}. Use read for those.`
    : "";
  return [
    "[hashline auto-read-all] Every non-ignored project file is attached below as `=== path ===` then `anchor│content` rows with live anchors.\nEdit directly from the attachment with replace and insert; do not call read for attached files.\nFiles listed as not attached can be read normally.\nAnchors are lowercase and stay valid until their line is edited.",
    `[coverage: ${sections.length} complete]`,
    ...sections,
    `[hashline auto-read-all: ${sections.length} file(s) attached from git; all discovered files attached.${not}]`,
  ].join("\n\n");
}

const lined = (rows: string[], numbers: (number | null)[]) => {
  const width = String(Math.max(1, ...numbers.map((n) => n ?? 0))).length;
  return rows.map((r, i): Row[] => [
    { text: `${String(numbers[i] ?? "").padStart(width)} ${SEP} `, color: theme.dim },
    { text: r, color: r.startsWith("+") ? theme.green : r.startsWith("-") ? theme.red : theme.muted },
  ]);
};

/** `replace`/`insert` blocks: the call, then the post-edit diff with line numbers (or the error). */
const editBlock = linesRenderer(({ call, result, details }) => {
  const i = (call.input ?? {}) as Record<string, string | undefined>;
  const d = details as EditDetails | undefined;
  const where = call.name === "insert" ? `${i.direction} ${i.anchor}` : `${i.remove_from}..${i.remove_to}`;
  const head: Row[] = [
    { text: `${call.name} ${d?.path ?? i.path ?? ""} ${where}`.replace(/ +/g, " "), bold: true, color: theme.text },
  ];
  if (!result) return [head];
  if (!d || result.isError) {
    const lines = result.output.split("\n");
    const more = lines.length > 10 ? [`... (${lines.length - 10} more lines)`] : [];
    return [
      head,
      [],
      ...[...lines.slice(0, 10), ...more].map((text): Row[] => [
        { text, color: result.isError ? theme.red : theme.muted },
      ]),
    ];
  }
  return [head, [], ...lined(d.diff.split("\n"), d.numbers)];
});

/** The read block shows pi's expanded view: each `anchor│line` row after its line number. */
const readView = (view: ToolView): ToolView => {
  const offset = (view.details as ReadDetails | undefined)?.offset ?? 1;
  const input = (view.call.input ?? {}) as Record<string, unknown>;
  return {
    ...view,
    // an anchor `offset` shows as the line it was
    call: typeof input.offset === "string" ? { ...view.call, input: { ...input, offset } } : view.call,
    ...(view.result &&
      !view.result.isError && { result: { ...view.result, output: numbered(view.result.output, offset) } }),
  };
};

/**
 * pi-hashline-edit-pro: `read` serves every line as `anchor│content`, and `replace`/`insert` edit by those anchors
 * (stale or never-shown ones are refused with fresh rows), answering with the post-edit diff, whose anchors are live.
 * It wraps builtin:read (images go to it) and replaces builtin:edit (hortus.json). Anchors live in the session as
 * `hashline-edit:*` entries, so a resumed session's anchors still work.
 */
export default {
  tools: [{ name: "read", wrap: readWrap }, replaceTool, insertTool],
  entries: {
    file: ({ data }: PluginEntry<FileAnchors & { path: string; minted: number }>, state) => {
      const { path, minted, ...file } = data;
      const reg = registry(state);
      state.data[NAME] = {
        minted: Math.max(reg.minted, minted),
        files: { ...reg.files, [path]: file },
      } satisfies Registry;
    },
    free: ({ data: { path } }: PluginEntry<{ path: string }>, state) => {
      const { [path]: _, ...files } = registry(state).files;
      state.data[NAME] = { ...registry(state), files } satisfies Registry;
    },
    clear: (_, state) => {
      state.data[NAME] = { minted: registry(state).minted, files: {} } satisfies Registry;
    },
  },
  on: {
    // a write copying served `anchor│` rows into the file is refused
    tool_call: (p, ctx) => {
      const input = p.call.input as { path?: unknown; content?: unknown } | undefined;
      if (p.call.name !== "write" || p.result || !ctx.session) return;
      if (typeof input?.path !== "string" || typeof input.content !== "string") return;
      const served = registry(ctx.session.getState()).files[resolve(cwdOf(ctx), input.path)]?.served;
      const echo = served && findEcho(input.content, new Set(served));
      if (echo)
        p.result = {
          id: p.call.id,
          isError: true,
          output: `[E_WRITE_HASH_ECHO] Refused write to ${input.path}: line ${echo.line} contains the copied ${echo.hash}${SEP} anchor served for this file. Remove the copied anchors and retry.`,
        };
    },
    // a write frees the file's anchors; with autoRead, its result gets the new ones
    tool_result: async (p, ctx) => {
      const path = (p.call.input as { path?: unknown } | undefined)?.path;
      if (p.call.name !== "write" || p.result.isError || typeof path !== "string" || !ctx.session) return;
      const session = ctx.session;
      const abs = resolve(cwdOf(ctx), path);
      if (registry(session.getState()).files[abs]) await session.appendEntry(`${NAME}:free`, { path: abs });
      if (!(await loadConfig()).autoRead) return;
      let text: string;
      try {
        const f = await load(abs);
        const reg = registry(session.getState());
        const { file, minted } = allocate(reg.minted, reg.files[abs], f.lines);
        const shown = preview(file, f);
        serve(file, shown.shown);
        await commit(session, abs, file, minted);
        text = `--- Auto-read (hashline anchors) ---\n${shown.text}`;
      } catch (e) {
        text = `--- Auto-read failed: ${e instanceof Error ? e.message : String(e)} ---`;
      }
      p.result = { ...p.result, output: `${p.result.output}\n\n${text}` };
    },
    // auto-read-all: the session's first run gets the project attached before its first request
    run_start: async (p, ctx) => {
      if (p.source !== "run" || !ctx.session) return;
      if ((await loadConfig()).autoReadAll !== "full") return;
      if (p.messages.some((m) => m.role === "user" && m.meta?.plugin === NAME && m.meta.type === "auto-read-all"))
        return;
      const content = await autoReadAll(ctx.session, cwdOf(ctx), autoReadBudget(ctx.run?.info.contextWindow));
      if (content)
        await ctx.send(
          { content, meta: { plugin: NAME, type: "auto-read-all", display: false } },
          { deliver: "context" },
        );
    },
  },
  commands: [
    {
      name: "clear-anchors",
      description:
        "Clear the session's anchor claims (path-free resolution state); anchors are re-claimed on the next read",
      run: async (_, ctx) => {
        await ctx.session?.appendEntry(`${NAME}:clear`, null);
        return "Anchor claims cleared for this session";
      },
    },
  ],
  cli: {
    tools: {
      read: {
        Render: ({ Default, ...view }) => <Default {...readView(view)} />,
        text: (view, Default) => Default(readView(view)),
      },
      replace: editBlock,
      insert: editBlock,
    },
  },
} satisfies CliPlugin;
