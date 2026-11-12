import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Policy } from "./policy.ts";
import { SECRET_REASON, secretRule } from "./secrets.ts";
import { braces, type Cmd, ParseError, parse, type Word } from "./shell.ts";

export type Intent = "hard_stop" | "use_alternative" | "scope_down" | "manual_only" | "stop_and_explain";
type Cap = "fail_closed" | "paranoid_rm" | "paranoid_interpreters";

/** A denial: the rule, why, and the command segment that tripped it. */
export interface Hit {
  id: string;
  reason: string;
  segment?: string;
}

/** The built-in destructive-command rules: intent, the capability that turns one on, and `hard` (catastrophic: always on). */
export const CATALOG: Record<string, { intent: Intent; cap?: Cap; hard?: true }> = {
  "git.ssh-env": { intent: "manual_only" },
  "git.alias-config": { intent: "manual_only" },
  "git.checkout-force": { intent: "use_alternative" },
  "git.checkout-double-dash": { intent: "use_alternative" },
  "git.checkout-ref-path": { intent: "use_alternative" },
  "git.checkout-pathspec-from-file": { intent: "use_alternative" },
  "git.checkout-ambiguous": { intent: "use_alternative" },
  "git.switch-discard-changes": { intent: "use_alternative" },
  "git.switch-force": { intent: "use_alternative" },
  "git.restore-worktree": { intent: "use_alternative" },
  "git.restore-unstaged": { intent: "use_alternative" },
  "git.reset-hard": { intent: "use_alternative" },
  "git.reset-merge": { intent: "use_alternative" },
  "git.clean-force": { intent: "use_alternative" },
  "git.rm-force": { intent: "use_alternative" },
  "git.push-force": { intent: "use_alternative" },
  "git.push-delete": { intent: "manual_only" },
  "git.push-mirror": { intent: "manual_only" },
  "git.branch-force-delete": { intent: "use_alternative" },
  "git.rebase-abort": { intent: "use_alternative" },
  "git.merge-abort": { intent: "use_alternative" },
  "git.tag-delete": { intent: "manual_only" },
  "git.reflog-delete": { intent: "manual_only" },
  "git.stash-drop": { intent: "use_alternative" },
  "git.stash-clear": { intent: "manual_only" },
  "git.worktree-remove-force": { intent: "use_alternative" },
  "rm.recursive-force-root-or-home": { intent: "hard_stop", hard: true },
  "rm.git-metadata": { intent: "hard_stop", hard: true },
  "rm.recursive-force-dynamic-target": { intent: "scope_down", cap: "fail_closed" },
  "rm.recursive-force-home-cwd": { intent: "scope_down" },
  "rm.recursive-force-cwd-self": { intent: "scope_down" },
  "rm.recursive-force-outside-cwd": { intent: "scope_down" },
  "rm.recursive-force-paranoid": { intent: "scope_down", cap: "paranoid_rm" },
  "powershell.remove-item-root-or-home": { intent: "hard_stop", hard: true },
  "powershell.remove-item-recursive-force-root-or-home": { intent: "hard_stop", hard: true },
  "powershell.remove-item-git-metadata": { intent: "hard_stop", hard: true },
  "powershell.remove-item-recursive-force-dynamic-target": { intent: "scope_down", cap: "fail_closed" },
  "powershell.remove-item-recursive-force-home-cwd": { intent: "scope_down" },
  "powershell.remove-item-recursive-force-cwd-self": { intent: "scope_down" },
  "powershell.remove-item-recursive-force-outside-cwd": { intent: "scope_down" },
  "powershell.remove-item-recursive-force-paranoid": { intent: "scope_down", cap: "paranoid_rm" },
  "powershell.remove-item-pipeline-dynamic-target": { intent: "scope_down", cap: "fail_closed" },
  "powershell.nested-recursive-delete-unread": { intent: "hard_stop", hard: true },
  "cmd.recursive-delete-root-or-home": { intent: "hard_stop", hard: true },
  "cmd.recursive-delete-git-metadata": { intent: "hard_stop", hard: true },
  "cmd.recursive-delete-escaped-quote": { intent: "hard_stop", hard: true },
  "cmd.recursive-delete-dynamic-target": { intent: "scope_down", cap: "fail_closed" },
  "cmd.recursive-delete-home-cwd": { intent: "scope_down" },
  "cmd.recursive-delete-cwd-self": { intent: "scope_down" },
  "cmd.recursive-delete-outside-cwd": { intent: "scope_down" },
  "cmd.recursive-delete-paranoid": { intent: "scope_down", cap: "paranoid_rm" },
  "find.delete": { intent: "scope_down" },
  "find.delete-git-metadata": { intent: "hard_stop", hard: true },
  "find.exec-rm-recursive-force": { intent: "scope_down" },
  "rsync.delete": { intent: "scope_down" },
  "dd.device-write": { intent: "manual_only" },
  "mkfs.device": { intent: "manual_only" },
  "disk.erase": { intent: "manual_only" },
  "shred.target": { intent: "use_alternative" },
  "redirect.block-device": { intent: "manual_only" },
  "network.cloud-metadata": { intent: "manual_only" },
  "network.upload-remote": { intent: "manual_only", cap: "fail_closed" },
  "unshare.user-namespace": { intent: "manual_only" },
  "interpreter.dangerous-command": { intent: "use_alternative" },
  "interpreter.one-liner-paranoid": { intent: "use_alternative", cap: "paranoid_interpreters" },
  "awk.system-dynamic": { intent: "stop_and_explain" },
  "xargs.rm-recursive-force-dynamic": { intent: "scope_down" },
  "xargs.shell-dynamic": { intent: "scope_down" },
  "parallel.rm-recursive-force-dynamic": { intent: "scope_down" },
  "parallel.shell-dynamic": { intent: "scope_down" },
  "parallel.command-stream-dynamic": { intent: "scope_down" },
  "shell.dynamic-structure": { intent: "stop_and_explain", cap: "fail_closed" },
  "shell.dynamic-executable": { intent: "manual_only", cap: "fail_closed" },
  "raw-text.dangerous-command": { intent: "stop_and_explain" },
};

/** Intents of the rules outside the catalog (always on). */
export const OTHER_INTENTS: Record<string, Intent> = {
  "guard.policy-config": "hard_stop",
  "guard.policy-apply": "hard_stop",
  "guard.git-metadata": "hard_stop",
  "analysis.unconfined-code": "manual_only",
  "analysis.dynamic-shell-source": "stop_and_explain",
  "analysis.unsupported-heredoc": "stop_and_explain",
  "analysis.strict-unparseable": "stop_and_explain",
  "analysis.recursion-limit": "stop_and_explain",
  "analysis.limit": "stop_and_explain",
};

const R = {
  gitMeta: "Git metadata and hooks are protected. Ask the user before modifying them.",
  policyConfig: "This path contains the protected policy config and you must not modify or delete it.",
  policyApply:
    "Only the user may apply a policy proposal, because it rewrites the configuration CC Safety Net enforces. Ask them to run `cc-safety-net policy apply <file>` themselves in a terminal; you can run `cc-safety-net policy check <file>` to show them what it would change.",
  dynamicSource:
    "shell execution source cannot be verified safely. Use a literal command string or ask the user to run it manually.",
  heredoc: "Unquoted heredoc input is not supported safely. Quote the delimiter or ask the user to verify.",
  strict:
    "Command could not be safely analyzed (strict mode). Simplify the command and retry, or ask the user to verify.",
  recursion: "Command exceeds maximum recursion depth and cannot be safely analyzed. Flatten the nesting and retry.",
  limit:
    "CC Safety Net could not analyze the command because it exceeds safe analysis limits. Simplify or split the command and retry.",
  interp:
    "Interpreter code contains a dangerous command. Run the underlying command directly so it can be analyzed, or use the safer alternative for that command.",
  oneLiner:
    "Interpreter one-liners are blocked by the active safety policy. Write the code to a script file and run it, or run the equivalent shell command directly.",
  awk: "Detected awk system(), pipe, or getline command with dynamic command that cannot be safely analyzed. Use a literal command or process the data without system(), pipes, or getline.",
  metadata:
    "This reaches a cloud metadata endpoint, which hands out instance credentials. Ask the user to run metadata requests manually if they are needed.",
  upload:
    "This uploads data to a remote host, which can send local files or secrets off the machine. Send it to localhost instead, or ask the user to run the upload manually if it is needed.",
  dynExe:
    "dynamic command name contains shell substitution output and cannot be verified safely. Use a literal executable name.",
  dynStruct:
    "shell substitution output can change guarded command structure and cannot be verified safely. Use literal subcommands and options.",
  shred:
    "shred permanently destroys the given target. Use rm for ordinary deletes, or ask the user to run shred manually.",
  unshare:
    "unshare creating a user namespace grants root inside it, a common step toward privilege escalation. Ask the user to run it manually if it is needed.",
  dd: "dd writing to a /dev device can destroy a disk or partition. Ask the user to run device writes manually after confirming the target.",
  mkfs: "mkfs formatting a /dev device erases everything on it. Ask the user to run the format manually after confirming the target.",
  disk: "This erases or repartitions a disk. Ask the user to run disk erase and partition commands manually after confirming the target.",
  device:
    "This output redirect overwrites a disk device. Ask the user to run device writes manually after confirming the target.",
  findDelete: "find -delete permanently removes files. Use -print first to preview.",
  findExecRm: "find -exec rm -rf is dangerous. Use explicit file list instead.",
  xargsRm: "xargs rm -rf with dynamic input is dangerous. Use explicit file list instead.",
  xargsShell:
    "xargs dynamic input can supply arbitrary executable command source. Use an explicit child command and arguments instead.",
  parallelRm: "parallel rm -rf with dynamic input is dangerous. Use explicit file list instead.",
  parallelShell:
    "parallel with shell -c can execute arbitrary commands from dynamic input. Run the inner command directly on an explicit file list instead.",
  rsync:
    "rsync --delete permanently removes destination files missing from the source. Mirror only into explicit paths inside the current directory or under /tmp, /var/tmp, or $TMPDIR.",
  rsyncRoot: "rsync --delete targeting root or home directory is extremely dangerous and always blocked.",
  sshEnv:
    "Git SSH environment overrides can execute arbitrary commands during network operations. Run git without GIT_SSH/GIT_SSH_COMMAND overrides, or ask the user to run it manually.",
  alias:
    "Git aliases supplied through command-line or environment config can hide or execute commands. Run git without Git alias overrides, or ask the user to run it manually.",
  pwshUnread:
    "Recursive delete handed to powershell or pwsh in a form CC Safety Net does not read is blocked: pass the script as a single -Command with literal paths, after only -NoProfile, -NonInteractive, -NoLogo, or -ExecutionPolicy.",
  cmdQuote:
    'cmd rmdir /s or del /s with \\" quoting or a \\\\?\\ path is blocked: cmd does not treat \\" as an escape, so the target can split down to the root of the drive. Pass each path as its own quoted argument, or use Remove-Item -LiteralPath.',
};

