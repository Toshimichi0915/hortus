import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

/** Pure policy: config schema, rule composition and evaluation, bash command analysis. No hortus imports. */

export type Action = "allow" | "ask" | "deny";
const ActionSchema = z.enum(["allow", "ask", "deny"]);
const PatternValue = z.union([
  ActionSchema,
  z.strictObject({ action: z.literal("deny"), reason: z.string().optional() }),
]);
type PatternValue = z.infer<typeof PatternValue>;
const Permission = z.record(z.string(), z.union([ActionSchema, z.record(z.string(), PatternValue)]));
export type Permission = z.infer<typeof Permission>;

export const ConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  permission: Permission.optional(),
  /** per-subrun policy, keyed by the subrun's `ctx.run.source` (hortus has no agent names; Pi: agent frontmatter) */
  agents: z.record(z.string(), z.strictObject({ permission: Permission })).optional(),
  yoloMode: z.boolean().optional(),
  /** deny a prompt nobody answers within this many ms once shown (a key press stops the clock) */
  promptTimeoutMs: z.number().int().positive().optional(),
  permissionReviewLog: z.boolean().optional(),
  /** names of `permissions:authorize` handlers consulted, in this order, before prompting */
  authorizerChain: z.array(z.string()).max(1000).optional(),
  /** global only: project roots whose `.hortus/permission-system.json` is loaded */
  trustedProjects: z.array(z.string()).max(1000).optional(),
  defaultProjectTrust: z.boolean().optional(),
  /** directories reads may reach outside the working directory without the external_directory gate */
  infrastructureReadPaths: z.array(z.string()).max(1000).optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export interface Rule {
  surface: string;
  pattern: string;
  action: Action;
  reason?: string;
  /** the scope that wrote it: "global", "project", "agent", "project-agent", "session", or "builtin" (the default) */
  origin: string;
  /** "default": the universal `*` fallback, which the path gate ignores (it only enforces configured path rules) */
  layer: "default" | "config" | "session";
}

export const expandHome = (p: string) => p.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());

const compiled = new Map<string, RegExp>();
/** `*` matches anything (separators included), `?` one character; a trailing " *" also matches the bare command. */
export function wildcard(pattern: string, value: string): boolean {
  let re = compiled.get(pattern);
  if (!re) {
    let src = expandHome(pattern)
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\?", "."))
      .join(".*");
    if (src.endsWith(" .*")) src = `${src.slice(0, -3)}( .*)?`;
    re = new RegExp(`^${src}$`, "s");
    compiled.set(pattern, re);
  }
  return re.test(value);
}

const FAMILIES: Record<string, string[]> = {
  path: ["path_read", "path_write"],
  external_directory: ["external_directory_read", "external_directory_write"],
};

/**
 * Merges scopes (lowest precedence first): a string replaces, two pattern maps merge shallowly, a map replaces a string.
 * Then expands the `path`/`external_directory` sugar into its directional members (sugar entries first, explicit
 * directional ones after, so they win) and returns the rules, the universal `*` fallback first (default "ask").
 */
export function compose(scopes: [origin: string, Permission | undefined][]): Rule[] {
  const merged: Permission = {};
  const origins = new Map<string, string>();
  for (const [origin, permission] of scopes)
    for (const [surface, value] of Object.entries(permission ?? {})) {
      const prev = merged[surface];
      merged[surface] = typeof value === "object" && typeof prev === "object" ? { ...prev, ...value } : value;
      for (const pattern of typeof value === "object" ? Object.keys(value) : ["*"])
        origins.set(`${surface}\0${pattern}`, origin);
    }
  const entries = new Map<string, Map<string, [PatternValue, string]>>();
  const put = (surface: string, from: string, value: Permission[string]) => {
    const map = entries.get(surface) ?? new Map();
    entries.set(surface, map);
    for (const [pattern, v] of Object.entries(typeof value === "string" ? { "*": value } : value)) {
      map.delete(pattern);
      map.set(pattern, [v, origins.get(`${from}\0${pattern}`) ?? "builtin"]);
    }
  };
  for (const [key, value] of Object.entries(merged)) for (const m of FAMILIES[key] ?? []) put(m, key, value);
  for (const [key, value] of Object.entries(merged)) if (!FAMILIES[key] && key !== "*") put(key, key, value);
  const universal = merged["*"];
  const rules: Rule[] = [
    {
      surface: "*",
      pattern: "*",
      action: typeof universal === "string" ? universal : "ask",
      origin: origins.get("*\0*") ?? "builtin",
      layer: "default",
    },
  ];
  for (const [surface, map] of entries)
    for (const [pattern, [v, origin]] of map)
      rules.push(
        typeof v === "string"
          ? { surface, pattern, action: v, origin, layer: "config" }
          : { surface, pattern, action: "deny", ...(v.reason && { reason: v.reason }), origin, layer: "config" },
      );
  return rules;
}

