import { spawn } from "node:child_process";
import type { GitStatus } from "./segments.ts";

type Host = "github" | "gitlab" | "bitbucket" | "other";
interface Cached<T> {
  value: T;
  at: number;
}

const BRANCH_TTL = 500;
const REMOTE_TTL = 60_000;
let cwd = "";
let status: Cached<Omit<GitStatus, "branch">> | undefined;
let branch: Cached<string | null> | undefined;
let remote: Cached<Host | null> | undefined;
// bumped by invalidation, so a read started before it never lands
let gen = 0;
const pending = { status: false, branch: false, remote: false };
const listeners = new Set<() => void>();

/** Called when a background read changed what the segment shows. */
export function onGitUpdate(f: () => void) {
  listeners.add(f);
  return () => void listeners.delete(f);
}
const changed = () => {
  for (const f of listeners) f();
};

/**
 * `git` read-only: GIT_OPTIONAL_LOCKS=0 keeps `status` from refreshing the index (and taking `.git/index.lock`, racing
 * the user's own git). Null on failure or after `timeout` ms.
 */
function git(args: string[], dir: string, timeout = 200): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const p = spawn("git", args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.on("close", (code) => finish(code === 0 ? out.trimEnd() : null));
    p.on("error", () => finish(null));
    const timer = setTimeout(() => {
      p.kill();
      finish(null);
    }, timeout);
  });
}

export function parsePorcelain(output: string) {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [x, y] = line;
    if (x === "?" && y === "?") {
      untracked++;
      continue;
    }
    if (x && x !== " " && x !== "?") staged++;
    if (y && y !== " ") unstaged++;
  }
  return { staged, unstaged, untracked };
}

export function detectHost(url: string | null): Host | null {
  const u = url?.trim();
  if (!u) return null;
  let host: string;
  const scp = /^[^/@]+@([^:/]+):/.exec(u);
  if (scp?.[1]) host = scp[1];
  else
    try {
      host = new URL(u).hostname;
    } catch {
      return "other";
    }
  host = host.toLowerCase().replace(/^www\./, "");
  for (const [name, domain] of [
    ["github", "github.com"],
    ["gitlab", "gitlab.com"],
    ["bitbucket", "bitbucket.org"],
  ] as const)
    if (host === domain || host.endsWith(`.${domain}`)) return name;
  return "other";
}

/** Starts `read` unless one of its kind is running; stores and announces a changed value. */
function refresh<T>(kind: keyof typeof pending, read: () => Promise<T>, store: (v: T) => boolean) {
  if (pending[kind]) return;
  pending[kind] = true;
  const at = gen;
  void read().then((v) => {
    if (at !== gen) return;
    pending[kind] = false;
    if (store(v)) changed();
  });
}

export function invalidateGit(alsoBranch = false) {
  if (status) status.at = Number.NEGATIVE_INFINITY;
  if (alsoBranch) {
    if (branch) branch.at = 0;
    remote = undefined;
  }
  gen++;
  pending.status = pending.branch = pending.remote = false;
}

/**
 * The repo's branch and dirty counts for `dir`, from cache (the last value is served while a background refresh runs;
 * a refresh starts once it is older than `ttl`). `polling` "branch" skips the counts, "off" reads nothing.
 */
export function gitStatus(dir: string, polling: "full" | "branch" | "off" = "full", ttl = 1000): GitStatus {
  if (dir !== cwd) {
    cwd = dir;
    status = branch = remote = undefined;
    invalidateGit(true);
  }
  const now = Date.now();
  if (polling === "off") return { branch: null, staged: 0, unstaged: 0, untracked: 0 };
  if (!branch || now - branch.at >= BRANCH_TTL)
    refresh(
      "branch",
      async () => {
        const b = await git(["symbolic-ref", "--short", "HEAD"], dir);
        if (b) return b;
        const sha = await git(["rev-parse", "--short", "HEAD"], dir);
        return sha ? `${sha} (detached)` : null;
      },
      (v) => {
        const diff = branch?.value !== v;
        branch = { value: v, at: Date.now() };
        return diff;
      },
    );
  const counts = { staged: 0, unstaged: 0, untracked: 0 };
  if (polling === "full") {
    if (!status || now - status.at >= ttl)
      refresh(
        "status",
        async () => {
          const out = await git(["status", "--porcelain"], dir, 500);
          return out === null ? counts : parsePorcelain(out);
        },
        (v) => {
          const old = status?.value ?? counts;
          status = { value: v, at: Date.now() };
          return old.staged !== v.staged || old.unstaged !== v.unstaged || old.untracked !== v.untracked;
        },
      );
    Object.assign(counts, status?.value);
  }
  return { branch: branch?.value ?? null, ...counts };
}

/** The origin remote's host, for `git.hostIcon` (cached for a minute). */
export function gitHost(dir: string): Host | null {
  if (!remote || Date.now() - remote.at >= REMOTE_TTL)
    refresh(
      "remote",
      async () => detectHost(await git(["remote", "get-url", "origin"], dir)),
      (v) => {
        const diff = (remote?.value ?? null) !== v;
        remote = { value: v, at: Date.now() };
        return diff;
      },
    );
  return remote?.value ?? null;
}

/** Commands that may switch the branch, so it's re-read at once. */
export const mightChangeBranch = (cmd: string) =>
  /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/.test(cmd) ||
  /\bgit\s+stash\s+(pop|apply)/.test(cmd);
