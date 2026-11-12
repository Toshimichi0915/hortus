import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { loadSecrets, updateSecret, withFileLock } from "./secrets.ts";
import { tempDir, tempHome } from "./testing.ts";

const lockOf = async (t: TestContext) => {
  const path = join(await tempDir(t), "f");
  return { path, lock: `${path}.lock` };
};

test("withFileLock takes over a lock whose process has exited", async (t) => {
  const { path, lock } = await lockOf(t);
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  await writeFile(lock, `${exited} old`);
  assert.equal(await withFileLock(path, async () => "ran"), "ran");
  await assert.rejects(readFile(lock), { code: "ENOENT" });
});

/** A running process to hold locks, killed after `t`. */
const liveHolder = (t: { after(fn: () => void): void }) => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  t.after(() => child.kill());
  return child.pid;
};

test("withFileLock takes over a lock with this pid that no call in this process holds (a reused pid)", async (t) => {
  const { path, lock } = await lockOf(t);
  await writeFile(lock, `${process.pid} left-over`);
  assert.equal(await withFileLock(path, async () => "ran"), "ran");
});

test("withFileLock calls in one process wait for each other", async (t) => {
  const { path } = await lockOf(t);
  const order: string[] = [];
  const hold = (name: string, ms: number) =>
    withFileLock(path, async () => {
      order.push(`${name} in`);
      await sleep(ms);
      order.push(`${name} out`);
    });
  await Promise.all([hold("a", 100), sleep(10).then(() => hold("b", 0))]);
  assert.deepEqual(order, ["a in", "a out", "b in", "b out"]);
});

test("withFileLock waits for a live holder however old its lock, and never removes another holder's lock", async (t) => {
  const { path, lock } = await lockOf(t);
  const pid = liveHolder(t);
  await writeFile(lock, `${pid} other`);
  const old = new Date(Date.now() - 3_600_000);
  await utimes(lock, old, old);
  let ran = false;
  const done = withFileLock(path, async () => {
    ran = true;
    // as if another holder had taken it meanwhile: this one's release leaves it alone
    await writeFile(lock, `${pid} someone-else`);
  });
  await sleep(200);
  assert.equal(ran, false);
  await rm(lock);
  await done;
  assert.equal(await readFile(lock, "utf8"), `${pid} someone-else`);
});

test("withFileLock gives up after its timeout, naming the lock and its holder, and leaves the lock", async (t) => {
  const { path, lock } = await lockOf(t);
  const pid = liveHolder(t);
  await writeFile(lock, `${pid} other`);
  await assert.rejects(
    withFileLock(path, async () => {}, { timeout: 100 }),
    (e: Error) => e.message.includes(lock) && e.message.includes(`pid ${pid}`),
  );
  assert.equal(await readFile(lock, "utf8"), `${pid} other`);
});

test("withFileLock gives up on an empty lock (its holder died before writing it) and leaves the lock", async (t) => {
  const { path, lock } = await lockOf(t);
  await writeFile(lock, "");
  await assert.rejects(
    withFileLock(path, async () => {}, { timeout: 100 }),
    /an unknown holder/,
  );
  assert.equal(await readFile(lock, "utf8"), "");
});

test("the lock is re-entrant: secrets calls inside an update (or auth) don't wait on it, and nothing is lost", async (t) => {
  t.after(await tempHome({ secrets: { a: { type: "x", apiKey: "a1" }, b: { type: "x", apiKey: "b1" } } }));
  const lock = join(process.env.HOME ?? "", ".hortus", "secrets.json.lock");
  let outer = "";
  let escaped: Promise<string> | undefined;
  await updateSecret("a", async (e) => {
    outer = await readFile(lock, "utf8");
    // was a 60s timeout: the nested call waited on its own lock
    await updateSecret("b", (b) => b && { ...b, apiKey: "b2" });
    // started inside, run after the lock is released: takes it again rather than slipping in
    escaped = sleep(20).then(() => withFileLock(lock.slice(0, -5), () => readFile(lock, "utf8")));
    return e && { ...e, apiKey: "a2" };
  });
  assert.deepEqual(await loadSecrets(), { a: { type: "x", apiKey: "a2" }, b: { type: "x", apiKey: "b2" } });
  const again = await escaped;
  assert.ok(outer && again && again !== outer, `${outer} / ${again}`);
});

test("a callback from fn that fires while the lock is being released takes the lock rather than skipping it", async (t) => {
  const { path, lock } = await lockOf(t);
  let nested: Promise<string> | undefined;
  await withFileLock(path, async () => {
    // fires after fn returns, during unlock's awaits
    setImmediate(() => {
      // outlives the outer unlock: run unlocked, it would find the lock removed under it
      nested = withFileLock(path, () => sleep(20).then(() => readFile(lock, "utf8")));
    });
  });
  await new Promise((r) => setImmediate(r));
  assert.ok(nested);
  assert.match(await nested, /^\d+ /);
});