const GIT: Record<string, string> = {
  "git.checkout-force": "git checkout --force discards uncommitted changes. Use 'git stash' first.",
  "git.checkout-double-dash": "git checkout -- discards uncommitted changes permanently. Use 'git stash' first.",
  "git.checkout-path":
    "git checkout <path> discards uncommitted changes permanently. Use 'git stash' first, or 'git switch' to change branches.",
  "git.checkout-ref-path":
    "git checkout <ref> -- <path> overwrites working tree with ref version. Use 'git stash' first.",
  "git.checkout-pathspec-from-file":
    "git checkout --pathspec-from-file can overwrite multiple files. Use 'git stash' first.",
  "git.checkout-ambiguous":
    "git checkout with multiple positional args may overwrite files. Use 'git switch' for branches or 'git restore' for files.",
  "git.switch-discard-changes": "git switch --discard-changes discards uncommitted changes. Use 'git stash' first.",
  "git.switch-force": "git switch --force discards uncommitted changes. Use 'git stash' first.",
  "git.restore-worktree": "git restore --worktree explicitly discards working tree changes. Use 'git stash' first.",
  "git.restore-unstaged":
    "git restore discards uncommitted changes. Use 'git stash' first, or use --staged to only unstage.",
  "git.reset-hard": "git reset --hard destroys all uncommitted changes permanently. Use 'git stash' first.",
  "git.reset-merge": "git reset --merge can lose uncommitted changes. Use 'git stash' first.",
  "git.clean-force": "git clean -f removes untracked files permanently. Use 'git clean -n' to preview first.",
  "git.rm-force":
    "git rm --force removes tracked files from the working tree. Use 'git rm --cached' to keep the files, or 'git rm --dry-run' to preview first.",
  "git.push-force": "git push --force destroys remote history. Use --force-with-lease for safer force push.",
  "git.push-delete": "git push deletes remote refs. Ask the user to run it manually if deletion is intended.",
  "git.push-mirror":
    "git push --mirror can force-update and delete remote refs. Ask the user to run it manually if mirror push is intended.",
  "git.branch-force-delete": "git branch -D force-deletes without merge check. Use -d for safe delete.",
  "git.rebase-abort": "git rebase --abort discards rebase conflict resolutions. Use 'git status' first.",
  "git.merge-abort": "git merge --abort discards merge conflict resolutions. Use 'git status' first.",
  "git.tag-delete": "git tag -d permanently deletes tags. Ask the user to run it manually if deletion is intended.",
  "git.reflog-delete":
    "git reflog delete removes recovery history. Ask the user to run it manually if deletion is intended.",
  "git.stash-drop": "git stash drop permanently deletes stashed changes. Consider 'git stash list' first.",
  "git.stash-clear":
    "git stash clear deletes ALL stashed changes permanently. Use 'git stash list' to review; ask the user to run it manually if intended.",
  "git.worktree-remove-force": "git worktree remove --force can delete uncommitted changes. Remove --force flag.",
};

/** rm / Remove-Item / cmd reasons per target kind */
const DEL_REASONS: Record<"rm" | "powershell" | "cmd", Record<string, string>> = {
  rm: {
    root: "rm -rf targeting root or home directory is extremely dangerous and always blocked.",
    dynamic:
      "rm -rf target contains shell variables that cannot be verified safely. Use literal paths within cwd, /tmp, /var/tmp, or $TMPDIR.",
    home: "rm -rf in home directory is dangerous. Change to a project directory first.",
    outside:
      "rm -rf outside cwd is blocked. Retry deleting only explicit paths inside the current directory; escalate for anything outside it.",
    paranoid:
      "rm -rf for non-temporary paths is blocked by the active safety policy. Retry deleting only explicit paths inside the current directory; escalate for anything outside it.",
  },
  powershell: {
    root: "PowerShell Remove-Item targeting root or home directory is extremely dangerous and always blocked.",
    dynamic:
      "PowerShell Remove-Item target contains variables or pipeline input that cannot be verified safely. Use literal paths within cwd.",
    home: "PowerShell Remove-Item -Recurse -Force in home directory is dangerous. Change to a project directory first.",
    outside:
      "PowerShell Remove-Item -Recurse -Force outside cwd is blocked. Retry deleting only explicit paths inside the current directory; escalate for anything outside it.",
    paranoid:
      "PowerShell Remove-Item -Recurse -Force for non-temporary paths is blocked by the active safety policy. Retry deleting only explicit paths inside the current directory; escalate for anything outside it.",
    pipeline:
      "PowerShell Remove-Item receives pipeline input that cannot be verified safely. Use explicit literal paths within cwd.",
  },
  cmd: {
    root: "cmd rmdir /s or del /s targeting root or home directory is extremely dangerous and always blocked.",
    dynamic:
      "cmd rmdir /s or del /s target contains wildcards or variables that cannot be verified safely. Use literal paths within cwd.",
    home: "cmd rmdir /s or del /s in home directory is dangerous. Change to a project directory first.",
    outside:
      "cmd rmdir /s or del /s outside cwd is blocked. Retry deleting only explicit paths inside the current directory; escalate for anything outside it.",
    paranoid:
      "cmd rmdir /s or del /s for non-temporary paths is blocked by the active safety policy. Retry deleting only explicit paths inside the current directory; escalate for anything outside it.",
  },
};

const MAX_DEPTH = 10;
const MAX_INPUT = 100_000;
const METADATA_HOSTS = [
  "169.254.169.254",
  "fd00:ec2::254",
  "169.254.170.2",
  "169.254.170.23",
  "fd00:ec2::23",
  "metadata.google.internal",
  "metadata.goog",
  "100.100.100.200",
];
const NETWORK = new Set([
  "curl",
  "wget",
  "aria2c",
  "http",
  "https",
  "xh",
  "xhs",
  "httpie",
  "fetch",
  "lwp-request",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "telnet",
]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "ash", "fish", "busybox-sh"]);
/** commands that write or delete the paths they're given (for the policy and git-metadata guards) */
const MUTATORS = new Set([
  "mv",
  "cp",
  "install",
  "ln",
  "tee",
  "truncate",
  "touch",
  "chmod",
  "chown",
  "chgrp",
  "sed",
  "perl",
  "patch",
  "rsync",
  "rm",
  "rmdir",
  "unlink",
  "shred",
]);
/** whose arguments are text, not paths */
const DATA_ARGS = new Set(["echo", "printf", "true", ":", "export", "alias", "test", "["]);
/** guarded heads whose structure substitution output may change (strict) */
const GUARDED = new Set(["git", "rm", "find", "xargs", "parallel", "rsync", "dd", "shred", "mkfs", "chmod", "chown"]);

/** What one analysis carries. */
export interface State {
  policy: Policy;
  /** the session's cwd: where deletes are allowed */
  anchor: string;
  /** where the command runs now (`cd` changes it; null once unknown) */
  cwd: string | null;
  depth: number;
  /** variables exported earlier in the script, and the running process's */
  env: Record<string, string>;
}

/** Whether `id` is enforced under `p`; returns the hit, or null when it's off. */
export function gate(p: Policy, id: string, reason: string, segment?: string): Hit | null {
  const meta = CATALOG[id];
  const hit = { id, reason, ...(segment !== undefined && { segment }) };
  if (!meta || meta.hard) return hit;
  if (!p.destructive.enabled) return null;
  const o = p.destructive.overrides[id];
  if (o) return o === "on" ? hit : null;
  if (meta.cap === "fail_closed" && !p.failClosed) return null;
  if (meta.cap === "paranoid_rm" && !p.paranoidRm) return null;
  if (meta.cap === "paranoid_interpreters" && !p.paranoidInterpreters) return null;
  return hit;
}

const base = (s: string) => (s.split(/[\\/]/).pop() ?? s).replace(/\.exe$/i, "").toLowerCase();
const within = (p: string, dir: string) => p === dir || p.startsWith(dir === "/" ? "/" : `${dir}/`);
const temps = (env: Record<string, string>) =>
  [...new Set([tmpdir(), "/tmp", "/var/tmp", "/private/tmp", env.TMPDIR].filter((t): t is string => !!t))].map((t) =>
    resolve(t),
  );