/** Pi's fail-closed clamp, for an invalid project or agent scope: nothing resolves more permissively than ask. */
export const floorAllows = (rules: Rule[]): Rule[] =>
  rules.map((r) => (r.action === "allow" ? { ...r, action: "ask", origin: "fail-closed" } : r));

/** The last rule whose surface and pattern match `surface` and any of `values` (last match wins). */
export function evaluate(rules: readonly Rule[], surface: string, values: readonly string[]): Rule {
  const vs = values.length ? values : ["*"];
  for (let i = rules.length; i--; ) {
    const r = rules[i];
    if (r && wildcard(r.surface, surface) && vs.some((v) => wildcard(r.pattern, v))) return r;
  }
  return { surface, pattern: "*", action: "ask", origin: "builtin", layer: "default" };
}

/** Whether every value on `surface` resolves to deny (probing the catch-all and each configured pattern), so hiding is safe. */
export function fullyDenied(rules: readonly Rule[], surface: string): boolean {
  const probes = new Set(["*", ...rules.filter((r) => wildcard(r.surface, surface)).map((r) => expandHome(r.pattern))]);
  return [...probes].every((p) => evaluate(rules, surface, [p]).action === "deny");
}

/** One thing a call does, judged on its own; a call is blocked by any deny and asks once for all its asks. */
export interface Check {
  /** most restrictive across them (both directions of an access with no known direction) */
  surfaces: string[];
  values: string[];
  /** what it is, for messages and the prompt */
  what: string;
  /** the pattern "allow for this session" records on each surface */
  grant: string;
  /** a synthetic sentinel that clamps an allow to ask (unparsed commands, wrappers hiding what runs) */
  floor?: string;
  /** ignore the universal fallback: only configured rules apply (Pi's path gate) */
  configuredOnly?: boolean;
  /** skip unless a configured rule names this path specifically (Pi's infrastructure reads: skills, extra dirs) */
  infrastructure?: boolean;
}

export interface Decision {
  check: Check;
  action: Action;
  rule: Rule;
  /** the surface that decided */
  surface: string;
}

export function decide(rules: readonly Rule[], check: Check, yolo: boolean): Decision {
  let worst: Decision | undefined;
  for (const surface of check.surfaces) {
    const rule = evaluate(rules, surface, check.values);
    let action: Action = rule.action;
    if (check.configuredOnly && rule.layer === "default") action = "allow";
    if (check.infrastructure && !(action === "deny" && rule.layer === "config" && !/^\*+$/.test(rule.pattern)))
      action = "allow";
    let d: Decision = { check, action, rule, surface };
    if (action === "allow" && check.floor && rule.layer !== "session")
      d = { ...d, action: "ask", rule: { ...rule, pattern: check.floor, origin: "floor" } };
    if (!worst || rank(d.action) > rank(worst.action)) worst = d;
  }
  if (!worst) throw new Error("A check needs a surface");
  if (yolo && worst.action === "ask") return { ...worst, action: "allow", rule: { ...worst.rule, origin: "yolo" } };
  return worst;
}
const rank = (a: Action) => ({ allow: 0, ask: 1, deny: 2 })[a];

