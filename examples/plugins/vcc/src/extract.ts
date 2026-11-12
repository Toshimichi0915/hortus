/**
 * pi-vcc's extraction helpers (sanitize, tool args, user messages, files, commits, tracked commands), ported from
 * @sting8k/pi-vcc 0.11.2 (MIT) with its comments; only the Pi message types are replaced by `NormalizedBlock`s.
 */

export interface FileOps {
  readFiles?: string[];
  modifiedFiles?: string[];
  createdFiles?: string[];
}

export type NormalizedBlock =
  // `injected`: the text came from a plugin's message (`meta`), not from the user. It renders in the brief but is not
  // read into [Early Session Requests] or [User Messages].
  | { kind: "user"; text: string; sourceIndex?: number; injected?: boolean }
  | { kind: "assistant"; text: string; sourceIndex?: number }
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number }
  | { kind: "tool_result"; name: string; text: string; sourceIndex?: number }
  | { kind: "bash"; command: string; output: string; exitCode: number | undefined; sourceIndex?: number };

// ── core/sanitize.ts ──
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are what it strips
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

export const sanitize = (text: string): string =>
  text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(ANSI_RE, "").replace(CTRL_RE, "");

// ── core/skill-collapse.ts ──
/** Shared skill-tag collapse utilities */

/** Collapse <skill name="X" ...>...</skill> blocks in raw text */
export const SKILL_BLOCK_RE = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?(?:<\/skill>|$)/g;
export const collapseSkillText = (text: string): string =>
  text.replace(SKILL_BLOCK_RE, (_, name) => `[skill: ${name}]`);

// ── core/tool-args.ts ──
export const PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;

export const extractPath = (args: Record<string, unknown>): string | null => {
  for (const key of ["path", "file_path", "filePath", "file"]) {
    if (typeof args[key] === "string") return args[key] as string;
  }
  return null;
};

/** Every file a tool call names: its single path arg, else a string-array `paths` arg (multi-file edit tools). */
export const extractPaths = (args: Record<string, unknown>): string[] => {
  const one = extractPath(args);
  if (one) return [one];
  return Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string" && p !== "") : [];
};

export const summarizeToolArgs = (args: Record<string, unknown>): string => {
  const [path, ...more] = extractPaths(args);
  if (path) return `path=${path}${more.length ? ` +${more.length}` : ""}`;
  if (typeof args.command === "string") return `command=${args.command}`;
  if (typeof args.query === "string") return `query=${args.query}`;
  return Object.keys(args).join(", ");
};

// ── core/content.ts ──

export const clip = (text: string, max = 200): string => {
  if (text.length <= max) return text;
  // Try to cut at a word boundary
  const cut = text.lastIndexOf(" ", max);
  let end = cut > max * 0.6 ? cut : max;
  // Avoid splitting a surrogate pair
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return text.slice(0, end);
};

/**
 * Check if tool call arguments contain content-bearing data.
 *
 * A call is content-bearing if it has a path argument AND at least one
 * large string/array field (content, edits, oldText, newText).
 * This is a generic heuristic — not dependent on tool names.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export const isContentBearing = (args: Record<string, unknown>): boolean => {
  if (!args || typeof args !== "object") return false;
  // Must have a path in one of the known keys
  const hasPath = PATH_KEYS.some((k) => typeof args[k] === "string");
  if (!hasPath) return false;
  // Must have at least one content-bearing field
  if (typeof args.content === "string" && args.content.length > 0) return true;
  // edits must be a non-empty array of objects (each with oldText/newText)
  if (
    Array.isArray(args.edits) &&
    args.edits.length > 0 &&
    args.edits.every((e) => typeof e === "object" && e !== null)
  )
    return true;
  // oldText/newText without edits are content-bearing
  if (typeof args.oldText === "string" && args.oldText.length > 0 && args.edits === undefined) return true;
  if (typeof args.newText === "string" && args.newText.length > 0 && args.edits === undefined) return true;
  return false;
};

/**
 * Extract textual content from tool call arguments (content, edits,
 * oldText, newText). Used for counting touched-file lines and search.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export const extractToolCallText = (args: Record<string, unknown>): string => {
  let text = "";
  if (typeof args.content === "string") text += `${args.content}\n`;
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === "object") {
        if (typeof edit.oldText === "string") text += `${edit.oldText}\n`;
        if (typeof edit.newText === "string") text += `${edit.newText}\n`;
      }
    }
  }
  if (typeof args.oldText === "string" && !Array.isArray(args.edits)) text += `${args.oldText}\n`;
  if (typeof args.newText === "string" && !Array.isArray(args.edits)) text += `${args.newText}\n`;
  return text;
};

/**
 * Extract every scalar string argument from a tool call for search indexing
 * — command, query, content, oldText/newText, etc. Generic value walk (no
 * tool-name allowlist): top-level strings plus strings one level into
 * array-of-object fields (e.g. `edits`). Unbounded by design — a single
 * toolCall's raw argument text — so a message with several toolCalls doesn't
 * silently multiply an internal cap. The caller (search-entries.ts) applies
 * one shared budget across all toolCalls in a message.
 */
