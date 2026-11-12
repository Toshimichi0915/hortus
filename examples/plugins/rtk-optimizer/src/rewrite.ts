import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `file args`, resolving with its exit code; rejects only when it can't run (missing, timed out, aborted). */
export const exec = (file: string, args: string[], timeout: number, signal?: AbortSignal) =>
  new Promise<ExecResult>((resolve, reject) =>
    execFile(file, args, { timeout, ...(signal && { signal }) }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
    }),
  );

const trimDetail = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
export const trimMessage = (raw: string, max = 220) => {
  const clean = trimDetail(raw);
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
};

const SINGLE_QUOTED = "'(?:'\\\\''|[^'])*'";
const LEADING_ENV = new RegExp(`^((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|${SINGLE_QUOTED}|[^\\s]+)\\s+)*)`);

export function splitLeadingEnvAssignments(input: string): { envPrefix: string; command: string } {
  const envPrefix = input.match(LEADING_ENV)?.[1] ?? "";
  return { envPrefix, command: input.slice(envPrefix.length) };
}

const isRtk = (command: string) => command === "rtk" || command.startsWith("rtk ");

export interface RtkExecutable {
  command: string;
  resolvedPath?: string;
  warning?: string;
}

/** `which rtk` (`where` on Windows): its path, else plain `rtk` with why it wasn't found. */
export async function resolveRtkExecutable(): Promise<RtkExecutable> {
  const resolver = process.platform === "win32" ? "where" : "which";
  try {
    const result = await exec(resolver, ["rtk"], 1000);
    const path = result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^(["'])(.*)\1$/, "$2"))
      .find(Boolean);
    if (result.code === 0 && path) return { command: path, resolvedPath: path };
    const detail = trimDetail(result.stderr || result.stdout || `exit ${result.code}`);
    return {
      command: "rtk",
      warning: `rtk executable path resolution via ${resolver} failed${detail && `: ${detail}`}`,
    };
  } catch (e) {
    return {
      command: "rtk",
      warning: `rtk executable path resolution via ${resolver} failed: ${trimDetail((e as Error).message)}`,
    };
  }
}

export interface RuntimeStatus {
  rtkAvailable: boolean;
  lastCheckedAt?: number;
  lastError?: string;
  executable?: RtkExecutable;
}

/** Resolves `rtk` and runs `rtk --version`. */
export async function checkRuntime(): Promise<RuntimeStatus> {
  let executable: RtkExecutable | undefined;
  try {
    executable = await resolveRtkExecutable();
    const result = await exec(executable.command, ["--version"], 5000);
    if (result.code === 0) return { rtkAvailable: true, lastCheckedAt: Date.now(), executable };
    const detail = trimMessage(`${result.stderr} ${result.stdout} ${result.code ? `(exit ${result.code})` : ""}`);
    return { rtkAvailable: false, lastCheckedAt: Date.now(), lastError: detail || `exit ${result.code}`, executable };
  } catch (e) {
    return {
      rtkAvailable: false,
      lastCheckedAt: Date.now(),
      lastError: trimMessage((e as Error).message),
      ...(executable && { executable }),
    };
  }
}

export interface RewriteDecision {
  changed: boolean;
  rewrittenCommand: string;
  warning?: string;
}

/**
 * Asks `rtk rewrite <command>`, the source of truth for which commands it supports: exit 0 or 3 = rewritten (stdout),
 * 1 = no rewrite, 2 = denied.
 */
export async function computeRewriteDecision(
  command: string,
  executable?: RtkExecutable,
  signal?: AbortSignal,
): Promise<RewriteDecision> {
  const same = (warning?: string): RewriteDecision => ({
    changed: false,
    rewrittenCommand: command,
    ...(warning && { warning }),
  });
  if (!command.trim()) return same();
  if (isRtk(splitLeadingEnvAssignments(command.trimStart()).command.trimStart())) return same();
  try {
    const rtk = executable ?? (await resolveRtkExecutable());
    const result = await exec(rtk.command, ["rewrite", command], 3000, signal);
    if (result.code === 1) return same();
    if (result.code === 2) return same(result.stderr.trim() || "rtk denied rewrite");
    if (result.code !== 0 && result.code !== 3) return same(`unexpected exit code ${result.code}`);
    const rewritten = result.stdout.trim();
    if (!rewritten) return same("rtk returned empty output");
    return rewritten === command ? same() : { changed: true, rewrittenCommand: rewritten };
  } catch (e) {
    return same((e as Error).message);
  }
}

const ENV_VALUE = `(?:"[^"]*"|${SINGLE_QUOTED}|[^\\s;]+)`;
const DB_PATH_ASSIGNMENT = new RegExp(`(?:^|\\s)RTK_DB_PATH=${ENV_VALUE}(?=\\s|$)`);
const DB_PATH_EXPORT = new RegExp(`^export\\s+RTK_DB_PATH=${ENV_VALUE}(?=\\s*(?:;|$))`);

/**
 * Points rtk's history database at a temp file (unless the command or the environment sets `RTK_DB_PATH`), so
 * rewritten commands don't write into the user's rtk history.
 */
export function applyRtkCommandEnvironment(command: string): string {
  const trimmed = command.trimStart();
  if (
    !command.trim() ||
    DB_PATH_ASSIGNMENT.test(splitLeadingEnvAssignments(trimmed).envPrefix) ||
    DB_PATH_EXPORT.test(trimmed) ||
    process.env.RTK_DB_PATH?.trim()
  )
    return command;
  const path = join(
    process.env.TMPDIR?.trim() || process.env.TMP?.trim() || tmpdir(),
    "pi-rtk-optimizer",
    "history.db",
  );
  return `export RTK_DB_PATH='${path.replace(/'/g, `'\\''`)}'; ${command}`;
}