/** `~`, `$HOME`, `$TMPDIR`, `$PWD` expanded; undefined when anything else dynamic is left */
function expand(w: Pick<Word, "text" | "raw">, st: State): string | undefined {
  let t = w.text;
  if (w.raw.startsWith("~")) t = t.replace(/^~(?=\/|$)/, homedir());
  t = t
    .replace(/\$\{?HOME\}?(?![A-Za-z0-9_])/g, homedir())
    .replace(/\$\{?TMPDIR\}?(?![A-Za-z0-9_])/g, st.env.TMPDIR ?? tmpdir())
    .replace(/\$\{?PWD\}?(?![A-Za-z0-9_])/g, st.cwd ?? "$PWD");
  return /\$|`/.test(t) ? undefined : t;
}

function abs(path: string, st: State): string | undefined {
  const p = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(p)) return p;
  if (isAbsolute(p)) return resolve(p);
  return st.cwd === null ? undefined : resolve(st.cwd, p);
}

const literal = (text: string): Word => ({ text, raw: text, quoted: false, dynamic: false, subst: false, glob: false });

/** a `.git` metadata path (not a throwaway repo under a temp root) */
function gitMeta(a: string, st: State): boolean {
  if (temps(st.env).some((t) => within(a, t)) && !within(a, st.anchor)) return false;
  const segs = a.split("/");
  return segs.some((s) => s === ".git" || ((s.includes("*") || s.includes("?") || s.includes("[")) && glob(s, ".git")));
}

function glob(pattern: string, name: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
    .replace(/\[!/g, "[^");
  try {
    return new RegExp(`^${re}$`).test(name);
  } catch {
    return false;
  }
}

type Kind = "root" | "git" | "temp" | "dynamic" | "home" | "self" | "within" | "outside";

/** Where a recursive delete's target lands. */
function classify(text: string | undefined, st: State, dialect: "posix" | "windows" = "posix"): Kind {
  const home = homedir();
  const cwdIsHome = [st.anchor, st.cwd].some((c) => c !== null && resolve(c) === home);
  if (text === undefined) return cwdIsHome ? "home" : "dynamic";
  const t = text.trim();
  const slash = t.replace(/\\/g, "/");
  if (/^\/(\*+\/?)*$/.test(slash) || /^[A-Za-z]:\/*\*?$/.test(slash) || /^\/\/[^/]+\/+[^/]+(\/+\*?)?$/.test(slash))
    return "root";
  if (dialect === "windows" && /^\/\*?$/.test(slash)) return "root";
  const a = abs(t === "*" ? "." : slash.endsWith("/*") ? slash.slice(0, -2) || "/" : slash, st);
  if (a === undefined) return "outside";
  if (a === "/" || a === home) return "root";
  if (gitMeta(abs(slash, st) ?? a, st)) return "git";
  if (st.policy.destructive.allowPaths.some((p) => within(a, abs(p.replace(/^~(?=\/|$)/, home), st) ?? "/nonexistent")))
    return "temp";
  const tmp = temps(st.env);
  if (tmp.some((d) => a !== d && within(a, d))) return "temp";
  if (cwdIsHome) return "home";
  if (a === st.cwd || a === st.anchor) return "self";
  if (within(a, st.anchor)) return "within";
  return "outside";
}

const KIND_ID: Record<Kind, string | undefined> = {
  root: "recursive-force-root-or-home",
  git: "git-metadata",
  dynamic: "recursive-force-dynamic-target",
  home: "recursive-force-home-cwd",
  self: "recursive-force-cwd-self",
  within: "recursive-force-paranoid",
  outside: "recursive-force-outside-cwd",
  temp: undefined,
};
const KIND_REASON: Record<Kind, string> = {
  root: "root",
  git: "git",
  dynamic: "dynamic",
  home: "home",
  self: "outside",
  within: "paranoid",
  outside: "outside",
  temp: "",
};

/** the hit for a recursive delete of `kind` in `family`'s rule ids */
function deleteHit(family: "rm" | "powershell" | "cmd", kind: Kind, st: State, seg: string): Hit | null {
  let suffix = KIND_ID[kind];
  if (!suffix) return null;
  if (family === "powershell") suffix = kind === "git" ? "remove-item-git-metadata" : `remove-item-${suffix}`;
  if (family === "cmd")
    suffix = kind === "git" ? "recursive-delete-git-metadata" : suffix.replace("recursive-force", "recursive-delete");
  const id = `${family}.${suffix}`;
  const reason = kind === "git" ? R.gitMeta : (DEL_REASONS[family][KIND_REASON[kind]] ?? "");
  return gate(st.policy, id, reason, seg);
}

const seg = (words: Word[]) => words.map((w) => w.raw || w.text).join(" ");

/** short flags set across `-abc` args (before `--`) */
function shorts(args: string[]): Set<string> {
  const out = new Set<string>();
  for (const a of args) {
    if (a === "--") break;
    if (/^-[A-Za-z]/.test(a)) for (const c of a.slice(1)) out.add(c);
  }
  return out;
}
/** a `--name` (or an unambiguous prefix of at least `min` chars, or `--name=…`) before `--` */
function long(args: string[], name: string, min = name.length): boolean {
  for (const a of args) {
    if (a === "--") return false;
    if (!a.startsWith("--")) continue;
    const n = a.slice(2).split("=")[0] ?? "";
    if (n.length >= min && name.startsWith(n)) return true;
  }
  return false;
}
const positionals = (args: string[]) => {
  const out: string[] = [];
  let rest = false;
  for (const a of args) {
    if (rest) out.push(a);
    else if (a === "--") rest = true;
    else if (!a.startsWith("-")) out.push(a);
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------
// raw text (when the command can't be parsed)

/** destructive patterns in text that couldn't be parsed */
export function rawScan(text: string): Hit | null {
  const lower = text.toLowerCase();
  const echoish = /^\s*(echo|rg)\s/.test(lower);
  const checks: [RegExp, string, boolean?][] = [
    [
      /\brm\s+(?:\S+\s+)*?(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\b[^\n;|&]*--force|--force\b[^\n;|&]*--recursive|-[a-z]*r\b[^\n;|&]*-[a-z]*f|-[a-z]*f\b[^\n;|&]*-[a-z]*r)/,
      "rm -rf",
    ],
    [/\bgit\s+(?:\S+\s+)*?reset\s+(?:\S+\s+)*?--hard\b/, "git reset --hard"],
    [/\bgit\s+(?:\S+\s+)*?reset\s+(?:\S+\s+)*?--merge\b/, "git reset --merge"],
    [/\bgit\s+(?:\S+\s+)*?clean\s+(?:\S+\s+)*?(?:-[a-z]*f|--force)/, "git clean -f"],
    [/\bgit\s+(?:\S+\s+)*?checkout\s+(?:\S+\s+)*?(?:-f\b|--force)/, "git checkout --force"],
    [/\bgit\s+(?:\S+\s+)*?push\s+(?:\S+\s+)*?(?:-f\b|--force(?!-with-lease|-if-includes))/, "git push --force"],
    [/\bgit\s+(?:\S+\s+)*?push\s+(?:\S+\s+)+\+\S/, "git push --force"],
    [/\bgit\s+(?:\S+\s+)*?push\s+(?:\S+\s+)*?(?:--delete\b|-d\b|:\S)/, "git push delete"],
    [/\bgit\s+(?:\S+\s+)*?branch\s+(?:\S+\s+)*?-D\b/, "git branch -D", true],
    [/\bgit\s+(?:\S+\s+)*?tag\s+(?:\S+\s+)*?(?:-d\b|--delete)/, "git tag -d"],
    [/\bgit\s+stash\s+(drop|clear)\b/, "git stash drop/clear"],
    [/\bgit\s+checkout\s+--\s/, "git checkout --"],
    [/\bgit\s+restore\b(?![^\n;|&]*--(staged|help))/, "git restore without --staged"],
  ];
  const noEcho: [RegExp, string][] = [
    [/\bfind\b[^\n;|&]*\s-delete\b/, "find -delete"],
    [/\bdd\b[^\n|;&]*\bof=\/dev\/\S/, "dd of=/dev/"],
    [/\bmkfs(?:\.[a-z0-9_-]+)?\s+\/dev\/\S/, "mkfs /dev/"],
    [/\bshred\b\s+\S/, "shred"],
    [
      /\b(?:curl|wget|fetch|aria2c|https?|xhs?|ncat|netcat|nc)\b(?:[^\n|;&]|\\\n)*\|(?:\s|\\\n)*(?:(?:sudo|env|command|builtin)(?:\s+(?:-\S+|\w+=\S*))*\s+)?(?:[^\s|;&]*\/)?(?:ba|da|z|k)?sh(?![^\s;&|])/,
      "download piped to shell",
    ],
  ];
  for (const [re, label, cased] of checks)
    if (re.test(cased ? text : lower))
      return {
        id: "raw-text.dangerous-command",
        reason: `Unparseable command text contains a destructive pattern (${label}). Rewrite as a plain, parseable command so it can be analyzed.`,
      };
  if (!echoish)
    for (const [re, label] of noEcho)
      if (re.test(lower))
        return {
          id: "raw-text.dangerous-command",
          reason: `Unparseable command text contains a destructive pattern (${label}). Rewrite as a plain, parseable command so it can be analyzed.`,
        };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// POSIX shell

/** Analyzes a shell command line. */
export function analyzeShell(src: string, st: State): Hit | null {
  if (st.depth > MAX_DEPTH) return { id: "analysis.recursion-limit", reason: R.recursion };
  if (src.length > MAX_INPUT) return { id: "analysis.limit", reason: R.limit };
  let script: ReturnType<typeof parse>;
  try {
    script = parse(src);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    const raw = rawScan(src);
    if (raw) return raw;
    return st.policy.failClosed ? { id: "analysis.strict-unparseable", reason: R.strict } : null;
  }
  const inner: State = { ...st, env: { ...st.env } };
  for (const s of script.subs) {
    const hit = analyzeShell(s, { ...inner, depth: st.depth + 1 });
    if (hit) return hit;
  }
  for (const cmd of script.cmds) {
    const hit = analyzeCmd(cmd, inner);
    if (hit) return hit;
  }
  return null;
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

function analyzeCmd(cmd: Cmd, st: State): Hit | null {
  const segment = seg(cmd.words);
  // redirections: devices, guarded paths, secrets
  for (const r of cmd.redirs) {
    if (!r.target || r.heredoc) continue;
    if (/^[<>]&$/.test(r.op) && /^(\d+|-)$/.test(r.target.text)) continue;
    const t = expand(r.target, st);
    if (t === undefined) continue;
    const writes = r.op !== "<" && r.op !== "<<<";
    if (writes && /^\/dev\//.test(t) && !/^\/dev\/(null|zero|full|stdout|stderr|tty|fd\/\d+|random|urandom)$/.test(t)) {
      const hit = gate(st.policy, "redirect.block-device", R.device, segment);
      if (hit) return hit;
    }
    const hit = pathGuards(t, writes ? "write" : "read", st, segment);
    if (hit) return hit;
  }
  const words = [...cmd.words];
  const assigns: Record<string, string> = {};
  while (words[0] && ASSIGN.test(words[0].text) && !words[0].raw.startsWith("=")) {
    const m = ASSIGN.exec((words.shift() as Word).text);
    if (m) assigns[m[1] as string] = m[2] ?? "";
  }
  if (!words.length) {
    // `X=1` alone sets it for the rest of the script
    Object.assign(st.env, assigns);
    return null;
  }
  const hit = analyzeWords(words, st, { assigns, cmd, segment });
  if (hit) return hit;
  // cd changes where later commands run
  const head = base(words[0]?.text ?? "");
  if (head === "cd" || head === "pushd" || head === "chdir") {
    const target = words.slice(1).find((w) => !w.text.startsWith("-") || w.text === "-");
    if (!target) st.cwd = homedir();
    else {
      const t = target.text === "-" ? undefined : expand(target, st);
      st.cwd = t === undefined ? null : (abs(t, st) ?? null);
    }
  }
  if (head === "export")
    for (const w of words.slice(1)) {
      const m = ASSIGN.exec(w.text);
      if (m) st.env[m[1] as string] = m[2] ?? "";
    }
  return null;
}

interface Where {
  assigns: Record<string, string>;
  /** the parsed command, for its pipe source and heredocs */
  cmd?: Cmd;
  segment: string;
  /** arguments arrive from elsewhere (xargs, find -exec {}) */
  appended?: boolean;
}

/** writing or deleting `a` touches a policy file: it is one, or a directory holding an existing one */
const touchesPolicy = (a: string, st: State) => st.policy.files.some((f) => f === a || (within(f, a) && existsSync(f)));

/** guards and secrets on one path the command touches */
function pathGuards(t: string, mode: "read" | "write", st: State, segment: string, identity = false): Hit | null {
  const a = abs(t, st);
  if (a === undefined) return null;
  if (mode === "write") {
    if (touchesPolicy(a, st)) return { id: "guard.policy-config", reason: R.policyConfig, segment };
    if (gitMeta(a, st)) return { id: "guard.git-metadata", reason: R.gitMeta, segment };
  }
  const id = secretRule(t, st.cwd ?? st.anchor, st.policy.secret, identity);
  return id ? { id, reason: SECRET_REASON, segment } : null;
}

/** Leading wrappers removed: `sudo`, `env`, `timeout 5`, … Returns the words that run, or a hit for env/shell forms. */
function unwrap(words: Word[], assigns: Record<string, string>): Word[] | null {
  let w = words;
  for (let guard = 0; guard < 20 && w.length; guard++) {
    const head = base(w[0]?.text ?? "");
    const rest = w.slice(1);
    /** options (and the values of those in `withValue`) up to the command */
    const skipOpts = (withValue: Set<string>) => {
      let i = 0;
      while (i < rest.length) {
        const a = rest[i]?.text ?? "";
        if (a === "--") return i + 1;
        if (!a.startsWith("-") || a === "-") break;
        i++;
        if (withValue.has(a)) i++;
      }
      return i;
    };
    if (head === "sudo" || head === "doas") {
      const n = skipOpts(new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "-c"]));
      w = rest.slice(n);
    } else if (head === "env") {
      let i = 0;
      for (; i < rest.length; i++) {
        const a = rest[i]?.text ?? "";
        if (a === "-u" || a === "--unset" || a === "-C" || a === "--chdir") i++;
        else if (a === "-S" || a === "--split-string" || a.startsWith("--split-string=")) {
          const s = a.includes("=") ? a.slice(a.indexOf("=") + 1) : (rest[++i]?.text ?? "");
          return [...s.split(/\s+/).filter(Boolean).map(literal), ...rest.slice(i + 1)];
        } else if (ASSIGN.test(a)) {
          const m = ASSIGN.exec(a);
          if (m) assigns[m[1] as string] = m[2] ?? "";
        } else if (!a.startsWith("-")) break;
      }
      w = rest.slice(i);
    } else if (head === "command" || head === "builtin") {
      if (rest.some((x) => x.text === "-v" || x.text === "-V")) return null;
      w = rest.slice(skipOpts(new Set()));
    } else if (["nohup", "exec", "setsid", "unbuffer", "caffeinate", "time", "stdbuf", "chronic"].includes(head)) {
      w = rest.slice(skipOpts(new Set(["-a"])));
    } else if (head === "nice" || head === "ionice" || head === "chrt") {
      w = rest.slice(skipOpts(new Set(["-n", "-c", "-p", "--adjustment"])));
      if (head === "chrt" && w[0] && /^\d+$/.test(w[0].text)) w = w.slice(1);
    } else if (head === "timeout") {
      const n = skipOpts(new Set(["-s", "-k", "--signal", "--kill-after"]));
      w = rest.slice(n + 1);
    } else if (head === "taskset") {
      // taskset MASK cmd, taskset -c LIST cmd
      w = rest.slice(rest[0]?.text === "-c" || rest[0]?.text === "--cpu-list" ? 2 : 1);
    } else if (head === "busybox" && rest[0] && !rest[0].text.startsWith("-")) {
      w = rest;
    } else return w;
  }
  return w;
}

/** The main dispatcher: one simple command's words (assignments removed). */
function analyzeWords(words0: Word[], st: State, where: Where): Hit | null {
  if (st.depth > MAX_DEPTH) return { id: "analysis.recursion-limit", reason: R.recursion };
  const { segment } = where;
  const assigns = { ...where.assigns };
  const words = unwrap(words0, assigns);
  if (!words?.length) return null;
  const headWord = words[0] as Word;
  const args = words.slice(1);
  const texts = args.map((w) => w.text);
  const p = st.policy;
  if (headWord.subst) return gate(p, "shell.dynamic-executable", R.dynExe, segment);
  const head = base(headWord.text);
  const env = { ...st.env, ...assigns };
  const deeper = { ...st, depth: st.depth + 1 };

  if (headWord.dynamic) {
    // `$SHELL -c …` is a shell; any other variable command is unknown
    if (!/^\$\{?SHELL\}?$/.test(headWord.text)) return null;
  }
  if (GUARDED.has(head) && args.some((a) => a.subst)) {
    const hit = gate(p, "shell.dynamic-structure", R.dynStruct, segment);
    if (hit) return hit;
  }

  // guards: the policy file, git metadata
  if (
    head === "cc-safety-net" ||
    (["npx", "pnpx", "bunx", "pnpm", "yarn", "npm"].includes(head) && texts.some((t) => /^cc-safety-net(@|$)/.test(t)))
  ) {
    const i = texts.findIndex((t) => /^cc-safety-net(@|$)/.test(t));
    const sub = (head === "cc-safety-net" ? texts : texts.slice(i + 1)).filter((t) => !t.startsWith("-"));
    if (sub[0] === "policy" && sub[1] === "apply") return { id: "guard.policy-apply", reason: R.policyApply, segment };
  }
  // a delete's own rules first: `rm -rf /` is about root, not the policy file under it
  if (head === "rm" || head === "rmdir" || head === "unlink") {
    const hit = rmHit(args, st, segment);
    if (hit) return hit;
  }
  if (MUTATORS.has(head)) {
    const inPlace =
      (head !== "sed" && head !== "perl") || texts.some((t) => /^-[a-zA-Z]*i/.test(t) || t.startsWith("--in-place"));
    if (inPlace) {
      let targets = positionals(texts);
      if (["cp", "install", "ln", "rsync"].includes(head)) targets = targets.slice(-1);
      if (head === "sed" || head === "perl") targets = targets.slice(1);
      for (const t of targets) {
        const a = abs(t.replace(/^~(?=\/|$)/, homedir()), st);
        if (!a) continue;
        if (touchesPolicy(a, st)) return { id: "guard.policy-config", reason: R.policyConfig, segment };
        if (!["rm", "rmdir", "unlink"].includes(head) && gitMeta(a, st))
          return { id: "guard.git-metadata", reason: R.gitMeta, segment };
      }
    }
  }
  if (head === "dd") {
    const of = texts.find((t) => t.startsWith("of="))?.slice(3);
    if (of) {
      const a = abs(of, st);
      if (a && touchesPolicy(a, st)) return { id: "guard.policy-config", reason: R.policyConfig, segment };
      if (a && gitMeta(a, st)) return { id: "guard.git-metadata", reason: R.gitMeta, segment };
    }
  }

  // secrets: every path-like argument
  if (!DATA_ARGS.has(head)) {
    for (let i = 0; i < args.length; i++) {
      const w = args[i] as Word;
      const prev = args[i - 1]?.text;
      if (prev === "-m" || prev === "--message" || prev === "-F" || prev === "-e" || prev === "-c") continue;
      const identity =
        ["ssh", "scp", "sftp", "ssh-add", "ssh-keygen"].includes(head) && (prev === "-i" || head === "ssh-add");
      let t = expand(w, st);
      if (t === undefined) continue;
      const eq = /^--?[A-Za-z][\w-]*=(.+)$/.exec(t);
      if (eq) t = eq[1] as string;
      else if (t.startsWith("-")) continue;
      const hit = pathGuards(t, "read", st, segment, identity);
      if (hit?.id.startsWith("secret.")) return hit;
    }
  }

  const hit = builtinRule(head, words, args, texts, st, deeper, env, where);
  if (hit) return hit;
  return customRule(head, texts, p, segment);
}

function customRule(head: string, texts: string[], p: Policy, segment: string): Hit | null {
  for (const r of p.rules) {
    if (base(r.command) !== head) continue;
    const pos = positionals(texts);
    if (r.subcommand && pos[0] !== r.subcommand) continue;
    if (r.commandPath.length && r.commandPath.some((c, i) => pos[i] !== c)) continue;
    const has = (arg: string) =>
      texts.some(
        (t) =>
          t === arg ||
          t.startsWith(`${arg}=`) ||
          (/^-[A-Za-z]$/.test(arg) && /^-[A-Za-z]+$/.test(t) && t.includes(arg[1] as string)),
      );
    if (r.excludeArgs.some(has)) continue;
    if (r.anyArgs.length && !r.anyArgs.some(has)) continue;
    if (r.blockArgs.length && !r.blockArgs.some(has)) continue;
    return { id: r.id, reason: r.reason, segment };
  }
  return null;
}

/** reads a literal script file to analyze; undefined when it can't be read */
function readScript(path: string, st: State): string | undefined {
  const a = abs(path, st);
  if (!a) return;
  try {
    if (statSync(a).size > MAX_INPUT) return;
    return readFileSync(a, "utf8");
  } catch {}
}

/** what a command reads on stdin, when it can be known: a heredoc, an echo, a cat of a file */
function stdinText(where: Where, st: State): { text?: string; hit?: Hit } | undefined {
  const doc = where.cmd?.redirs.find((r) => r.heredoc);
  if (doc?.heredoc) {
    if (!doc.heredoc.quoted && /\$|`/.test(doc.heredoc.body))
      return { hit: { id: "analysis.unsupported-heredoc", reason: R.heredoc, segment: where.segment } };
    return { text: doc.heredoc.body };
  }
  const herestring = where.cmd?.redirs.find((r) => r.op === "<<<");
  if (herestring?.target)
    return herestring.target.dynamic ? { hit: dynamicSource(where) } : { text: herestring.target.text };
  const file = where.cmd?.redirs.find((r) => r.op === "<");
  if (file?.target) {
    const t = expand(file.target, st);
    const text = t === undefined ? undefined : readScript(t, st);
    return text === undefined ? { hit: dynamicSource(where) } : { text };
  }
  const src = where.cmd?.pipedFrom;
  if (!src) return;
  const w = src.words.filter((x) => !ASSIGN.test(x.text));
  const head = base(w[0]?.text ?? "");
  if ((head === "echo" || head === "printf") && w.slice(1).every((x) => !x.dynamic))
    return {
      text: w
        .slice(1)
        .filter((x) => !/^-[neE]+$/.test(x.text))
        .map((x) => x.text)
        .join(" ")
        .replace(/\\n/g, "\n"),
    };
  if (head === "cat" && w.length === 2 && w[1] && !w[1].dynamic) {
    const text = readScript(w[1].text, st);
    if (text !== undefined) return { text };
  }
  return { hit: dynamicSource(where) };
}
const dynamicSource = (where: Where): Hit => ({
  id: "analysis.dynamic-shell-source",
  reason: R.dynamicSource,
  segment: where.segment,
});

