/**
 * The hashline format (pi-hashline-edit-pro): every served line is `anchor│content`, the anchor a 5-letter lowercase
 * name minted for that line. Anchors are allocated, never derived from content: untouched lines keep theirs across
 * edits, changed lines get fresh ones, and a session never mints one twice.
 */
import { createHash } from "node:crypto";

export const SEP = "│";
const LEN = 5;
const N = 26 ** LEN;
// coprime with 26^5 (= 2^5 * 13^5), so `k * STRIDE mod N` walks every anchor once, scrambled
const STRIDE = 7_368_787;
const INVERSE = (() => {
  // STRIDE^-1 mod N, by the extended Euclidean algorithm
  let [r0, r1, s0, s1] = [BigInt(N), BigInt(STRIDE), 0n, 1n];
  while (r1) {
    const q = r0 / r1;
    [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1];
  }
  return Number(((s0 % BigInt(N)) + BigInt(N)) % BigInt(N));
})();

const anchorAt = (i: number) => {
  let s = "";
  for (let k = 0; k < LEN; k++, i = Math.floor(i / 26)) s = String.fromCharCode(97 + (i % 26)) + s;
  return s;
};
const indexOf = (a: string) => [...a].reduce((n, c) => n * 26 + c.charCodeAt(0) - 97, 0);
const mulMod = (a: number, b: number) => Number((BigInt(a) * BigInt(b)) % BigInt(N));

/** One file's anchors as last allocated, line by line, and the anchors served (shown) to the model. */
export interface FileAnchors {
  anchors: string[];
  /** each line's checksum when its anchor was allocated */
  sums: string[];
  served: string[];
}

/** A session's anchors (in `state.data["hashline-edit"]`): how many were minted, and each file's (by absolute path). */
export interface Registry {
  minted: number;
  files: Record<string, FileAnchors>;
}

export const emptyRegistry = (): Registry => ({ minted: 0, files: {} });

/** Whether `anchor` was minted in this session (so it is stale, not made up). */
export const wasMinted = (reg: Registry, anchor: string) => mulMod(indexOf(anchor), INVERSE) < reg.minted;

/** The file owning `anchor`, if any. */
export const ownerOf = (reg: Registry, anchor: string) =>
  Object.entries(reg.files).find(([, f]) => f.anchors.includes(anchor))?.[0];

// ponytail: pi hashes with xxh64 (xxhash-wasm); sha1 is in node and only compared with itself
/** A line's checksum: trailing whitespace and `\r` don't count, nor anything past 500 characters. */
export const lineSum = (line: string) =>
  createHash("sha1").update(line.replace(/\r/g, "").trimEnd().slice(0, 500)).digest("base64url").slice(0, 10);

/** `[start, end]` (old lines, inclusive) replaced by `count` lines; `carry`: the new index keeping `start`'s anchor. */
export interface Span {
  start: number;
  end: number;
  count: number;
  carry?: number;
}