// ── bash ────────────────────────────────────────────────────────────────────

export interface BashUnit {
  /** as typed, leading `VAR=value` assignments stripped */
  text: string;
  /** shell words, quotes removed */
  words: string[];
  /** `>`/`<` targets, with their direction */
  redirects: { path: string; dir: "read" | "write" }[];
  /** "inside command substitution", "inside a subshell"... */
  nested?: string;
  /** its working directory after literal `cd`s earlier in the chain; undefined once a `cd` went somewhere unknown */
  cwd?: string;
}

const OPS = ["&&", "||", ";;", ";", "|&", "|", "&", "\n"];
const REDIRECT = /^(?:\d*|&)(>>|>\||>&|>|<>|<&|<(?!<))/;

/**
 * Splits a command into the units that run: top-level chains, and (also) what runs inside `$(…)`, backticks, `<(…)`,
 * `>(…)` and `( … )`. `unparsed`: something couldn't be followed (unbalanced quotes, an unquoted heredoc that
 * substitutes), so the caller floors the whole command to ask. Not a full shell grammar (Pi uses tree-sitter-bash).
 */
export function parseBash(command: string, cwd: string): { units: BashUnit[]; unparsed: boolean } {
  const units: BashUnit[] = [];
  let unparsed = false;
  const walk = (src: string, nested: string | undefined, startCwd: string | undefined) => {
    let dir = startCwd;
    let words: string[] = [];
    let redirects: BashUnit["redirects"] = [];
    let word = "";
    let inWord = false;
    let redirect: "read" | "write" | "skip" | undefined;
    let start = 0;
    const heredocs: { delim: string; strip: boolean; quoted: boolean }[] = [];
    const endWord = () => {
      if (inWord) {
        if (redirect) {
          if (redirect !== "skip" && !/^(\d+|-)$/.test(word)) redirects.push({ path: word, dir: redirect });
          redirect = undefined;
        } else words.push(word);
      }
      word = "";
      inWord = false;
    };
    const endUnit = (end: number) => {
      endWord();
      const text = src
        .slice(start, end)
        .trim()
        .replace(/^(?:[A-Za-z_]\w*=(?:'[^']*'|"(?:\\.|[^"])*"|\S*)\s+)+/, "");
      while (words[0] !== undefined && /^[A-Za-z_]\w*=/.test(words[0])) words.shift();
      if (words.length) {
        units.push({ text, words, redirects, ...(nested && { nested }), ...(dir !== undefined && { cwd: dir }) });
        if (words[0] === "cd") {
          const to = words[1];
          dir =
            dir === undefined || to === undefined || /[$`*?]/.test(to) || to === "-"
              ? undefined
              : resolve(dir, expandHome(to));
        }
      }
      words = [];
      redirects = [];
    };
    // the end of a substitution starting at i (after its closing), walking what runs inside; -1 if unbalanced
    const sub = (i: number): number => {
      if (src.startsWith("$((", i)) {
        const j = src.indexOf("))", i);
        return j < 0 ? -1 : j + 2;
      }
      if (src[i] === "`") {
        let j = i + 1;
        while (j < src.length && src[j] !== "`") j += src[j] === "\\" ? 2 : 1;
        if (j >= src.length) return -1;
        walk(src.slice(i + 1, j), "inside command substitution", dir);
        return j + 1;
      }
      const open = i + 1; // `$(`, `<(` or `>(`: the paren is next
      const close = matchParen(src, open);
      if (close < 0) return -1;
      walk(
        src.slice(open + 1, close),
        src[i] === "$" ? "inside command substitution" : "inside process substitution",
        dir,
      );
      return close + 1;
    };
    let i = 0;
    while (i < src.length && !unparsed) {
      const c = src[i] ?? "";
      if (c === "\\") {
        if (src[i + 1] !== "\n") {
          word += src[i + 1] ?? "";
          inWord = true;
        }
        i += 2;
      } else if (c === "'") {
        const j = src.indexOf("'", i + 1);
        if (j < 0) unparsed = true;
        word += src.slice(i + 1, j);
        inWord = true;
        i = j + 1;
      } else if (c === '"') {
        let j = i + 1;
        while (j < src.length && src[j] !== '"' && !unparsed) {
          if (src[j] === "\\") {
            word += src[j + 1] ?? "";
            j += 2;
          } else if (src.startsWith("$(", j) || src[j] === "`") {
            const k = sub(j);
            if (k < 0) unparsed = true;
            word += src.slice(j, k);
            j = k;
          } else word += src[j++];
        }
        if (j >= src.length) unparsed = true;
        inWord = true;
        i = j + 1;
      } else if (src.startsWith("$(", i) || c === "`" || ((c === "<" || c === ">") && src[i + 1] === "(")) {
        const k = sub(i);
        if (k < 0) unparsed = true;
        word += src.slice(i, k);
        inWord = true;
        i = k;
      } else if (c === "#" && !inWord) {
        const j = src.indexOf("\n", i);
        i = j < 0 ? src.length : j;
      } else if (c === "(" && !inWord && !words.length) {
        const close = matchParen(src, i);
        if (close < 0) unparsed = true;
        walk(src.slice(i + 1, close), "inside a subshell", dir);
        i = close + 1;
        start = i;
      } else if (src.startsWith("<<<", i)) {
        endWord();
        redirect = "skip";
        i += 3;
      } else if (src.startsWith("<<", i)) {
        endWord();
        const m = /^<<(-?)\s*(['"]?)([^\s'";&|<>()]+)\2/.exec(src.slice(i));
        if (!m) unparsed = true;
        else heredocs.push({ strip: m[1] === "-", quoted: m[2] !== "", delim: m[3] ?? "" });
        i += m?.[0].length ?? 2;
      } else if ((c === ">" || c === "<" || (c === "&" && src[i + 1] === ">")) && (!inWord || /^\d+$/.test(word))) {
        const m = REDIRECT.exec(src.slice(i)) ?? /^&>>?/.exec(src.slice(i));
        word = "";
        inWord = false;
        const op = m?.[1] ?? m?.[0] ?? c;
        redirect = op.startsWith("<") && op !== "<>" ? (op === "<&" ? "skip" : "read") : op === ">&" ? "skip" : "write";
        i += m?.[0].length ?? 1;
      } else {
        const op = OPS.find((o) => src.startsWith(o, i));
        if (op) {
          endUnit(i);
          i += op.length;
          if (op === "\n")
            for (const h of heredocs.splice(0)) {
              const lines = src.slice(i).split("\n");
              const n = lines.findIndex((l) => (h.strip ? l.replace(/^\t+/, "") : l) === h.delim);
              if (n < 0) {
                unparsed = true;
                break;
              }
              const body = lines.slice(0, n).join("\n");
              // an unquoted heredoc's body substitutes; not followed here, so floor it
              if (!h.quoted && /\$\(|`/.test(body)) unparsed = true;
              i += lines.slice(0, n + 1).join("\n").length + 1;
            }
          start = i;
        } else if (/\s/.test(c)) {
          endWord();
          i++;
        } else {
          word += c;
          inWord = true;
          i++;
        }
      }
    }
    if (heredocs.length) unparsed = true;
    endUnit(src.length);
  };
  walk(command, undefined, cwd);
  return { units, unparsed };
}

/** The index of the `)` closing the `(` at `open`, skipping quoted text; -1 if none. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "'") {
      i = src.indexOf("'", i + 1);
      if (i < 0) return -1;
    } else if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === "\\") i++;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Wrappers that only change how their command runs: decided exactly as that command (with how many args they take). */
const TRANSPARENT: Record<string, number> = { time: 0, nice: 0, timeout: 1, stdbuf: 0, setsid: 0 };
const OPAQUE_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const INDIRECT = new Set([
  "sudo",
  "doas",
  "env",
  "xargs",
  "nohup",
  "parallel",
  "rust-parallel",
  "rush",
  "watch",
  "flock",
]);
/** Commands that only read the paths they're given (Pi's pure-reader core, abridged). */
const READERS = new Set(
  "cat less more head tail grep egrep fgrep rg ls tree wc file stat du diff find fd realpath readlink sort uniq cut md5sum sha256sum cd pwd".split(
    " ",
  ),
);
/** Bash subcommand arity, for session approval patterns (Pi's arity table, abridged): `git status *`, `npm run *`. */
const ARITY: Record<string, number> = Object.fromEntries(
  "git npm pnpm yarn bun deno cargo go docker kubectl gh pip uv brew apt systemctl terraform make"
    .split(" ")
    .map((c) => [c, 2]),
);
const SAFE_PATHS = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

/** What a unit runs once transparent wrappers are peeled; `floor` when a wrapper hides the command from the rules. */
export function analyzeUnit(unit: BashUnit): { words: string[]; floor?: string } {
  let words = unit.words;
  for (let n = TRANSPARENT[words[0] ?? ""]; n !== undefined; n = TRANSPARENT[words[0] ?? ""]) {
    let i = 1;
    while (words[i]?.startsWith("-")) i += words[i] === "-n" && words[0] === "nice" ? 2 : 1;
    words = words.slice(i + n);
  }
  const [cmd = "", ...args] = words;
  if (cmd === "eval" || (OPAQUE_SHELLS.has(cmd) && args.some((a) => /^-\w*c/.test(a))))
    return { words, floor: "<opaque-bash-wrapper>" };
  const env = cmd === "env" && !args.some((a) => !a.startsWith("-") && !a.includes("="));
  if (
    (INDIRECT.has(cmd) && !env) ||
    (/^(find|fd)$/.test(cmd) && args.some((a) => /^(-exec|-execdir|-ok|-okdir|-x|--exec|-X|--exec-batch)$/.test(a)))
  )
    return { words, floor: "<indirection-bash-wrapper>" };
  return { words };
}

/** The path-like arguments and redirect targets of a unit, absolute (or as typed when its cwd is unknown), with direction. */
export function bashPaths(unit: BashUnit, words: string[]): { path: string; abs?: string; dir?: "read" | "write" }[] {
  const pathLike = (w: string) =>
    !w.startsWith("-") &&
    !/[$`*?[\]]/.test(w) &&
    (w.includes("/") || w.startsWith(".") || w.startsWith("~") || (!!unit.cwd && existsSync(resolve(unit.cwd, w))));
  const abs = (w: string) => {
    const p = expandHome(w);
    return isAbsolute(p) ? p : unit.cwd && resolve(unit.cwd, p);
  };
  const dir: "read" | undefined = READERS.has(words[0] ?? "") ? "read" : undefined;
  return [
    ...words
      .slice(1)
      .filter(pathLike)
      .map((w) => ({ path: w, abs: abs(w), ...(dir && { dir }) })),
    ...unit.redirects.map((r) => ({ path: r.path, abs: abs(r.path), dir: r.dir })),
  ].filter((p) => !SAFE_PATHS.has(p.abs ?? p.path));
}

/** The session pattern for a command: its first word (two for tools with subcommands), then " *". */
export function commandGrant(words: string[]): string {
  const n = ARITY[words[0] ?? ""] ?? 1;
  return words.length <= n ? words.join(" ") : `${words.slice(0, n).join(" ")} *`;
}

/** A path as rules may name it: as typed, absolute, and symlink-resolved (so a deny can't be dodged through a link). */
export function pathValues(typed: string, abs: string | undefined): string[] {
  const values = new Set([typed]);
  if (abs) {
    values.add(abs);
    try {
      values.add(realpathSync(abs));
    } catch {
      // not on disk (yet): a write's target; its directory may still be a link
      try {
        values.add(resolve(realpathSync(dirname(abs)), relative(dirname(abs), abs)));
      } catch {}
    }
  }
  return [...values];
}

export const outside = (abs: string, cwd: string) => {
  const rel = relative(cwd, abs);
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
};