export const extractToolCallArgsText = (args: Record<string, unknown>): string => {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const value of Object.values(args)) {
    if (typeof value === "string") {
      parts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          parts.push(item);
        } else if (item && typeof item === "object") {
          for (const v of Object.values(item)) {
            if (typeof v === "string") parts.push(v);
          }
        }
      }
    }
  }
  return parts.join("\n");
};

// ── extract/user-messages.ts ──

/** Each user message becomes one item, clipped to this many characters. */
const USER_MESSAGE_CHARS = 300;
/** [Early Session Requests] keeps this many of the first messages. */
export const EARLY_REQUESTS_KEPT = 3;
/** [User Messages] keeps this many of the newest messages. */
const USER_MESSAGES_KEPT = 15;

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Words in any script: Intl.Segmenter splits CJK and Thai too. */
const wordCount = (text: string): number => {
  let n = 0;
  for (const seg of segmenter.segment(text)) if (/[\p{L}\p{N}]/u.test(seg.segment)) n++;
  return n;
};

/**
 * The user's own words in a message, on one line. An expanded skill alone
 * is not the user's words: a skill with text keeps the text behind a
 * `[skill: name]` tag. Text that opens with a tag (`<peer_message …>`,
 * `<local-command-stdout>`) was put there by a tool, and one-word replies
 * ("ok", "好的") say little: both are dropped.
 */
const userLine = (text: string): string => {
  const skills: string[] = [];
  const rest = text
    .replace(SKILL_BLOCK_RE, (_, name: string) => {
      skills.push(name);
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  if (rest.startsWith("<") || wordCount(rest) < 2) return "";
  return clip(skills.length > 0 ? `[skill: ${skills.join(", ")}] ${rest}` : rest, USER_MESSAGE_CHARS);
};

/** The newest `USER_MESSAGES_KEPT` lines, oldest first. A repeated line
 * counts as new: it moves to the end. */
export const keepNewestUserMessages = (lines: string[]): string[] => {
  const seq: string[] = [];
  for (const l of lines) {
    const at = seq.indexOf(l);
    if (at >= 0) seq.splice(at, 1);
    seq.push(l);
  }
  return seq.slice(-USER_MESSAGES_KEPT);
};

/**
 * What the user wrote, oldest first, verbatim and clipped. Messages the
 * user did not write (`injected`) are left out. No wording is interpreted, so this works
 * the same in every language.
 */
export const extractUserMessages = (blocks: NormalizedBlock[]): string[] => {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.kind !== "user" || b.injected) continue;
    const line = userLine(b.text);
    if (line) lines.push(line);
  }
  return lines;
};

// ── extract/files.ts ──

interface FileActivity {
  read: Set<string>;
  modified: Set<string>;
  created: Set<string>;
}

// Tool names are matched case-insensitively (see `matches`), mirroring the /i
// regexes in core/rank.ts. Entries must be lowercase.
const FILE_READ_TOOLS = new Set(["read", "read_file", "view"]);