/** Index pairs of a longest common subsequence of `a` and `b`. */
function lcs(a: string[], b: string[]): [number, number][] {
  const w = b.length + 1;
  const t = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      t[i * w + j] =
        a[i] === b[j] ? (t[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(t[(i + 1) * w + j] ?? 0, t[i * w + j + 1] ?? 0);
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if ((t[(i + 1) * w + j] ?? 0) >= (t[i * w + j + 1] ?? 0)) i++;
    else j++;
  }
  return pairs;
}

/**
 * Anchors for `lines`, minting from `minted` on: with `span` (an edit), lines outside it keep `prev`'s, and inside it a
 * carried line or an unchanged one at the same place keeps its own; otherwise lines matched to `prev` by a diff of
 * their checksums keep theirs. Served anchors that survive stay served.
 */
export function allocate(minted: number, prev: FileAnchors | undefined, lines: string[], span?: Span) {
  const sums = lines.map(lineSum);
  const mint = () => anchorAt(mulMod(minted++, STRIDE));
  const anchors: (string | undefined)[] = new Array(lines.length);
  if (prev && span) {
    const len = span.end - span.start + 1;
    const carried = span.carry !== undefined && prev.sums[span.start] === sums[span.start + span.carry];
    prev.anchors.slice(0, span.start).forEach((a, i) => {
      anchors[i] = a;
    });
    prev.anchors.slice(span.end + 1).forEach((a, i) => {
      anchors[span.start + span.count + i] = a;
    });
    for (let k = 0; k < span.count; k++) {
      const i = span.start + k;
      if (carried) anchors[i] = k === span.carry ? prev.anchors[span.start] : undefined;
      else if (k !== span.carry && k < len && prev.sums[i] === sums[i]) anchors[i] = prev.anchors[i];
    }
  } else if (prev) {
    // common prefix and suffix, then a diff of the middle (unless it is too big: then it is all new)
    let pre = 0;
    const min = Math.min(prev.sums.length, sums.length);
    while (pre < min && prev.sums[pre] === sums[pre]) pre++;
    let suf = 0;
    while (suf < min - pre && prev.sums.at(-1 - suf) === sums.at(-1 - suf)) suf++;
    const a = prev.sums.slice(pre, prev.sums.length - suf);
    const b = sums.slice(pre, sums.length - suf);
    const pairs = a.length * b.length > 4_000_000 ? [] : lcs(a, b);
    for (let i = 0; i < pre; i++) anchors[i] = prev.anchors[i];
    for (let i = 0; i < suf; i++) anchors[sums.length - 1 - i] = prev.anchors.at(-1 - i);
    for (const [i, j] of pairs) anchors[pre + j] = prev.anchors[pre + i];
  }
  const done = Array.from(anchors, (a) => a ?? mint());
  const live = new Set(done);
  return { file: { anchors: done, sums, served: prev?.served.filter((a) => live.has(a)) ?? [] }, minted };
}

/** Lines of `text` as the format counts them: a trailing newline ends the last line instead of starting one. */
export const splitLines = (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");

export const row = (anchor: string, line: string) => `${anchor}${SEP}${line}`;

const RUN = "[A-Za-z]{5,6}";
const ANCHOR_ROW = new RegExp(`^([+-]?)(${RUN})${SEP}`);
const NUMBERED_ROW = new RegExp(`^\\s*\\d+\\s*[:-]?\\s*${SEP}\\s*(${RUN})${SEP}`);
const PAREN_SUFFIX = new RegExp(`^(${RUN})\\s*\\(\\s*(?:line|lines)\\s+\\d+(?:\\s*[-–—]\\s*\\d+)?\\s*\\)$`, "i");
const BARE_PREFIX = new RegExp(`^\\s*(${RUN})${SEP}`);
const PLUS_PREFIX = new RegExp(`^\\+${RUN}${SEP}`);
const MINUS_PREFIX = new RegExp(`^-(?:${RUN}${SEP}| {${LEN}}${SEP})`);

const clip = (line: string, max = 200) => {
  const flat = line.replace(/\n/g, "\\n");
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};

/** The anchor in `ref` (a bare anchor, or a whole row a model copied, which is stripped with a warning). */
export function parseRef(ref: string, label: string, warnings: string[]): string {
  let s = ref.trim();
  const numbered = s.match(NUMBERED_ROW);
  const paren = s.match(PAREN_SUFFIX);
  const anchored = s.match(ANCHOR_ROW);
  if (numbered?.[1]) {
    warnings.push(`[W_BAD_REF] Stripped line-numbered row from ${label} "${clip(s, 48)}".`);
    s = numbered[1];
  } else if (paren?.[1]) {
    warnings.push(`[W_BAD_REF] Stripped "(line N)" suffix from ${label} "${clip(s, 48)}".`);
    s = paren[1];
  } else if (anchored?.[2]) {
    const marker =
      anchored[1] === "+" ? "diff-preview marker" : anchored[1] === "-" ? 'leading "-" marker' : '"anchor│" prefix';
    warnings.push(`[W_BAD_REF] Stripped ${marker} from ${label} "${clip(s, 48)}".`);
    s = anchored[2];
  }
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0]) s = s.slice(1, -1).trim();
  if (s.length === LEN && /^[A-Za-z]+$/.test(s)) {
    const hash = s.toLowerCase();
    if (hash !== s) warnings.push(`[W_ANCHOR_CASE] ${label} "${s}" was lowercased to "${hash}".`);
    return hash;
  }
  if (!s)
    throw new Error(
      `[E_BAD_REF] Invalid anchor. Expected a 5-character anchor (lowercase letters, e.g. "abcde") from read output.`,
    );
  if (/^\d+/.test(s))
    throw new Error(
      `[E_BAD_REF] Invalid anchor. Use the anchor alone (e.g. "abcde") with no line numbers or trailing content; anchors come from a read row and are exactly 5 lowercase letters.`,
    );
  if (s.includes(SEP))
    throw new Error(
      `[E_BAD_REF] Invalid anchor "${s.slice(0, 60)}": use only the 5-character anchor, drop everything from "│" onward (any line number, gutter, and content).`,
    );
  throw new Error(
    `[E_BAD_REF] Invalid anchor "${s.slice(0, 60)}". Expected a 5-character anchor (lowercase letters, e.g. "abcde") from read output.`,
  );
}

