import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as z from "zod";
import { hortusDir } from "./config.ts";

/**
 * One secrets.json entry; fields other than these are kept, for providers that need more (OAuth tokens, ...). A `type`
 * no provider has (`brave`, `exa`, ...) is a credential for plugins (found with `SecretStore.find`): model listing and
 * provider resolution ignore it.
 */
const SecretSchema = z.looseObject({
  /** name of a plugin provider, e.g. "openai", or of whatever plugin reads the entry */
  type: z.string(),
  apiKey: z.string().optional(),
  /** base URL override, e.g. "https://openrouter.ai/api/v1" */
  endpoint: z.string().optional(),
});
export type Secret = z.infer<typeof SecretSchema>;

// keyed by the name users select with config.provider / /model, e.g. { openrouter: { type: "openai", ... } }
export const SecretsSchema = z.record(z.string(), SecretSchema.optional());
export type Secrets = z.infer<typeof SecretsSchema>;

const secretsPath = () => join(hortusDir(), "secrets.json");

export async function loadSecrets(): Promise<Secrets> {
  const path = secretsPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  // thrown, not read as empty: saving over an invalid file would lose the rest of it
  try {
    return SecretsSchema.parse(JSON.parse(text));
  } catch (e) {
    throw new Error(`Invalid ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Replaces secrets.json (mode 0600) in one rename, so a reader never sees half of it. */
export async function saveSecrets(data: Secrets) {
  await mkdir(hortusDir(), { recursive: true, mode: 0o700 });
  const path = secretsPath();
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/** Creates `lock` holding `token`; false if it exists. */
async function tryLock(lock: string, token: string) {
  try {
    await writeFile(lock, token, { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/** Removes `lock` if it still holds `token`. */
async function unlock(lock: string, token: string) {
  if ((await readFile(lock, "utf8").catch(() => undefined)) === token) await rm(lock, { force: true });
}

/** Tokens this process holds or waits with: a lock with this pid and another token is left over from an earlier one. */
const live = new Set<string>();

/** Whether the lock token `holder` (`<pid> <uuid>`) belongs to a process that has exited. */
function dead(holder: string) {
  const pid = Number(holder.split(" ")[0]);
  // empty (being written) or unreadable: not known to be dead
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // a reused pid (e.g. 1 in each container) would otherwise look alive forever
  if (pid === process.pid) return !live.has(holder);
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** The locks (lock path → token) the current async context holds, so a nested `withFileLock` doesn't wait on itself. */
const held = new AsyncLocalStorage<Map<string, string>>();
/** Tokens whose lock is taken and not yet being released: what the re-entrant check trusts (`live` outlasts the unlock). */
const holding = new Set<string>();

/**
 * Runs `fn` while holding `<path>.lock`, which every process using this waits for, so read-modify-write cycles of
 * `path` don't interleave (within a process too). The lock holds `<pid> <uuid>`: it is taken as stale only once that
 * process has exited (a slow holder keeps it), and each holder removes only its own. Waiting longer than `timeout` ms
 * throws, naming the holder, rather than hanging (the lock is left alone: its holder may still be working).
 * Re-entrant: called from inside `fn` (its async context) while the lock is still held, it runs at once.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, { timeout = 60_000 } = {}): Promise<T> {
  const lock = `${path}.lock`;
  const outer = held.getStore();
  const mine = outer?.get(lock);
  // ponytail: nested calls run unserialized with each other (two at once inside one fn can interleave), and an
  // un-awaited nested call started inside fn that keeps running after it returns is unprotected once the lock is
  // released; queue them per lock (and have the holder wait for them) if a holder ever runs them concurrently
  if (mine && holding.has(mine)) return fn();
  const token = `${process.pid} ${randomUUID()}`;
  const deadline = Date.now() + timeout;
  live.add(token);
  try {
    await take(lock, token, deadline);
    holding.add(token);
    try {
      return await held.run(new Map(outer).set(lock, token), fn);
    } finally {
      // synchronously, before unlock awaits: a callback from fn firing meanwhile must take the lock, not skip it
      holding.delete(token);
      await unlock(lock, token);
    }
  } finally {
    live.delete(token);
  }
}

async function take(lock: string, token: string, deadline: number) {
  while (!(await tryLock(lock, token))) {
    const holder = await readFile(lock, "utf8").catch(() => undefined);
    // breakers take turns under `.break`, re-checking the holder, so two never both remove a stale lock (the second
    // would remove the first one's new lock). ponytail: a breaker that dies holding `.break` (a few syscalls) leaves
    // it stale until the same pid check removes it, which two waiters can then both do; pids are host-local, so locks
    // on a filesystem shared between hosts (or pid namespaces) aren't safe; a lock whose pid was reused by another
    // process is only reported, by the timeout below
    if (holder && dead(holder)) {
      const brk = `${lock}.break`;
      if (await tryLock(brk, token)) {
        try {
          await unlock(lock, holder);
        } finally {
          await unlock(brk, token);
        }
      } else {
        const breaker = await readFile(brk, "utf8").catch(() => undefined);
        if (breaker && dead(breaker)) await unlock(brk, breaker);
      }
    } else if (Date.now() > deadline) {
      const by = holder ? `pid ${holder.split(" ")[0]}` : "an unknown holder";
      throw new Error(`Timed out waiting for ${lock}, held by ${by}; remove it if that's stale`);
    }
    await sleep(5 + Math.random() * 20);
  }
}