// Multi-file patch tools (apply_patch) carry their paths inside the diff payload,
// not in a path arg, so extractPaths yields nothing for them; those files are
// recovered from the hook-provided fileOps below.
const FILE_WRITE_TOOLS = new Set([
  "edit",
  "write",
  "edit_file",
  "write_file",
  "multiedit",
  "quick_edit",
  "target_edit",
  "apply_patch",
]);

const FILE_CREATE_TOOLS = new Set(["write", "write_file"]);

const matches = (tools: Set<string>, name: string): boolean => tools.has(name.toLowerCase());

/**
 * Find the longest common directory prefix among absolute paths.
 * Returns "" if fewer than 2 absolute paths or no meaningful common prefix.
 */
const longestCommonDirPrefix = (paths: string[]): string => {
  const abs = paths.filter((p) => p.startsWith("/"));
  if (abs.length < 2) return "";
  const split = abs.map((p) => p.split("/"));
  const min = Math.min(...split.map((s) => s.length));
  let i = 0;
  while (i < min - 1) {
    const seg = split[0][i];
    if (!split.every((s) => s[i] === seg)) break;
    i++;
  }
  if (i < 2) return ""; // require at least /a/b common
  return `${split[0].slice(0, i).join("/")}/`;
};

const trimPaths = (set: Set<string>, prefix: string): Set<string> => {
  if (!prefix) return set;
  const out = new Set<string>();
  for (const p of set) {
    out.add(p.startsWith(prefix) ? p.slice(prefix.length) : p);
  }
  return out;
};

export const extractFiles = (blocks: NormalizedBlock[], fileOps?: FileOps): FileActivity => {
  const act: FileActivity = {
    read: new Set(fileOps?.readFiles ?? []),
    modified: new Set(fileOps?.modifiedFiles ?? []),
    created: new Set(fileOps?.createdFiles ?? []),
  };

  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    for (const p of extractPaths(b.args)) {
      if (matches(FILE_READ_TOOLS, b.name)) act.read.add(p);
      if (matches(FILE_WRITE_TOOLS, b.name)) act.modified.add(p);
      if (matches(FILE_CREATE_TOOLS, b.name)) act.created.add(p);
    }
  }

  const all = [...act.read, ...act.modified, ...act.created];
  const prefix = longestCommonDirPrefix(all);
  if (prefix) {
    act.read = trimPaths(act.read, prefix);
    act.modified = trimPaths(act.modified, prefix);
    act.created = trimPaths(act.created, prefix);
  }

  return act;
};

// ── extract/commits.ts ──

interface CommitInfo {
  hash?: string;
  message: string;
}

const COMMIT_MSG_RE =
  /git\s+commit[^\n]*?\s-[A-Za-z]*m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\$?'((?:[^'\\]|\\.)*)')/;
// `-F -` / `--file=-` reads the message from stdin; the heredoc feeding it sits on the same command.
// A file path after -F cannot be read from the transcript, so it is not matched.
const STDIN_HEREDOC_COMMIT_RE =
  /git\s+commit[^\n]*?(?:\s-[A-Za-z]*F|\s--file)(?:\s+|=)-(?=\s)[^\n]*?<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))[^\n]*(?:\r?\n|\\n)/;
// Match short hash from git output: "[branch hash]" or "main hash" or 7-12 hex
const HASH_RE = /\b([0-9a-f]{7,12})\b/;

const cleanMessage = (msg: string): string => msg.replace(/\\"/g, '"').replace(/\\'/g, "'").trim();

const linesOf = (text: string): string[] => text.split(/\\n|\n/);

const firstLineOf = (text: string): string => {
  const line = linesOf(text)[0] ?? "";
  return line.trim();
};

// COMMIT_MSG_RE only yields the `$(cat <<...` opener (truncated at the inner quote for <<"DELIM"), so heredoc -m is re-read from the raw command.
const HEREDOC_COMMIT_CMD_RE =
  /^git\s+commit[^\n"'&;|]*?\s-[A-Za-z]*m\s+"\$\(cat\s+<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))(?:\r?\n|\\n)/;