const INTERP: [RegExp, string[]][] = [
  [/^(python[0-9.]*|pypy[0-9.]*)$/, ["-c"]],
  [/^(node|nodejs|bun)$/, ["-e", "--eval", "-p", "--print"]],
  [/^perl[0-9.]*$/, ["-e", "-E"]],
  [/^ruby[0-9.]*$/, ["-e"]],
  [/^php[0-9.]*$/, ["-r"]],
  [/^(lua[0-9.]*|luajit)$/, ["-e"]],
  [/^rscript$/, ["-e"]],
];

function builtinRule(
  head: string,
  words: Word[],
  args: Word[],
  texts: string[],
  st: State,
  deeper: State,
  env: Record<string, string>,
  where: Where,
): Hit | null {
  const p = st.policy;
  const { segment } = where;

  // shells
  if (SHELLS.has(head) || /^\$\{?SHELL\}?$/.test(words[0]?.text ?? "") || (head === "busybox" && texts[0] === "sh")) {
    const a = head === "busybox" ? args.slice(1) : args;
    const c = a.findIndex((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.text) && !w.text.startsWith("--"));
    if (c >= 0) {
      const script = a[c + 1];
      if (!script) return null;
      if (script.dynamic && !script.subst) return dynamicSource(where);
      return analyzeShell(script.text, deeper);
    }
    const file = a.find((w) => !w.text.startsWith("-") && !w.text.startsWith("+"));
    if (file) {
      if (file.dynamic) return dynamicSource(where);
      const text = readScript(file.text, st);
      return text === undefined ? null : analyzeShell(text, deeper);
    }
    if (where.appended) return gate(p, "xargs.shell-dynamic", R.xargsShell, segment);
    const input = stdinText(where, st);
    if (input?.hit) return input.hit;
    return input?.text === undefined ? null : analyzeShell(input.text, deeper);
  }
  if (head === "eval") {
    if (args.some((w) => w.dynamic && !w.subst)) return dynamicSource(where);
    return analyzeShell(texts.join(" "), deeper);
  }
  if (head === "source" || head === ".") {
    const f = args[0];
    if (!f) return null;
    if (f.dynamic) return dynamicSource(where);
    const text = readScript(f.text, st);
    return text === undefined ? null : analyzeShell(text, deeper);
  }
  if (head === "su" || head === "script" || head === "watch") {
    const i = texts.findIndex((t) => t === "-c" || t === "--command");
    const cmd = head === "watch" ? positionals(texts.filter((_, k) => texts[k - 1] !== "-n")).join(" ") : texts[i + 1];
    if (cmd) return analyzeShell(cmd, deeper);
    return null;
  }
  if (head === "pwsh" || head === "powershell") return nestedPowerShell(texts, deeper, segment);
  if (head === "cmd") return nestedCmd(texts, deeper, segment);

  // interpreters
  const interp = INTERP.find(([re]) => re.test(head));
  if (interp || (head === "deno" && texts[0] === "eval")) {
    let code: string | undefined;
    if (head === "deno") code = texts[1];
    else
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i] as string;
        const flag = interp?.[1].find(
          (f) => t === f || (f.length === 2 && /^-[a-zA-Z]+$/.test(t) && t.endsWith(f[1] as string)),
        );
        if (flag) {
          code = texts[i + 1];
          break;
        }
        const attached = interp?.[1].find(
          (f) => f.length === 2 && t.startsWith(f) && t.length > 2 && head.startsWith("python"),
        );
        if (attached) {
          code = t.slice(2);
          break;
        }
        if (t.startsWith("--eval=") || t.startsWith("--print=")) {
          code = t.slice(t.indexOf("=") + 1);
          break;
        }
        if (!t.startsWith("-")) break;
      }
    if (code === undefined) {
      const pos = texts.filter((t) => !t.startsWith("-") || t === "-");
      if (pos[0] === "-" || (!pos.length && where.cmd && (where.cmd.pipedFrom || where.cmd.redirs.length))) {
        const input = stdinText(where, st);
        if (input?.hit) return input.hit;
        code = input?.text;
      }
    }
    if (code === undefined) return null;
    const paranoid = gate(p, "interpreter.one-liner-paranoid", R.oneLiner, segment);
    if (paranoid) return paranoid;
    return codeHit(code, deeper, segment);
  }

  // awk
  if (/^(awk|gawk|mawk|nawk)$/.test(head)) {
    let prog: string | undefined;
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i] as string;
      if (t === "-f" || t === "--file") return null;
      if (t === "-v" || t === "-F") {
        i++;
        continue;
      }
      if (t.startsWith("-")) continue;
      prog = t;
      break;
    }
    return prog === undefined ? null : awkHit(prog, deeper, segment);
  }

  // network
  if (NETWORK.has(head)) {
    if (texts.some((t) => METADATA_HOSTS.some((h) => t.toLowerCase().includes(h))))
      return gate(p, "network.cloud-metadata", R.metadata, segment);
    if (head === "curl" || head === "wget") {
      const sends =
        head === "curl"
          ? texts.some(
              (t) => /^(-d|-F|-T|--data.*|--json|--form.*|--upload-file)(=|$)/.test(t) || /^-[a-zA-Z]*[dFT]/.test(t),
            )
          : texts.some((t) => /^--(post-data|post-file|body-data|body-file)(=|$)/.test(t));
      const urls = texts.filter((t) => /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^[\w.-]+\.[a-z]{2,}(\/|:|$)/i.test(t));
      const loopback = (u: string) => {
        try {
          const h = new URL(/:\/\//.test(u) ? u : `http://${u}`).hostname.replace(/^\[|\]$/g, "");
          return h === "localhost" || h.endsWith(".localhost") || /^127\./.test(h) || h === "0.0.0.0" || h === "::1";
        } catch {
          return false;
        }
      };
      if (sends && !(urls.length && urls.every(loopback))) {
        const hit = gate(p, "network.upload-remote", R.upload, segment);
        if (hit) return hit;
      }
    }
    return null;
  }

  if (head === "git") return gitHit(args, st, env, segment);
  if (head === "rm" || head === "rmdir" || head === "unlink") return rmHit(args, st, segment);
  if (head === "find") return findHit(args, st, deeper, segment);
  if (head === "xargs") return xargsHit(args, deeper, segment);
  if (head === "parallel") return parallelHit(args, deeper, where);
  if (head === "rsync") return rsyncHit(texts, st, segment);
  if (head === "dd") {
    const of = texts.find((t) => t.startsWith("of="))?.slice(3);
    if (of && /^\/dev\//.test(of) && !/^\/dev\/(null|zero|full)$/.test(of))
      return gate(p, "dd.device-write", R.dd, segment);
    return null;
  }
  if (/^(mkfs(\..+)?|mke2fs|newfs(_.+)?)$/.test(head)) {
    if (texts.some((t) => t.startsWith("/dev/"))) return gate(p, "mkfs.device", R.mkfs, segment);
    return null;
  }
  if (head === "diskutil") {
    const verb = (texts.find((t) => !t.startsWith("-")) ?? "").toLowerCase();
    const sub = (positionals(texts)[1] ?? "").toLowerCase();
    if (
      /^(erase|zerodisk|randomdisk|secureerase|reformat|partitiondisk|splitpartition|mergepartitions|addpartition|resizevolume)/.test(
        verb,
      ) ||
      ((verb === "apfs" || verb === "cs" || verb === "ar") && /^(delete|erase|resize|add|remove)/.test(sub))
    )
      return gate(p, "disk.erase", R.disk, segment);
    return null;
  }
  if (head === "wipefs") {
    if (texts.some((t) => t === "--all" || t.startsWith("--offset") || /^-[a-zA-Z]*[ao]/.test(t)))
      return gate(p, "disk.erase", R.disk, segment);
    return null;
  }
  if (head === "sgdisk" || head === "sfdisk" || head === "parted") {
    const dev = texts.some((t) => t.startsWith("/dev/"));
    if (!dev) return null;
    if (head === "parted") {
      if (texts.some((t) => /^(mklabel|mktable|mkpart|mkpartfs|rm|resizepart|resize|move|rescue)$/.test(t)))
        return gate(p, "disk.erase", R.disk, segment);
      return null;
    }
    const readOnly =
      /^(-p|--print|-v|--verify|-i|--info.*|-L|--list-types|-O|--print-mbr|-\?|--help|-V|--version|-l|--list|-d|--dump|-s|--show-size)$/;
    if (texts.some((t) => t.startsWith("-") && !readOnly.test(t.split("=")[0] ?? t)))
      return gate(p, "disk.erase", R.disk, segment);
    return null;
  }
  if (head === "shred") return gate(p, "shred.target", R.shred, segment);
  if (head === "unshare") {
    const user =
      texts.some((t) => /^--(user|map-root-user|map-current-user|map-users?|map-groups?|map-auto)(=|$)/.test(t)) ||
      texts.some((t) => /^-[a-zA-Z]*[Urc]/.test(t) && !t.startsWith("--"));
    return user ? gate(p, "unshare.user-namespace", R.unshare, segment) : null;
  }
  return null;
}

/** an interpreter one-liner: metadata hosts, secret paths, and shell commands in its string literals */
function codeHit(code: string, st: State, segment: string): Hit | null {
  if (METADATA_HOSTS.some((h) => code.toLowerCase().includes(h)))
    return gate(st.policy, "network.cloud-metadata", R.metadata, segment);
  const literals = [...code.matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`/g)].map((m) =>
    (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1"),
  );
  // argv lists: ['rm', '-rf', '/']
  const lists = [...code.matchAll(/[[(]\s*((?:(?:'[^']*'|"[^"]*")\s*,\s*)+(?:'[^']*'|"[^"]*"))\s*,?\s*[\])]/g)].map(
    (m) => [...(m[1] ?? "").matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2] ?? "").join(" "),
  );
  for (const lit of [...lists, ...literals]) {
    if (!lit.trim()) continue;
    const secret = !/\s/.test(lit) && secretRule(lit, st.cwd ?? st.anchor, st.policy.secret);
    if (secret) return { id: secret, reason: SECRET_REASON, segment };
    const hit = analyzeShell(lit, st);
    if (hit && !hit.id.startsWith("analysis."))
      return gate(st.policy, "interpreter.dangerous-command", R.interp, segment);
  }
  if (rawScan(code)) return gate(st.policy, "interpreter.dangerous-command", R.interp, segment);
  return null;
}

function awkHit(prog: string, st: State, segment: string): Hit | null {
  const lit = (e: string) => /^\s*"((?:\\.|[^"\\])*)"\s*$/.exec(e)?.[1];
  const commands: string[] = [];
  for (const m of prog.matchAll(/\bsystem\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) commands.push(m[1] ?? "");
  // "cmd" | getline, print … | "cmd"
  for (const m of prog.matchAll(/([^;{}|]*?)\|\s*getline/g)) commands.push(m[1] ?? "");
  for (const m of prog.matchAll(/\bprint[f]?\b[^;{}|]*\|(?!\|)\s*([^;{}]*)/g)) commands.push(m[1] ?? "");
  for (const c of commands) {
    const text = lit(c);
    if (text === undefined) return gate(st.policy, "awk.system-dynamic", R.awk, segment);
    const hit = analyzeShell(text.replace(/\\(.)/g, "$1"), st);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// git

const GLOBAL_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix",
]);
const NETWORK_SUBS = new Set(["clone", "fetch", "pull", "push", "ls-remote", "submodule"]);
/** discards a linked worktree may do under worktree mode */
const LOCAL_DISCARDS = new Set([
  "git.checkout-force",
  "git.checkout-double-dash",
  "git.checkout-ref-path",
  "git.checkout-pathspec-from-file",
  "git.checkout-ambiguous",
  "git.switch-discard-changes",
  "git.switch-force",
  "git.restore-worktree",
  "git.restore-unstaged",
  "git.reset-hard",
  "git.reset-merge",
  "git.clean-force",
]);

function gitHit(args0: Word[], st: State, env: Record<string, string>, segment: string): Hit | null {
  const p = st.policy;
  let args = args0.map((w) => w.text);
  const configs: string[] = [];
  let gitCwd = st.cwd;
  // global options
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (!a.startsWith("-")) break;
    const name = a.split("=")[0] as string;
    if (GLOBAL_WITH_VALUE.has(name)) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : (args[++i] ?? "");
      if (name === "-c") configs.push(v);
      if (name === "--config-env") configs.push(v);
      if (name === "-C") gitCwd = gitCwd === null ? null : resolve(gitCwd, v.replace(/^~(?=\/|$)/, homedir()));
    }
    i++;
  }
  let sub = args[i];
  let rest = args.slice(i + 1);
  // aliases from -c alias.x=… or the environment's config
  const envConfig = [
    env.GIT_CONFIG_PARAMETERS ?? "",
    ...Object.entries(env)
      .filter(([k]) => /^GIT_CONFIG_KEY_\d+$/.test(k))
      .map(([k, v]) => `${v}=${env[k.replace("KEY", "VALUE")] ?? ""}`),
  ].join("\n");
  if (/alias\./i.test(envConfig)) return gate(p, "git.alias-config", R.alias, segment);
  for (let n = 0; n < 5; n++) {
    const alias = configs
      .map((c) => /^alias\.([^=]+)=(.*)$/is.exec(c))
      .find((m) => m && m[1]?.toLowerCase() === sub?.toLowerCase());
    if (!alias) break;
    const value = alias[2] ?? "";
    if (value.startsWith("!") || /\$|`/.test(value)) return gate(p, "git.alias-config", R.alias, segment);
    const parts = value.split(/\s+/).filter(Boolean);
    sub = parts[0];
    rest = [...parts.slice(1), ...rest];
  }
  if (configs.some((c) => /^alias\./i.test(c) && c.includes("!")) && !sub)
    return gate(p, "git.alias-config", R.alias, segment);
  if (!sub) return null;
  args = rest;
  const sshEnv = "GIT_SSH" in env || "GIT_SSH_COMMAND" in env || configs.some((c) => /^core\.sshcommand=/i.test(c));
  if (sshEnv && NETWORK_SUBS.has(sub)) return gate(p, "git.ssh-env", R.sshEnv, segment);

  const s = shorts(args);
  const has = (...names: string[]) =>
    names.some((n) => (n.startsWith("--") ? long(args, n.slice(2)) : s.has(n.slice(1))));
  const hit = (id: string, reasonKey = id): Hit | null => {
    if (LOCAL_DISCARDS.has(id) && relaxed(gitCwd, st)) return null;
    return gate(p, id, GIT[reasonKey] ?? "", segment);
  };
  switch (sub) {
    case "checkout": {
      if (has("--help")) return null;
      if (has("-f", "--force")) return hit("git.checkout-force");
      if (long(args, "pathspec-from-file")) return hit("git.checkout-pathspec-from-file");
      const dd = args.indexOf("--");
      if (dd >= 0) {
        if (dd === args.length - 1) return null;
        const before = positionals(args.slice(0, dd));
        const creating = has("-b", "-B", "--orphan");
        if (before.length > (creating ? 1 : 0)) return hit("git.checkout-ref-path");
        return hit("git.checkout-double-dash");
      }
      if (has("-p", "--patch") || has("-b", "-B", "--orphan", "--detach")) return null;
      const pos = positionals(args.filter((a, k) => !["--conflict"].includes(args[k - 1] ?? "") && a));
      if (pos.length >= 2) return hit("git.checkout-ambiguous");
      if (pos.length === 1 && pos[0] !== "." && gitCwd && existsSync(join(gitCwd, pos[0] as string))) {
        const a = join(gitCwd, pos[0] as string);
        const isFile = (() => {
          try {
            return statSync(a).isFile();
          } catch {
            return false;
          }
        })();
        if (isFile) return hit("git.checkout-double-dash", "git.checkout-path");
      }
      if (pos[0] === ".") return hit("git.checkout-double-dash", "git.checkout-path");
      return null;
    }
    case "switch":
      if (has("--discard-changes")) return hit("git.switch-discard-changes");
      if (has("-f", "--force")) return hit("git.switch-force");
      return null;
    case "restore": {
      if (has("--help")) return null;
      if (has("-W", "--worktree")) return hit("git.restore-worktree");
      if (has("-S", "--staged")) return null;
      return hit("git.restore-unstaged");
    }
    case "reset":
      if (long(args, "hard")) return hit("git.reset-hard");
      if (long(args, "merge")) return hit("git.reset-merge");
      return null;
    case "clean":
      if (has("-n", "--dry-run")) return null;
      if (has("-f", "--force")) return hit("git.clean-force");
      return null;
    case "rm":
      if (has("-n", "--dry-run") || long(args, "cached")) return null;
      if (has("-f", "--force")) return hit("git.rm-force");
      return null;
    case "push": {
      if (long(args, "mirror")) return hit("git.push-mirror");
      const force =
        args.some((a) => a === "-f" || (/^-[a-zA-Z]*f/.test(a) && !a.startsWith("--"))) ||
        args.some((a) => /^--force(=|$)/.test(a) || (a.startsWith("--fo") && "--force".startsWith(a)));
      const pos = positionals(args);
      if (force || pos.slice(1).some((r) => r.startsWith("+") && r.length > 1)) return hit("git.push-force");
      if (has("-d", "--delete") || pos.slice(1).some((r) => r.startsWith(":") && r.length > 1))
        return hit("git.push-delete");
      return null;
    }
    case "branch":
      if (s.has("D") || (has("-d", "--delete") && has("-f", "--force"))) return hit("git.branch-force-delete");
      return null;
    case "rebase":
      return long(args, "abort") ? hit("git.rebase-abort") : null;
    case "merge":
      return long(args, "abort") ? hit("git.merge-abort") : null;
    case "tag":
      return has("-d", "--delete") ? hit("git.tag-delete") : null;
    case "reflog":
      return args[0] === "delete" ? hit("git.reflog-delete") : null;
    case "stash":
      if (args[0] === "drop") return hit("git.stash-drop");
      if (args[0] === "clear") return hit("git.stash-clear");
      return null;
    case "worktree":
      if (args[0] === "remove" && (has("-f", "--force") || args.includes("-f")))
        return hit("git.worktree-remove-force");
      return null;
  }
  return null;
}