/**
 * Re-reads secrets.json, replaces entry `name` with what `fn` returns (undefined removes it) and saves it if that changed,
 * all under a lock, so parallel hortus processes never lose each other's changes (e.g. a rotated refresh token).
 */
export async function updateSecret(
  name: string,
  fn: (entry: Secret | undefined) => Secret | undefined | Promise<Secret | undefined>,
): Promise<Secret | undefined> {
  await mkdir(hortusDir(), { recursive: true, mode: 0o700 });
  return withFileLock(secretsPath(), async () => {
    const prev = (await loadSecrets())[name];
    const next = await fn(prev);
    // re-read: `fn` may have changed other entries (the lock is re-entrant)
    if (JSON.stringify(next) !== JSON.stringify(prev)) await saveSecrets({ ...(await loadSecrets()), [name]: next });
    return next;
  });
}

/** `${VAR}` in `value` read from the environment (empty if unset), so keys can stay out of config files. */
export const expandEnv = (value: string) => value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");

const expand = (v: unknown): unknown =>
  typeof v === "string"
    ? expandEnv(v)
    : Array.isArray(v)
      ? v.map(expand)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]))
        : v;

/** `entry` with `${VAR}` expanded in every string, nested ones (`headers: { ... }`) included. */
export const expandSecret = (entry: Secret): Secret => expand(entry) as Secret;

/** secrets.json as plugins see it: `ctx.secrets` (handlers, tools, providers, `agent.ctx`). */
export interface SecretStore {
  /** entry `name` through its provider's `auth` (saving what changed; `refresh` forces one), then `${VAR}` expanded */
  get(name: string, opts?: { refresh?: boolean }): Promise<Secret | undefined>;
  /** changes one entry under a lock (see `updateSecret`) */
  update: typeof updateSecret;
  /** every entry of `type`, `${VAR}` expanded but not through `auth` (`get` its name for a fresh one) */
  find(type: string): Promise<{ name: string; entry: Secret }[]>;
}

export const trustFile = () => join(hortusDir(), "trust.json");

/** The paths `ctx.trust` answered "Trust" for (`~/.hortus/trust.json` `{ trusted: string[] }`); none on a bad file. */
export async function trustedPaths(): Promise<string[]> {
  try {
    const { trusted } = JSON.parse(await readFile(trustFile(), "utf8")) as { trusted?: unknown };
    return Array.isArray(trusted) ? trusted.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** `path` is trusted: it or a directory above it is in trust.json. */
export const isTrusted = async (path: string) =>
  (await trustedPaths()).some((t) => path === t || path.startsWith(t.endsWith(sep) ? t : t + sep));

/** Adds `path` to trust.json (mode 0600), under its lock, so parallel processes keep each other's answers. */
export async function addTrusted(path: string) {
  await mkdir(hortusDir(), { recursive: true, mode: 0o700 });
  await withFileLock(trustFile(), async () => {
    const trusted = await trustedPaths();
    if (trusted.includes(path)) return;
    const tmp = `${trustFile()}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ trusted: [...trusted, path] }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, trustFile());
  });
}
