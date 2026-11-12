import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { z } from "zod";
import { type Image, tool } from "./llm.ts";

// Mirrors pi's built-in read/edit/write/bash tools: same limits, schemas and messages.
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

const imageTypes: Record<string, Image["mediaType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Keeps whole lines from the start (or end) of `text` within MAX_LINES and MAX_BYTES. */
export function truncate(text: string, fromEnd = false) {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  const kept: string[] = [];
  let bytes = 0;
  for (let i = 0; i < lines.length && kept.length < MAX_LINES; i++) {
    const line = lines[fromEnd ? lines.length - 1 - i : i] as string;
    bytes += Buffer.byteLength(line) + (kept.length ? 1 : 0);
    if (bytes > MAX_BYTES) break;
    kept.push(line);
  }
  if (fromEnd) kept.reverse();
  const truncated = kept.length < lines.length;
  return { content: truncated ? kept.join("\n") : text, shown: kept.length, total: lines.length, truncated, lines };
}

/** Writes `image` to a temp file so it can be opened or reused later; returns the path. */
export function saveImage(image: Image): string {
  const path = join(tmpdir(), `hortus-image-${randomUUID()}.${image.mediaType.split("/")[1]}`);
  // sync, so codemode's image() can name the path in order; images are small enough
  writeFileSync(path, Buffer.from(image.data, "base64"));
  return path;
}

/** The tail of each path's queue of `withToolLock` callers. */
const toolLocks = new Map<string, Promise<unknown>>();
/** The `withToolLock`s (resolved path → hold) the current async context holds, so a nested one doesn't wait on itself. */
const toolHeld = new AsyncLocalStorage<Map<string, { released: boolean }>>();

/**
 * Runs `fn` once every earlier `withToolLock` call on the same file (by resolved path) in this process has finished, so
 * editing tools (`write`, `edit`, plugins' own) never interleave a read-modify-write of one file. In-process, with no
 * lockfile: nothing is left in the project after a crash. (For files under `~/.hortus` shared between processes, use
 * `withFileLock`.) Re-entrant: called from inside `fn` (its async context, e.g. a wrapper of `edit`, or `ctx.runTool`)
 * while the lock is still held, it runs at once.
 */
export async function withToolLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const outer = toolHeld.getStore();
  // ponytail: as in withFileLock, nested calls aren't serialized with each other, and an un-awaited nested call started
  // inside fn that keeps running after it returns is unprotected once the lock is released; queue them per path (and
  // have the holder wait for them) if a holder ever runs them concurrently
  if (outer?.get(key)?.released === false) return fn();
  const hold = { released: false };
  const run = (toolLocks.get(key) ?? Promise.resolve()).then(async () => {
    try {
      return await toolHeld.run(new Map(outer).set(key, hold), fn);
    } finally {
      // before the next caller starts: a callback from fn firing later must queue, not skip the lock
      hold.released = true;
    }
  });
  const tail = run.catch(() => {});
  toolLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (toolLocks.get(key) === tail) toolLocks.delete(key);
  }
}

const limitNote = (shown: number) => (shown < MAX_LINES ? ` (${MAX_BYTES / 1024}KB limit)` : "");

/** Trailing whitespace and typographic quotes/dashes/spaces are ignored; never changes the line count. */
const normalizeFuzzy = (text: string) =>
  text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[  -   　]/g, " ");

interface Match {
  i: number;
  oldText: string;
  fuzzy: boolean;
  index: number;
  length: number;
  from: number;
  to: number;
  newText: string;
}

const replace = (text: string, matches: Match[], offset = 0) =>
  matches.reduceRight((s, m) => s.slice(0, m.index - offset) + m.newText + s.slice(m.index - offset + m.length), text);

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length - 1;

/**
 * Applies `edits` (each matched against the original, LF-normalized `content`). An oldText not found verbatim falls
 * back to fuzzy matching; only the lines a fuzzy match touches take the normalized text.
 */