/** worktree mode in a linked worktree, or a throwaway repo under a temp root outside the session */
function relaxed(gitCwd: string | null, st: State): boolean {
  if (!gitCwd) return false;
  let dir = gitCwd;
  for (;;) {
    const dotgit = join(dir, ".git");
    if (existsSync(dotgit)) {
      if (temps(st.env).some((t) => within(dir, t)) && !within(dir, st.anchor) && !within(st.anchor, dir)) return true;
      if (!st.policy.worktree) return false;
      try {
        return statSync(dotgit).isFile() && /gitdir:.*[\\/]worktrees[\\/]/.test(readFileSync(dotgit, "utf8"));
      } catch {
        return false;
      }
    }
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// deletes

function rmHit(args: Word[], st: State, segment: string): Hit | null {
  const texts = args.map((w) => w.text);
  const s = shorts(texts);
  const recursive = s.has("r") || s.has("R") || long(texts, "recursive", 3);
  const force = s.has("f") || long(texts, "force", 3);
  if (texts.includes("--no-preserve-root"))
    return gate(st.policy, "rm.recursive-force-root-or-home", DEL_REASONS.rm.root ?? "", segment);
  let rest = false;
  for (const w of args) {
    if (!rest && w.text === "--") {
      rest = true;
      continue;
    }
    if (!rest && w.text.startsWith("-") && w.text !== "-") continue;
    for (const t of w.quoted || w.dynamic ? [w.text] : braces(w.text)) {
      const e = expand({ text: t, raw: w.raw }, st);
      if (!(recursive && force)) {
        const a = e === undefined ? undefined : abs(e, st);
        if (a && gitMeta(a, st)) return gate(st.policy, "rm.git-metadata", R.gitMeta, segment);
        continue;
      }
      const hit = deleteHit("rm", classify(e, st), st, segment);
      if (hit) return hit;
    }
  }
  return null;
}

function findHit(args: Word[], st: State, deeper: State, segment: string): Hit | null {
  const texts = args.map((w) => w.text);
  const firstExpr = texts.findIndex((t) => /^[-(!]/.test(t) && !/^-[HLP]$/.test(t));
  const roots = (firstExpr < 0 ? texts : texts.slice(0, firstExpr)).filter((t) => !/^-[HLP]$/.test(t));
  const expr = firstExpr < 0 ? [] : texts.slice(firstExpr);
  if (expr.includes("-delete")) {
    const named = expr.some(
      (t, k) => /^-(i?name|i?path|i?wholename|regex)$/.test(expr[k - 1] ?? "") && /\.git\b/.test(t),
    );
    const gitRoot = roots.some((r) => {
      const a = abs(r.replace(/^~(?=\/|$)/, homedir()), st);
      return a !== undefined && gitMeta(a, st);
    });
    if (named || gitRoot) return gate(st.policy, "find.delete-git-metadata", R.gitMeta, segment);
    const allTemp = roots.length > 0 && roots.every((r) => classify(r, st) === "temp");
    if (!allTemp) {
      const hit = gate(st.policy, "find.delete", R.findDelete, segment);
      if (hit) return hit;
    }
  }
  for (let k = 0; k < expr.length; k++) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(expr[k] ?? "")) continue;
    const end = expr.findIndex((t, j) => j > k && (t === ";" || t === "+"));
    const child = expr.slice(k + 1, end < 0 ? undefined : end);
    const childWords = child.map((t) => (t === "{}" ? { ...literal(t), dynamic: true } : literal(t)));
    const unwrapped = unwrap(childWords, {}) ?? [];
    const h = base(unwrapped[0]?.text ?? "");
    if (h === "rm") {
      const s = shorts(unwrapped.slice(1).map((w) => w.text));
      const ts = unwrapped.slice(1).map((w) => w.text);
      if ((s.has("r") || s.has("R") || long(ts, "recursive", 3)) && (s.has("f") || long(ts, "force", 3)))
        return gate(st.policy, "find.exec-rm-recursive-force", R.findExecRm, segment);
    }
    const hit = analyzeWords(childWords, deeper, { assigns: {}, segment, appended: true });
    if (hit) return hit;
  }
  return null;
}

const XARGS_VALUE = new Set([
  "-I",
  "-i",
  "-n",
  "-P",
  "-L",
  "-l",
  "-d",
  "-a",
  "-E",
  "-e",
  "-s",
  "--max-args",
  "--max-procs",
  "--max-lines",
  "--delimiter",
  "--arg-file",
  "--eof",
  "--max-chars",
  "--replace",
  "--process-slot-var",
]);

function xargsHit(args: Word[], deeper: State, segment: string): Hit | null {
  const p = deeper.policy;
  let i = 0;
  let replace: string | undefined;
  for (; i < args.length; i++) {
    const t = args[i]?.text ?? "";
    if (t === "--") {
      i++;
      break;
    }
    if (!t.startsWith("-")) break;
    const name = t.split("=")[0] ?? t;
    if (name === "-I" || name === "--replace")
      replace = t.includes("=") ? t.slice(t.indexOf("=") + 1) : args[i + 1]?.text;
    if (/^-I./.test(t)) replace = t.slice(2);
    if (name === "-i" || t === "--replace") replace ??= "{}";
    if (XARGS_VALUE.has(name) && !t.includes("=") && name.length === t.length) i++;
  }
  const child = args.slice(i);
  if (!child.length) return null;
  if (child[0]?.dynamic) return gate(p, "xargs.shell-dynamic", R.xargsShell, segment);
  const unwrapped = unwrap(child, {}) ?? [];
  const h = base(unwrapped[0]?.text ?? "");
  const ts = unwrapped.slice(1).map((w) => w.text);
  const s = shorts(ts);
  if (h === "rm" && (s.has("r") || s.has("R") || long(ts, "recursive", 3)) && (s.has("f") || long(ts, "force", 3)))
    return gate(p, "xargs.rm-recursive-force-dynamic", R.xargsRm, segment);
  if (SHELLS.has(h)) {
    const c = ts.findIndex((t) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t));
    const script = c >= 0 ? ts[c + 1] : undefined;
    if (script === undefined || (replace && script.includes(replace)) || /\$[@*0-9{]/.test(script))
      return gate(p, "xargs.shell-dynamic", R.xargsShell, segment);
    return analyzeShell(script, deeper);
  }
  return analyzeWords(child, deeper, { assigns: {}, segment, appended: true });
}

function parallelHit(args: Word[], deeper: State, where: Where): Hit | null {
  const p = deeper.policy;
  const { segment } = where;
  const texts = args.map((w) => w.text);
  const sep = texts.findIndex((t) => /^:{3,4}\+?$/.test(t));
  let i = 0;
  for (; i < (sep < 0 ? texts.length : sep); i++) {
    const t = texts[i] as string;
    if (!t.startsWith("-")) break;
    if (
      /^(-j|-n|-N|-S|--jobs|--sshlogin|--colsep|-I|--replace|-a|--arg-file|--timeout|--delay|--joblog|--results|--workdir|--tmpdir|--env|-E)$/.test(
        t,
      )
    )
      i++;
  }
  const cmd = args.slice(i, sep < 0 ? undefined : sep);
  const inputs = sep < 0 ? undefined : texts.slice(sep + 1).filter((t) => !/^:{3,4}\+?$/.test(t));
  if (!cmd.length)
    return gate(
      p,
      "parallel.command-stream-dynamic",
      "parallel command streams from dynamic input cannot be verified safely. Pass an explicit command.",
      segment,
    );
  // one word with spaces: parallel runs it through a shell
  const words =
    cmd.length === 1 && /\s/.test(cmd[0]?.text ?? "")
      ? (() => {
          try {
            return parse(cmd[0]?.text ?? "").cmds[0]?.words ?? cmd;
          } catch {
            return cmd;
          }
        })()
      : cmd;
  if (words[0]?.dynamic) return gate(p, "parallel.shell-dynamic", R.parallelShell, segment);
  const unwrapped = unwrap(words, {}) ?? [];
  const h = base(unwrapped[0]?.text ?? "");
  const ts = unwrapped.slice(1).map((w) => w.text);
  const s = shorts(ts);
  const rmrf =
    h === "rm" && (s.has("r") || s.has("R") || long(ts, "recursive", 3)) && (s.has("f") || long(ts, "force", 3));
  if (SHELLS.has(h)) {
    const c = ts.findIndex((t) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t));
    const script = c >= 0 ? ts[c + 1] : undefined;
    if (script === undefined || (!inputs && /\{\}|\$[@*0-9]/.test(script)))
      return gate(p, "parallel.shell-dynamic", R.parallelShell, segment);
    for (const input of inputs ?? [""]) {
      const hit = analyzeShell(script.replaceAll("{}", input), deeper);
      if (hit) return hit;
    }
    return null;
  }
  if (rmrf && !inputs) return gate(p, "parallel.rm-recursive-force-dynamic", R.parallelRm, segment);
  // each input substituted (or appended) as literal arguments
  for (const input of inputs ?? [undefined]) {
    const placed =
      input === undefined
        ? unwrapped
        : unwrapped.map((w) => (w.text.includes("{}") ? literal(w.text.replaceAll("{}", input)) : w));
    const full =
      input !== undefined && !unwrapped.some((w) => w.text.includes("{}")) ? [...placed, literal(input)] : placed;
    const hit = analyzeWords(full, deeper, { assigns: {}, segment, appended: input === undefined });
    if (hit) return hit;
  }
  return null;
}