const firstHeredocBodyLine = (rest: string, delim: string): string => {
  for (const line of linesOf(rest)) {
    const trimmed = line.replace(/^\t+/, "").trim();
    if (trimmed === delim) break;
    if (trimmed) return trimmed;
  }
  return "";
};

const subjectFromHeredocCmd = (cmd: string): string | null => {
  const m = cmd.match(HEREDOC_COMMIT_CMD_RE);
  if (!m) return null;
  const delim = m[1] ?? m[2] ?? m[3] ?? "";
  return cleanMessage(firstHeredocBodyLine(cmd.slice((m.index as number) + m[0].length), delim));
};

const subjectFromStdinHeredoc = (cmd: string): string | null => {
  const m = cmd.match(STDIN_HEREDOC_COMMIT_RE);
  if (!m) return null;
  const delim = m[1] ?? m[2] ?? m[3] ?? "";
  return cleanMessage(firstHeredocBodyLine(cmd.slice((m.index as number) + m[0].length), delim));
};

// A later `git commit` starts a new commit only at a command boundary, so prose in a message that says "git commit" does not split it.
const COMMIT_START_RE = /\bgit\s+commit\b/g;
const commitSegments = (cmd: string): string[] => {
  const starts: number[] = [];
  for (const m of cmd.matchAll(COMMIT_START_RE)) {
    if (starts.length === 0 || /(?:^|[;&|(\n])\s*$/.test(cmd.slice(0, m.index))) starts.push(m.index as number);
  }
  return starts.map((at, k) => cmd.slice(at, starts[k + 1]));
};

/** Subject of the one `git commit ...` in `seg`, or "" when it cannot be read. */
const subjectOf = (seg: string): string => {
  const m = seg.match(COMMIT_MSG_RE);
  if (!m) return subjectFromStdinHeredoc(seg) ?? "";
  // First -m is `"$(cat <<DELIM ...`: COMMIT_MSG_RE only sees `$(cat <<...`, so read the heredoc body.
  const heredoc =
    m[1] !== undefined && /^\$\(cat\s+<</.test(m[1]) ? subjectFromHeredocCmd(seg.slice(m.index as number)) : null;
  const message = heredoc ?? firstLineOf(cleanMessage(m[1] ?? m[2] ?? m[3] ?? ""));
  return heredoc === null && /^\$\(cat\s+<</.test(message) ? "" : message;
};

/** Hash of a lone commit, from the next tool results; the first hash-looking text wins. */
const hashFromResults = (results: string[]): string | undefined => {
  for (const text of results) {
    // Common git commit output: `[branch <hash>] message` or `<branch> <hash>..<hash>`
    const bracket = text.match(/\[\S+\s+([0-9a-f]{7,12})\]/);
    if (bracket) return bracket[1];
    const range = text.match(/\b([0-9a-f]{7,12})\.\.([0-9a-f]{7,12})\b/);
    if (range) return range[2];
    const plain = text.match(HASH_RE);
    if (plain) return plain[1];
  }
  return undefined;
};

// `[branch <hash>] <subject>` (git commit) or `<hash> [(refs)] <subject>` (git log --oneline).
const HASH_SUBJECT_LINE_RE = /(?:\[\S+\s+([0-9a-f]{7,12})\]|^\s*([0-9a-f]{7,12})(?:\s+\([^)]*\))?)\s+(.*)/;

/** Hash of one of several commits in a command: only an output line that names that commit's subject counts. */
const hashForSubject = (results: string[], message: string): string | undefined => {
  for (const text of results) {
    for (const line of text.split("\n")) {
      const m = line.match(HASH_SUBJECT_LINE_RE);
      if (m && m[3].trim() === message) return m[1] ?? m[2];
    }
  }
  return undefined;
};

/**
 * Extract git commits from bash tool calls (`git commit -m "..."`) and pair
 * with hash from the immediately following tool_result.
 */
export const extractCommits = (blocks: NormalizedBlock[]): CommitInfo[] => {
  const commits: CommitInfo[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== "tool_call" || b.name !== "bash") continue;
    const cmd = typeof b.args.command === "string" ? b.args.command : "";
    const segments = commitSegments(cmd);
    if (segments.length === 0) continue;

    const results: string[] = [];
    for (let j = i + 1; j < Math.min(blocks.length, i + 3); j++) {
      const r = blocks[j];
      if (r.kind === "tool_result") results.push(r.text);
    }

    for (const seg of segments) {
      const message = subjectOf(seg);
      if (!message) continue;
      // With several commits one output cannot be split reliably, so a hash is taken only when its line names this subject.
      const hash = segments.length === 1 ? hashFromResults(results) : hashForSubject(results, message);

      // One entry per commit: the same message seen hashless (`-q` prints no hash) and hashed is one commit, keep the hashed.
      const dup = commits.find((c) => c.message === message && (!c.hash || !hash || c.hash === hash));
      if (!dup) commits.push({ hash, message });
      else if (hash && !dup.hash) dup.hash = hash;
    }
  }

  return commits;
};

export const formatCommits = (commits: CommitInfo[], limit = 8): string[] => {
  const lines: string[] = [];
  const items = commits.slice(-limit); // keep most recent
  for (const c of items) {
    const prefix = c.hash ? `${c.hash}: ` : "";
    lines.push(`${prefix}${c.message}`);
  }
  return lines;
};

// ── extract/tracked-commands.ts ──

/** Maximum characters kept per captured entry (a truncated one-liner, not a
 * parsed structure -- deliberately shallow, see module docstring below). */
const MAX_ENTRY_CHARS = 80;

/** Single-pass quote-aware scan: returns the index of every UNQUOTED
 * shell separator (`;`, `&`, `|`, newline). Quote state tracks ' and "
 * plus backslash escapes; separators inside quotes are not boundaries.
 * Deliberately stops there -- $( ) and backticks are not handled, keeping
 * this a 20-line tokenizer rather than a shell parser. */
const unquotedSeparators = (cmd: string): number[] => {
  const seps: number[] = [];
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      // Backslash escapes inside "..." only; inside '...' it is literal.
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\")
      i++; // `it\'s` is not an opening quote
    else if (c === "'" || c === '"') quote = c;
    // A comment runs to the newline; its apostrophes (`# don't`) are not quotes.
    else if (c === "#" && (i === 0 || /[\s;&|(]/.test(cmd[i - 1]))) {
      while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
    }
    // `2>&1`, `<&3`, `&>file` are redirections, not separators.
    else if (c === "&" && (cmd[i - 1] === ">" || cmd[i - 1] === "<" || cmd[i + 1] === ">")) continue;
    else if (c === ";" || c === "&" || c === "|" || c === "\n") seps.push(i);
  }
  return seps;
};

/** Cut `text` at the next UNQUOTED separator. Quotes are kept as written:
 * the cut never lands inside a quote, so they stay balanced. No truncation
 * here -- dedup must see the full string (two distinct invocations sharing
 * an 80-char prefix must not collapse); render-time truncation lives in
 * formatTrackedCommands. */
const captureEntry = (text: string): string => {
  const seps = unquotedSeparators(text);
  const cut = seps.length ? text.slice(0, seps[0]) : text;
  return cut.trim();
};

/** Prefixes that hide the real command name: `VAR=val` assignments and a
 * tiny, decades-stable wrapper list (sudo/env/nohup/time/command) — NOT a
 * growing per-CLI taxonomy. They are skipped only to find the name; the
 * entry keeps them (see findTopLevelInvocations). */
const WRAPPERS = new Set(["sudo", "env", "nohup", "time", "command"]);
const WRAPPER_VALUE_FLAGS: Record<string, RegExp> = {
  sudo: /^-[ugpCDRT]$/, // -u user -g group -p prompt -C fd -D dir -R? -T
  env: /^-[uS]$/, // -u name, -S split-string
};

/** Next token from pos on the same line: a newline is a separator, so a
 * lone `VAR=x` line must not borrow the command on the next one. */
const tokenAt = (cmd: string, pos: number): [string, number] => {
  while (pos < cmd.length && (cmd[pos] === " " || cmd[pos] === "\t")) pos++;
  const t = cmd.slice(pos).match(/^\S+/)?.[0] ?? "";
  return [t, pos];
};

/** Skip VAR=val prefixes and wrapper-command invocations starting at pos;
 * returns the position where the real command begins. */
const skipToCommand = (cmd: string, pos: number): number => {
  for (;;) {
    const [tok, at] = tokenAt(cmd, pos);
    if (!tok) return at;
    if (/^[A-Za-z_]\w*=/.test(tok)) {
      pos = at + tok.length;
      continue;
    }
    if (!WRAPPERS.has(tok)) return at;
    pos = at + tok.length;
    for (;;) {
      const [flag, fat] = tokenAt(cmd, pos);
      if (!flag.startsWith("-")) break;
      pos = fat + flag.length;
      if (WRAPPER_VALUE_FLAGS[tok]?.test(flag)) {
        const [value, vat] = tokenAt(cmd, pos); // consume the flag's value
        pos = vat + value.length;
      }
    }
  }
};

/** Positions where an invocation of `name` begins: position 0 or right
 * after an UNQUOTED separator, so `echo "a; docker restart"` is not an
 * invocation. Requires whitespace (or end of string) right after `name`, so
 * `ssh-keygen`/`docker-compose` don't match `ssh`/`docker`. Returns the
 * START of the segment (before any VAR=/wrapper prefixes), not the name
 * itself, so the recorded entry stays faithful to what actually ran
 * (`sudo -u root kubectl get pods` is recorded whole). */
const findTopLevelInvocations = (cmd: string, name: string): number[] => {
  const bounds = [0, ...unquotedSeparators(cmd).map((i) => i + 1)];
  const starts: number[] = [];
  for (const bound of bounds) {
    const pos = skipToCommand(cmd, bound);
    if (!cmd.startsWith(name, pos)) continue;
    const after = cmd[pos + name.length];
    if (after === undefined || /\s/.test(after)) starts.push(bound);
  }
  return starts;
};

/** ssh flags that take NO argument; every other leading `-flag` consumes
 * the next token. Without this, `ssh -T host 'cmd'` misreads `host` as
 * -T's value and the remote command is never found. Clusters (`-tt`, `-NT`)
 * count as boolean when every letter is one. */
const SSH_BOOL_FLAG = /^-[46ACfGgKkMNTtVvXxYynaq]+$/;

/** Locate the SSH target by TOKEN POSITION (via matchAll's own `.index`,
 * never a substring re-search, which would misfire on e.g.
 * `ssh -i key-prod prod ...` finding "prod" inside "key-prod") and return
 * everything after it, trimmed. */
const sshRemoteCommand = (afterSsh: string): string | undefined => {
  const tokens = [...afterSsh.matchAll(/\S+/g)];
  let i = 0;
  while (i < tokens.length && tokens[i][0].startsWith("-")) {
    i += SSH_BOOL_FLAG.test(tokens[i][0]) ? 1 : 2;
  }
  const target = tokens[i];
  if (!target) return undefined;
  const rest = afterSsh.slice((target.index as number) + target[0].length).trim();
  return rest || undefined;
};

export interface TrackedCommandActivity {
  /** Command name (as configured in settings.trackCommands) -> entries seen. */
  byCommand: Map<string, Set<string>>;
}

/**
 * Scans bash tool-call commands for invocations of any command name in
 * `trackCommands`, capturing a one-line snapshot per match --
 * deliberately shallow (no per-command argument parsing) so this never
 * needs updating as any given CLI's flags evolve, unlike a design that
 * tries to extract structured fields (e.g. "the kubectl namespace" or "the
 * docker container name") for each tool separately.
 *
 * When "ssh" is one of the tracked names, also scans inside its own
 * remote-command argument (quoted or not) for other tracked names --
 * running a command over SSH is as common as running it locally, and a
 * top-level-only scan would otherwise miss it.
 *
 * Only matches literal command text, never tool_result output.
 */
export const extractTrackedCommands = (
  blocks: NormalizedBlock[],
  trackCommands: readonly string[],
): TrackedCommandActivity => {
  const byCommand = new Map<string, Set<string>>();
  if (trackCommands.length === 0) return { byCommand };
  for (const name of trackCommands) byCommand.set(name, new Set());

  const trackSsh = trackCommands.includes("ssh");

  for (const b of blocks) {
    if (b.kind !== "tool_call" || b.name !== "bash") continue;
    const cmd = typeof b.args.command === "string" ? b.args.command : "";
    if (!cmd) continue;

    for (const name of trackCommands) {
      for (const startAt of findTopLevelInvocations(cmd, name)) {
        const item = captureEntry(cmd.slice(startAt).trim());
        if (!item) continue;
        const set = byCommand.get(name) as Set<string>;
        // re-running the same command refreshes it to the tail — the cap
        // then keeps the N most-recently-USED, not first-seen.
        if (set.has(item)) set.delete(item);
        set.add(item);
      }
    }

    if (trackSsh) {
      for (const bound of findTopLevelInvocations(cmd, "ssh")) {
        // bounds are segment starts (incl. wrappers); the ssh token itself
        // sits at skipToCommand — slice past it for the remote parser.
        const seg = cmd.slice(bound);
        const remote = sshRemoteCommand(seg.slice(skipToCommand(seg, 0) + 3));
        if (!remote) continue;
        // The remote string's quotes were the LOCAL shell's syntax, not
        // the remote command's — a leftover stray ' would open a phantom
        // quote in the rescanner and swallow the rest of the line. Strip
        // them all; boundary detection stays shallow regardless.
        const unquoted = remote.replace(/['"]/g, "");
        for (const name of trackCommands) {
          if (name === "ssh") continue;
          for (const startAt2 of findTopLevelInvocations(unquoted, name)) {
            const item = captureEntry(unquoted.slice(startAt2).trim());
            if (!item) continue;
            const set = byCommand.get(name) as Set<string>;
            if (set.has(item)) set.delete(item);
            set.add(item);
          }
        }
      }
    }
  }

  return { byCommand };
};

/** Line format of `[Tracked Commands]`, shared with the merge in
 * core/summarize.ts: `- <name>: <entry> | <entry> ...`, newest
 * COMMANDS_PER_NAME kept. " | " rather than "," since an entry (e.g.
 * `kubectl get pods,svc`) can legitimately contain a comma. */
export const COMMAND_SEPARATOR = " | ";
export const COMMANDS_PER_NAME = 10;

/** Render form: one line (a quoted multi-line argument such as
 * `python3 -c '...'` would otherwise break the line format), with an inner
 * separator escaped as ` \| ` so the merge, which splits on
 * COMMAND_SEPARATOR, keeps the entry whole. Then truncated. */
const renderEntry = (entry: string): string => {
  const line = entry.replace(/\s+/g, " ").replaceAll(COMMAND_SEPARATOR, " \\| ");
  return line.length > MAX_ENTRY_CHARS ? `${line.slice(0, MAX_ENTRY_CHARS)}…` : line;
};

/** Formats TrackedCommandActivity into `[Tracked Commands]` body lines, one per
 * tracked command name that had at least one match. Keeps the NEWEST
 * entries: a ledger of what was run recently must not freeze at its first
 * ten while everything later drowns in a permanent "(+N more)". */
export const formatTrackedCommands = (act: TrackedCommandActivity): string[] => {
  const lines: string[] = [];
  for (const [name, entries] of act.byCommand) {
    if (entries.size > 0) {
      lines.push(`${name}: ${capItems([...entries].map(renderEntry), COMMANDS_PER_NAME, COMMAND_SEPARATOR)}`);
    }
  }
  return lines;
};

/**
 * Join a categorized line's items (oldest first), keeping the newest `limit`
 * behind a leading "(+N earlier)". Keeping the oldest instead froze a merged
 * list on its first entries. stripCapMarker is its inverse, used when a merge
 * re-reads the line.
 */
export const capItems = (items: readonly string[], limit: number, joinWith: string): string => {
  if (items.length <= limit) return items.join(joinWith);
  return `(+${items.length - limit} earlier) ${items.slice(-limit).join(joinWith)}`;
};