export function applyEdits(content: string, edits: { oldText: string; newText: string }[], path: string): string {
  const one = edits.length === 1;
  const base = edits.some((e) => !content.includes(e.oldText)) ? normalizeFuzzy(content) : undefined;
  const locate = (text: string, old: string, i: number) => {
    const index = text.indexOf(old);
    if (index === -1)
      throw new Error(
        one
          ? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
          : `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
      );
    const count = text.split(old).length - 1;
    if (count > 1)
      throw new Error(
        one
          ? `Found ${count} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
          : `Found ${count} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
      );
    return index;
  };
  const matches = edits.map(({ oldText, newText }, i): Match => {
    if (!oldText)
      throw new Error(
        one ? `oldText must not be empty in ${path}.` : `edits[${i}].oldText must not be empty in ${path}.`,
      );
    const fuzzy = !content.includes(oldText);
    const text = fuzzy ? (base as string) : content;
    const old = fuzzy ? normalizeFuzzy(oldText) : oldText;
    const index = locate(text, old, i);
    const from = lineOf(text, index);
    const to = lineOf(text, index + Math.max(old.length - 1, 0));
    return { i, oldText, fuzzy, index, length: old.length, from, to, newText };
  });
  // normalizeFuzzy keeps the line count, so line numbers are shared; group matches into disjoint line ranges
  matches.sort((a, b) => a.from - b.from || a.index - b.index);
  const groups: { from: number; to: number; matches: Match[] }[] = [];
  for (const m of matches) {
    const last = groups.at(-1);
    if (last && m.from <= last.to) {
      last.to = Math.max(last.to, m.to);
      last.matches.push(m);
    } else groups.push({ from: m.from, to: m.to, matches: [m] });
  }
  const origLines = content.split("\n");
  const baseLines = base?.split("\n") ?? origLines;
  const out: string[] = [];
  let line = 0;
  for (const g of groups) {
    // a group with a fuzzy match takes the normalized lines, so its exact matches are located there too
    const fuzzy = g.matches.some((m) => m.fuzzy);
    if (fuzzy)
      for (const m of g.matches.filter((m) => !m.fuzzy)) {
        const old = normalizeFuzzy(m.oldText);
        Object.assign(m, { index: locate(base as string, old, m.i), length: old.length });
      }
    g.matches.sort((a, b) => a.index - b.index);
    for (let k = 1; k < g.matches.length; k++) {
      const [a, b] = [g.matches[k - 1] as Match, g.matches[k] as Match];
      if (a.index + a.length > b.index)
        throw new Error(
          `edits[${a.i}] and edits[${b.i}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
        );
    }
    const lines = fuzzy ? baseLines : origLines;
    const offset = lines.slice(0, g.from).join("\n").length + (g.from ? 1 : 0);
    out.push(...origLines.slice(line, g.from), replace(lines.slice(g.from, g.to + 1).join("\n"), g.matches, offset));
    line = g.to + 1;
  }
  out.push(...origLines.slice(line));
  const result = out.join("\n");
  if (result === content)
    throw new Error(
      one
        ? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
        : `No changes made to ${path}. The replacements produced identical content.`,
    );
  return result;
}

export const readTool = tool({
  name: "read",
  effects: { reads: ["path"], readOnly: true },
  description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
  inputSchema: z.object({
    path: z.string().describe("Path to the file to read (relative or absolute)"),
    offset: z.number().int().min(1).optional().describe("Line number to start reading from (1-indexed)"),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
  }),
  execute: async ({ path, offset, limit }, ctx) => {
    const abs = resolve(ctx.cwd, path);
    const mediaType = imageTypes[extname(path).toLowerCase()];
    if (mediaType) return { type: "image", mediaType, data: await readFile(abs, "base64"), path: abs } satisfies Image;
    const lines = (await readFile(abs, "utf8")).split("\n");
    const start = offset ? offset - 1 : 0;
    if (start >= lines.length) throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
    const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
    const t = truncate(lines.slice(start, end).join("\n"));
    if (t.shown === 0) {
      const kb = (Buffer.byteLength(lines[start] as string) / 1024).toFixed(1);
      return `[Line ${start + 1} is ${kb}KB, exceeds ${MAX_BYTES / 1024}KB limit. Use bash: sed -n '${start + 1}p' ${path} | head -c ${MAX_BYTES}]`;
    }
    if (t.truncated) {
      const last = start + t.shown;
      return `${t.content}\n[Showing lines ${start + 1}-${last} of ${lines.length}${limitNote(t.shown)}. Use offset=${last + 1} to continue.]`;
    }
    if (end < lines.length)
      return `${t.content}\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]`;
    return t.content;
  },
});

export const editTool = tool({
  name: "edit",
  effects: { reads: ["path"], writes: ["path"] },
  description:
    "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
  inputSchema: z.object({
    path: z.string().describe("Path to the file to edit (relative or absolute)"),
    edits: z
      .array(
        z.object({
          oldText: z
            .string()
            .describe(
              "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
            ),
          newText: z.string().describe("Replacement text for this targeted edit."),
        }),
      )
      .min(1)
      .describe(
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
      ),
  }),
  execute: ({ path, edits }, ctx) => {
    const abs = resolve(ctx.cwd, path);
    return withToolLock(abs, async () => {
      const raw = await readFile(abs, "utf8");
      const bom = raw.charCodeAt(0) === 0xfeff ? raw.slice(0, 1) : "";
      const text = raw.slice(bom.length);
      // ponytail: line endings follow the first one in the file; track them per line if mixed-ending files matter
      const crlf = text.includes("\r\n") && text.indexOf("\r\n") <= text.indexOf("\n");
      const lf = (s: string) => s.replace(/\r\n?/g, "\n");
      const edited = applyEdits(
        lf(text),
        edits.map((e) => ({ oldText: lf(e.oldText), newText: lf(e.newText) })),
        path,
      );
      await writeFile(abs, bom + (crlf ? edited.replace(/\n/g, "\r\n") : edited));
      return `Successfully replaced ${edits.length} block(s) in ${path}.`;
    });
  },
});