function rsyncHit(texts: string[], st: State, segment: string): Hit | null {
  if (!texts.some((t) => /^--(delete|del)(-[a-z]+)?$/.test(t))) return null;
  const pos = positionals(
    texts.filter((_, k) => !/^(-e|--rsh|--exclude|--include|--filter|-f|--files-from)$/.test(texts[k - 1] ?? "")),
  );
  const dest = pos.at(-1);
  if (!dest || pos.length < 2) return null;
  // a remote destination isn't on this machine
  if (!/[$`]/.test(dest) && /^[^/]*:/.test(dest)) return null;
  const e = expand(literal(dest), st);
  const kind = classify(e, st);
  if (kind === "root") return gate(st.policy, "rm.recursive-force-root-or-home", R.rsyncRoot, segment);
  if (kind === "git") return gate(st.policy, "rm.git-metadata", R.gitMeta, segment);
  if (kind === "temp" || kind === "within") return null;
  return gate(st.policy, "rsync.delete", R.rsync, segment);
}

// ---------------------------------------------------------------------------------------------------------------
// PowerShell and cmd

const REMOVE_ITEM = new Set(["remove-item", "rm", "ri", "del", "erase", "rd", "rmdir"]);
const RECURSIVE_DELETE = /\b(remove-item|ri|rm|del|erase|rd|rmdir)\b[^;|\n]*\s-r/i;

/** `pwsh`/`powershell` from a shell: only `-Command <script>` after harmless switches is read */
function nestedPowerShell(texts: string[], st: State, segment: string): Hit | null {
  let i = 0;
  while (i < texts.length) {
    const t = (texts[i] as string).toLowerCase();
    if (/^-(noprofile|nop|noninteractive|noni|nologo|nol)$/.test(t)) i++;
    else if (/^-(executionpolicy|ep|ex)$/.test(t)) i += 2;
    else break;
  }
  const flag = (texts[i] ?? "").toLowerCase();
  if (/^-(c|co|com|comm|comma|comman|command)$/.test(flag)) return analyzePowerShell(texts.slice(i + 1).join(" "), st);
  if (/^-(e|ec|en|enc|encodedcommand|encoded)/.test(flag) && texts[i + 1]) {
    const decoded = Buffer.from(texts[i + 1] as string, "base64").toString("utf16le");
    if (RECURSIVE_DELETE.test(decoded))
      return gate(st.policy, "powershell.nested-recursive-delete-unread", R.pwshUnread, segment);
    return analyzePowerShell(decoded, st);
  }
  if (RECURSIVE_DELETE.test(texts.join(" ")))
    return gate(st.policy, "powershell.nested-recursive-delete-unread", R.pwshUnread, segment);
  // `powershell "…"`: a positional script is a command
  if (flag && !flag.startsWith("-")) return analyzePowerShell(texts.slice(i).join(" "), st);
  return null;
}

/** PowerShell statements: split on `;`, `|`, newlines, `&&`, `||`; words honour '…' and "…" */
function psStatements(src: string): { words: { text: string; dynamic: boolean }[]; piped: boolean }[] {
  const out: { words: { text: string; dynamic: boolean }[]; piped: boolean }[] = [];
  let words: { text: string; dynamic: boolean }[] = [];
  let cur: { text: string; dynamic: boolean } | undefined;
  let piped = false;
  const end = () => {
    if (cur) words.push(cur);
    cur = undefined;
  };
  const stmt = (pipe: boolean) => {
    end();
    if (words.length) out.push({ words, piped });
    words = [];
    piped = pipe;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (c === "`") {
      cur ??= { text: "", dynamic: false };
      cur.text += src[++i] ?? "";
    } else if (c === "'") {
      cur ??= { text: "", dynamic: false };
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === "'" && src[j + 1] === "'") {
          cur.text += "'";
          j++;
        } else if (src[j] === "'") break;
        else cur.text += src[j];
      }
      i = j;
    } else if (c === '"') {
      cur ??= { text: "", dynamic: false };
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === "`") j++;
        if (src[j] === "$") cur.dynamic = true;
        cur.text += src[j] ?? "";
      }
      i = j;
    } else if (/\s/.test(c) && c !== "\n") end();
    else if (c === "\n" || c === ";") stmt(false);
    else if (c === "|" && src[i + 1] === "|") {
      stmt(false);
      i++;
    } else if (c === "&" && src[i + 1] === "&") {
      stmt(false);
      i++;
    } else if (c === "|") stmt(true);
    else {
      cur ??= { text: "", dynamic: false };
      if (c === "$") cur.dynamic = true;
      cur.text += c;
    }
  }
  stmt(false);
  return out;
}

