import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
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
  index: number;
  length: number;
  newText: string;
}

const replace = (text: string, matches: Match[], offset = 0) =>
  matches.reduceRight((s, m) => s.slice(0, m.index - offset) + m.newText + s.slice(m.index - offset + m.length), text);

/**
 * Applies `edits` (each matched against the original, LF-normalized `content`). Falls back to fuzzy matching when an
 * oldText isn't found verbatim; then only the lines an edit touches take the normalized text.
 */
export function applyEdits(content: string, edits: { oldText: string; newText: string }[], path: string): string {
  const one = edits.length === 1;
  const fuzzy = edits.some((e) => !content.includes(e.oldText));
  const base = fuzzy ? normalizeFuzzy(content) : content;
  const matches = edits.map(({ oldText, newText }, i): Match => {
    if (!oldText)
      throw new Error(
        one ? `oldText must not be empty in ${path}.` : `edits[${i}].oldText must not be empty in ${path}.`,
      );
    const old = fuzzy ? normalizeFuzzy(oldText) : oldText;
    const index = base.indexOf(old);
    if (index === -1)
      throw new Error(
        one
          ? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
          : `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
      );
    const count = base.split(old).length - 1;
    if (count > 1)
      throw new Error(
        one
          ? `Found ${count} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
          : `Found ${count} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
      );
    return { i, index, length: old.length, newText };
  });
  matches.sort((a, b) => a.index - b.index);
  for (let k = 1; k < matches.length; k++) {
    const [a, b] = [matches[k - 1] as Match, matches[k] as Match];
    if (a.index + a.length > b.index)
      throw new Error(
        `edits[${a.i}] and edits[${b.i}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
  }
  const result = fuzzy ? replaceLines(content, base, matches) : replace(content, matches);
  if (result === content)
    throw new Error(
      one
        ? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
        : `No changes made to ${path}. The replacements produced identical content.`,
    );
  return result;
}

/** Applies matches found in `base` (fuzzy-normalized `original`), keeping `original`'s text on every untouched line. */
function replaceLines(original: string, base: string, matches: Match[]): string {
  const origLines = original.split("\n");
  const baseLines = base.split("\n");
  const starts: number[] = [];
  for (let i = 0, at = 0; i < baseLines.length; at += (baseLines[i] as string).length + 1, i++) starts.push(at);
  const lineOf = (index: number) => base.slice(0, index).split("\n").length - 1;
  // group matches into disjoint line ranges [from, to]
  const groups: { from: number; to: number; matches: Match[] }[] = [];
  for (const m of matches) {
    const from = lineOf(m.index);
    const to = lineOf(m.index + Math.max(m.length - 1, 0));
    const last = groups.at(-1);
    if (last && from <= last.to) {
      last.to = Math.max(last.to, to);
      last.matches.push(m);
    } else groups.push({ from, to, matches: [m] });
  }
  const out: string[] = [];
  let line = 0;
  for (const g of groups) {
    out.push(...origLines.slice(line, g.from));
    const offset = starts[g.from] as number;
    out.push(replace(baseLines.slice(g.from, g.to + 1).join("\n"), g.matches, offset));
    line = g.to + 1;
  }
  out.push(...origLines.slice(line));
  return out.join("\n");
}

export const readTool = tool({
  name: "read",
  description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
  inputSchema: z.object({
    path: z.string().describe("Path to the file to read (relative or absolute)"),
    offset: z.number().int().min(1).optional().describe("Line number to start reading from (1-indexed)"),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
  }),
  execute: async ({ path, offset, limit }) => {
    const mediaType = imageTypes[extname(path).toLowerCase()];
    if (mediaType) return { type: "image", mediaType, data: await readFile(path, "base64") } satisfies Image;
    const lines = (await readFile(path, "utf8")).split("\n");
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
  execute: async ({ path, edits }) => {
    const raw = await readFile(path, "utf8");
    const bom = raw.charCodeAt(0) === 0xfeff ? raw.slice(0, 1) : "";
    const text = raw.slice(bom.length);
    const crlf = text.includes("\r\n") && text.indexOf("\r\n") <= text.indexOf("\n");
    const lf = (s: string) => s.replace(/\r\n?/g, "\n");
    const edited = applyEdits(
      lf(text),
      edits.map((e) => ({ oldText: lf(e.oldText), newText: lf(e.newText) })),
      path,
    );
    await writeFile(path, bom + (crlf ? edited.replace(/\n/g, "\r\n") : edited));
    return `Successfully replaced ${edits.length} block(s) in ${path}.`;
  },
});

export const writeTool = tool({
  name: "write",
  description:
    "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
  inputSchema: z.object({
    path: z.string().describe("Path to the file to write (relative or absolute)"),
    content: z.string().describe("Content to write to the file"),
  }),
  execute: async ({ path, content }) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    return `Successfully wrote to ${path}`;
  },
});

export const bashTool = tool({
  name: "bash",
  description: `Execute a bash command in the current working directory. Returns stdout and stderr combined. Output is truncated to the last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first); the full output is then saved to a temp file.`,
  inputSchema: z.object({
    command: z.string().describe("Shell command to execute"),
    // ponytail: pi has no default timeout because its tools can be aborted; hortus's can't yet, so default to 120s
    timeout: z.number().positive().optional().describe("Timeout in seconds (default: 120)"),
  }),
  execute: async ({ command, timeout = 120 }) => {
    // detached = own process group, so a timeout kills the whole tree
    const child = spawn("bash", ["-c", command], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    // ponytail: output buffered in memory; stream to the temp file instead if huge outputs become a problem
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {}
    }, timeout * 1000);
    const [code, signal] = await new Promise<[number | null, string | null]>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve([code, signal]));
    }).finally(() => clearTimeout(timer));

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
    if (code === null) throw status(`Command terminated by ${signal}`);
    if (code !== 0) throw status(`Command exited with code ${code}`);
    return text || "(no output)";
  },
});