/** `text`'s lines: "" is none, a trailing newline ends the last line, a lone newline is one blank line. */
export const payloadLines = (text: string) => (text ? splitLines(text.replace(/\r\n?/g, "\n")) : []);

/** Strips `anchor│` and `+anchor│`/`-anchor│` prefixes a model copied into content lines, with a warning each. */
export function stripPrefixes(lines: string[], warnings: string[], indexOffset = 0): string[] {
  const bare: number[] = [];
  const diff: number[] = [];
  const out = lines.map((line, i) => {
    const b = line.match(BARE_PREFIX);
    const d = b ? undefined : (line.match(PLUS_PREFIX) ?? line.match(MINUS_PREFIX));
    if (b) bare.push(i);
    if (d) diff.push(i);
    return line.slice((b ?? d)?.[0].length ?? 0);
  });
  const at = (is: number[]) => is.map((i) => `text line ${i + 1 + indexOffset}`).join(", ");
  if (bare.length) warnings.push(`[W_BARE_HASH_PREFIX] Stripped "anchor│" prefix from ${at(bare)}.`);
  if (diff.length) warnings.push(`[W_INVALID_PATCH] Stripped diff-preview marker from ${at(diff)}.`);
  return out;
}

/** Rows of `lines` from `from` to `to` (1-based, inclusive) with their line numbers, for error feedback. */
const contextRows = (lines: string[], anchors: string[], from: number, to: number) =>
  Array.from(
    { length: to - from + 1 },
    (_, k) => `    ${from + k}: ${row(anchors[from + k - 1] ?? "", clip(lines[from + k - 1] ?? ""))}`,
  );

/** Thrown for a range the model was never shown (or that changed): carries the range's anchors, now served. */
export class RangeStaleError extends Error {
  constructor(
    message: string,
    readonly fresh: string[],
  ) {
    super(message);
  }
}

/**
 * The 0-based lines `from`..`to` of a replacement of `fromRef`..`toRef` in `file` (whose `anchors` match `lines`):
 * reversed bounds are swapped, a pure deletion skips blank edge lines, an anchor not in the file is stale, and every
 * line of the range must have been served (a deletion: only its edges).
 */
export function resolveRange(
  file: FileAnchors,
  lines: string[],
  fromRef: string,
  toRef: string,
  deletion: boolean,
  path: string,
  warnings: string[],
): [number, number] {
  const at = (a: string) => file.anchors.indexOf(a);
  let [from, to] = [at(fromRef), at(toRef)];
  const missing = [fromRef, toRef].filter((a, i, all) => at(a) < 0 && all.indexOf(a) === i);
  if (missing.length) {
    const found = from >= 0 ? from : to;
    const near = found >= 0 && missing.length === 1 ? (found === from ? fromRef : toRef) : undefined;
    const context =
      near === undefined
        ? ""
        : `\n\n  Current context around resolved anchor "${near}" (line ${found + 1}):\n${contextRows(lines, file.anchors, Math.max(1, found), Math.min(lines.length, found + 2)).join("\n")}`;
    throw new RangeStaleError(
      `[E_STALE_ANCHOR] ${missing.length} stale anchor${missing.length > 1 ? "s" : ""} in ${path}: ${missing.map((a) => `"${a}"`).join(", ")}. The file changed since read. Call read() on ${path} for fresh anchors.${context}`,
      near === undefined ? [] : file.anchors.slice(Math.max(0, found - 1), found + 2),
    );
  }
  if (from > to) {
    warnings.push(
      `[H_RANGE_REVERSED] "remove_from" refers to line ${from + 1} after "remove_to" (line ${to + 1}); lines ${to + 1}-${from + 1} were replaced in document order.`,
    );
    [from, to] = [to, from];
  }
  if (deletion) {
    const blank = (i: number) => !(lines[i] ?? "").trim();
    let [s, e] = [from, to];
    while (s <= e && blank(s)) s++;
    while (e >= s && blank(e)) e--;
    if (s <= e) [from, to] = [s, e];
  }
  const served = new Set(file.served);
  const unserved: number[] = [];
  for (let i = from; i <= to; i++) {
    if (deletion && i !== from && i !== to) continue;
    if (!served.has(file.anchors[i] ?? "")) unserved.push(i + 1);
  }
  if (unserved.length) {
    const count = to - from + 1;
    const shown = Math.min(count, 100);
    const rows = Array.from({ length: shown }, (_, k) =>
      row(file.anchors[from + k] ?? "", clip(lines[from + k] ?? "")),
    );
    const range = `the replaced range (lines ${from + 1}-${to + 1}) in ${path}`;
    const what =
      unserved.length === 1
        ? `Line ${unserved[0]} of ${range} was never shown or changed on disk`
        : `${unserved.length} of ${count} line(s) in ${range} were never shown or changed on disk`;
    const hint =
      count > shown
        ? `\n\n[The range has ${count} lines; showing the first ${shown}. Call read() on ${path} with offset=${from + 1 + shown} to see the rest.]`
        : "\n\nRetry with the fresh anchors above without a read.";
    throw new RangeStaleError(
      `[E_RANGE_STALE] ${what}. Current range with fresh anchors:\n\n${rows.join("\n")}${hint}`,
      file.anchors.slice(from, from + shown),
    );
  }
  return [from, to];
}