const psHome = (t: string) =>
  t
    .replace(/^(~|\$home|\$env:userprofile|\$env:home)(?=[\\/]|$)/i, homedir())
    .replace(/^\$env:(temp|tmp)(?=[\\/]|$)/i, tmpdir());

export function analyzePowerShell(src: string, st0: State): Hit | null {
  if (st0.depth > MAX_DEPTH) return { id: "analysis.recursion-limit", reason: R.recursion };
  const st = { ...st0, depth: st0.depth + 1 };
  for (const { words, piped } of psStatements(src)) {
    const head = base(words[0]?.text ?? "");
    const segment = words.map((w) => w.text).join(" ");
    const rest = words.slice(1);
    if (REMOVE_ITEM.has(head)) {
      const hit = psRemove(rest, piped, st, segment);
      if (hit) return hit;
      continue;
    }
    if (/^(set-location|sl|cd|chdir|push-location|pushd)$/.test(head)) {
      const t = rest.find((w) => !w.text.startsWith("-"));
      st.cwd =
        !t || (t.dynamic && !/^\$(home|env:userprofile)/i.test(t.text))
          ? t
            ? null
            : homedir()
          : (abs(psHome(t.text), st) ?? null);
      continue;
    }
    if (/^(invoke-expression|iex)$/.test(head)) {
      const s = rest.find((w) => !w.text.startsWith("-"));
      if (s?.dynamic) return { id: "analysis.dynamic-shell-source", reason: R.dynamicSource, segment };
      const hit = s ? analyzePowerShell(s.text, st) : null;
      if (hit) return hit;
      continue;
    }
    // anything else (git, cmd, pwsh, …) is an external command
    const hit = analyzeWords(
      words.map((w) => ({ ...literal(w.text), dynamic: w.dynamic })),
      st,
      { assigns: {}, segment },
    );
    if (hit) return hit;
  }
  return null;
}