export const writeTool = tool({
  name: "write",
  effects: { writes: ["path"] },
  description:
    "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
  inputSchema: z.object({
    path: z.string().describe("Path to the file to write (relative or absolute)"),
    content: z.string().describe("Content to write to the file"),
  }),
  execute: ({ path, content }, ctx) => {
    const abs = resolve(ctx.cwd, path);
    return withToolLock(abs, async () => {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
      return `Successfully wrote to ${path}`;
    });
  },
});

const LIVE_BYTES = 8 * 1024;
const LIVE_MS = 100;

/**
 * What builtin:bash passes to `ctx.update` while running; then, when it fails, `BashDetails` (the error result's
 * `details`), else `undefined` (a successful result keeps no details).
 */
export interface BashUpdate {
  /**
   * the last 8 KB of stdout and stderr combined so far, raw (ANSI codes, `\r` and the like included); once cut, it
   * starts after a line break, else (one line longer than that) at a character
   */
  output: string;
}

/** A failed builtin:bash call's `details`: how it ended, for callers (`ctx.runTool`) that want more than the text. */
export interface BashDetails {
  /** null when it was killed (timed out, aborted, or by a signal) */
  exitCode: number | null;
  signal?: string;
  timedOut?: true;
  aborted?: true;
}

export const bashTool = tool({
  name: "bash",
  effects: { exec: ["command"] },
  description: `Execute a bash command in the current working directory. Returns stdout and stderr combined. Output is truncated to the last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first); the full output is then saved to a temp file.`,
  inputSchema: z.object({
    command: z.string().describe("Shell command to execute"),
    // ponytail: pi has no default timeout (its tools are aborted with the run, as these are now); hortus keeps 120s
    timeout: z.number().positive().optional().describe("Timeout in seconds (default: 120)"),
  }),
  execute: async ({ command, timeout = 120 }, ctx) => {
    // an already-aborted signal never fires "abort"
    if (ctx.signal.aborted) throw new Error("Command aborted");
    // detached = own process group, so a timeout kills the whole tree
    const child = spawn("bash", ["-c", command], {
      detached: true,
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(ctx.env && { env: { ...process.env, ...ctx.env } }),
    });
    // ponytail: output buffered in memory; stream to the temp file instead if huge outputs become a problem
    const chunks: Buffer[] = [];
    // live output: the last LIVE_BYTES so far, at most every LIVE_MS
    let tail = Buffer.alloc(0);
    let cut = false;
    let live: NodeJS.Timeout | undefined;
    let streamed = false;
    const onData = (c: Buffer) => {
      chunks.push(c);
      cut ||= tail.length + c.length > LIVE_BYTES;
      tail = Buffer.concat([tail, c]).subarray(-LIVE_BYTES);
      live ??= setTimeout(() => {
        live = undefined;
        streamed = true;
        // a cut tail's first line may start mid-character or mid-escape: skip it, else the UTF-8 continuation bytes
        let from = cut ? tail.indexOf(10) + 1 : 0;
        if (cut && !from) while (((tail[from] ?? 0) & 0xc0) === 0x80) from++;
        ctx.update({ output: tail.subarray(from).toString() } satisfies BashUpdate);
      }, LIVE_MS);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const kill = () => {
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {}
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout * 1000);
    ctx.signal.addEventListener("abort", kill, { once: true });
    const [code, signal] = await new Promise<[number | null, string | null]>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve([code, signal]));
    }).finally(() => {
      clearTimeout(timer);
      clearTimeout(live);
      ctx.signal.removeEventListener("abort", kill);
    });
    const aborted = ctx.signal.aborted && !timedOut;
    // the result has the output: no details are saved, unless it failed (how it ended)
    if (timedOut || aborted || code !== 0) {
      const details: BashDetails = { exitCode: code };
      if (signal) details.signal = signal;
      if (timedOut) details.timedOut = true;
      if (aborted) details.aborted = true;
      ctx.update(details);
    } else if (streamed) ctx.update(undefined);

    const output = Buffer.concat(chunks).toString();
    const t = truncate(output, true);
    let text = t.content;
    if (t.truncated) {
      const file = join(tmpdir(), `hortus-bash-${randomUUID()}.log`);
      await writeFile(file, output);
      if (t.shown === 0) {
        text = Buffer.from(t.lines.at(-1) as string)
          .subarray(-MAX_BYTES)
          .toString();
        text += `\n[Showing last ${MAX_BYTES / 1024}KB of line ${t.total}. Full output: ${file}]`;
      } else {
        text += `\n[Showing lines ${t.total - t.shown + 1}-${t.total} of ${t.total}${limitNote(t.shown)}. Full output: ${file}]`;
      }
    }
    const status = (s: string) => new Error(text ? `${text}\n${s}` : s);
    if (timedOut) throw status(`Command timed out after ${timeout} seconds`);
    if (aborted) throw status("Command aborted");
    if (code === null) throw status(`Command terminated by ${signal}`);
    if (code !== 0) throw status(`Command exited with code ${code}`);
    return text || "(no output)";
  },
});