interface Side {
  lines: string[];
  anchors: string[];
}

/**
 * The post-edit diff: context rows ` anchor│line`, removed `-anchor│line` (dead anchors), added `+anchor│line` (fresh
 * ones), ` ...` for skipped lines; and each row's line number (new lines; old ones for removed rows).
 */
export function diffRows(old: Side, neu: Side, span: Span, context: number) {
  let [os, oe, ns, ne] = [span.start, span.end, span.start, span.start + span.count - 1];
  const same = (o: number, n: number) => old.lines[o] === neu.lines[n] && old.anchors[o] === neu.anchors[n];
  while (os <= oe && ns <= ne && same(os, ns)) [os, ns] = [os + 1, ns + 1];
  while (os <= oe && ns <= ne && same(oe, ne)) [oe, ne] = [oe - 1, ne - 1];
  const rows: string[] = [];
  const numbers: (number | undefined)[] = [];
  const emit = (prefix: string, side: Side, i: number) => {
    rows.push(`${prefix}${row(side.anchors[i] ?? " ".repeat(LEN), side.lines[i] ?? "")}`);
    numbers.push(i + 1);
  };
  const skip = () => {
    rows.push(" ...");
    numbers.push(undefined);
  };
  const blank = (i: number) => !(neu.lines[i] ?? "").trim();
  // leading context: a blank boundary line doesn't count
  let lead = Math.min(ns, context + (context > 0 && ns > context && blank(ns - context) ? 1 : 0));
  if (ns - lead > 0) skip();
  for (; lead > 0; lead--) emit(" ", neu, ns - lead);
  for (let i = os; i <= oe; i++) emit("-", old, i);
  for (let i = ns; i <= ne; i++) emit("+", neu, i);
  const rest = neu.lines.length - ne - 1;
  const trail = Math.min(rest, context + (context > 0 && rest > context && blank(ne + context) ? 1 : 0));
  for (let k = 1; k <= trail; k++) emit(" ", neu, ne + k);
  if (rest > trail) skip();
  // a removed row whose anchor is still live elsewhere shows no anchor
  const live = new Set(rows.filter((r) => /^[+ ][a-z]/.test(r)).map((r) => r.slice(1, 1 + LEN)));
  return {
    diff: rows
      .map((r) => (r.startsWith("-") && live.has(r.slice(1, 1 + LEN)) ? `-${" ".repeat(LEN)}${r.slice(1 + LEN)}` : r))
      .join("\n"),
    numbers,
    first: ns + 1,
  };
}

/** Anchors on `+`/` ` rows of a diff: the ones it serves. */
export const diffAnchors = (diff: string) =>
  diff
    .split("\n")
    .map((r) => r.match(new RegExp(`^[+ ]([a-z]{${LEN}})${SEP}`))?.[1])
    .filter((a) => a !== undefined);

const ECHO = new RegExp(`^(?: *[0-9]+(?: ${SEP} |[:-]${SEP} ))?[+ -]?(${RUN})${SEP}`);

/** The first line of `content` that starts with a copied served anchor row, if any. */
export function findEcho(content: string, served: Set<string>) {
  const lines = splitLines(content);
  for (const [i, line] of lines.entries()) {
    const hash = line.match(ECHO)?.[1]?.toLowerCase();
    if (hash && served.has(hash)) return { line: i + 1, hash };
  }
  return undefined;
}

/** `text` with a `N │ ` gutter before each `anchor│` row (pi's expanded read view). */
export function numbered(text: string, offset: number) {
  const isRow = (l: string) => new RegExp(`^[a-z]{${LEN}}${SEP}`).test(l);
  const lines = text.split("\n");
  const width = String(offset + Math.max(0, lines.filter(isRow).length - 1)).length;
  let n = offset;
  return lines.map((l) => (isRow(l) ? `${String(n++).padStart(width)} ${SEP} ${l}` : l)).join("\n");
}