function psRemove(args: { text: string; dynamic: boolean }[], piped: boolean, st: State, segment: string): Hit | null {
  let recurse = false;
  let force = false;
  const targets: { text: string; dynamic: boolean }[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as { text: string; dynamic: boolean };
    const t = a.text.toLowerCase();
    if (!t.startsWith("-")) {
      targets.push(a);
      continue;
    }
    const [name = "", inline] = t.split(":");
    if (name.length >= 2 && "-recurse".startsWith(name)) recurse = true;
    else if (name.length >= 3 && "-force".startsWith(name)) force = true;
    else if (/^-(path|literalpath|lp|pspath|p)$/.test(name)) {
      if (inline) targets.push({ text: a.text.slice(a.text.indexOf(":") + 1), dynamic: a.dynamic });
      else if (args[i + 1]) targets.push(args[++i] as { text: string; dynamic: boolean });
    } else if (/^-(filter|include|exclude|credential|stream)$/.test(name) && !inline) i++;
  }
  const targetsSplit = targets.flatMap((t) => t.text.split(",").map((x) => ({ text: x, dynamic: t.dynamic })));
  if (!targetsSplit.length && piped)
    return gate(
      st.policy,
      "powershell.remove-item-pipeline-dynamic-target",
      DEL_REASONS.powershell.pipeline ?? "",
      segment,
    );
  for (const t of targetsSplit) {
    const text = psHome(t.text);
    const dyn = /\$/.test(text);
    const kind = classify(dyn ? undefined : text, st, "windows");
    if (kind === "root") {
      const id =
        recurse && force
          ? "powershell.remove-item-recursive-force-root-or-home"
          : "powershell.remove-item-root-or-home";
      return gate(st.policy, id, DEL_REASONS.powershell.root ?? "", segment);
    }
    if (kind === "git") return gate(st.policy, "powershell.remove-item-git-metadata", R.gitMeta, segment);
    if (!(recurse && force)) continue;
    const hit = deleteHit("powershell", kind, st, segment);
    if (hit) return hit;
  }
  return null;
}

/** `cmd /c …` from a shell */
function nestedCmd(texts: string[], st: State, segment: string): Hit | null {
  const i = texts.findIndex((t) => /^\/[ck]$/i.test(t));
  if (i < 0) return null;
  const line = texts.slice(i + 1).join(" ");
  const local: State = { ...st };
  for (const part of line.split(/&&|\|\||&|\|/)) {
    const words = part.match(/"[^"]*"|\S+/g) ?? [];
    const head = base(words[0] ?? "");
    const args = words.slice(1);
    if (head === "cd" || head === "chdir") {
      const t = args.find((a) => !a.startsWith("/"))?.replace(/^"|"$/g, "");
      local.cwd = t ? (abs(t.replace(/^%userprofile%/i, homedir()), local) ?? null) : local.cwd;
      continue;
    }
    const isDel =
      (head === "rd" || head === "rmdir" || head === "del" || head === "erase") &&
      args.some((a) => /^\/s/i.test(a) || (/\/s/i.test(a) && a.startsWith("/")));
    if (!isDel) {
      const hit = analyzeWords(
        words.map((w) => literal(w.replace(/^"|"$/g, ""))),
        local,
        { assigns: {}, segment },
      );
      if (hit) return hit;
      continue;
    }
    if (args.some((a) => a.includes('\\"') || a.startsWith("\\\\?\\")))
      return gate(st.policy, "cmd.recursive-delete-escaped-quote", R.cmdQuote, segment);
    for (const raw of args.filter((a) => !a.startsWith("/"))) {
      const t = raw.replace(/^"|"$/g, "").replace(/^%userprofile%|^%homedrive%%homepath%/i, homedir());
      const dynamic = /%[^%]+%|[*?]|!/.test(t);
      const kind = classify(dynamic ? undefined : t, local, "windows");
      const hit = deleteHit("cmd", kind, local, segment);
      if (hit) return hit;
    }
  }
  return null;
}

/** The gate for a file tool's path (read/write/edit and friends). */
export function checkPath(path: string, mode: "read" | "write", st: State, segment: string): Hit | null {
  return pathGuards(path.replace(/^~(?=\/|$)/, homedir()), mode, st, segment);
}
