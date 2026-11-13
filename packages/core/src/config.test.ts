import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { hortusDir, loadConfig, saveConfig } from "./config.ts";
import { loadSecrets } from "./secrets.ts";

// not tempHome, which writes config and secrets: this test starts without them
const HOME = await mkdtemp(join(tmpdir(), "hortus-"));
process.env.HOME = HOME;
delete process.env.HORTUS_HOME;
after(() => rm(HOME, { recursive: true, force: true }));
const HORTUS_DIR = hortusDir();

test("HORTUS_HOME overrides ~/.hortus", () => {
  process.env.HORTUS_HOME = "/elsewhere";
  try {
    assert.equal(hortusDir(), "/elsewhere");
  } finally {
    delete process.env.HORTUS_HOME;
  }
  assert.equal(hortusDir(), join(HOME, ".hortus"));
});

test("missing files read as empty, invalid ones throw instead of reading as empty", async () => {
  assert.deepEqual(await loadConfig(), {});
  assert.deepEqual(await loadSecrets(), {});
  await mkdir(HORTUS_DIR, { recursive: true });
  const config = '{ "provider": "p", "model": "m", "effort": "auto" }';
  await writeFile(join(HORTUS_DIR, "config.json"), config);
  await assert.rejects(loadConfig(), /Invalid .*config\.json/);
  await writeFile(join(HORTUS_DIR, "secrets.json"), '{ "a": { "apiKey": "k" } }');
  await assert.rejects(loadSecrets(), /Invalid .*secrets\.json/);
  await writeFile(join(HORTUS_DIR, "secrets.json"), "{");
  await assert.rejects(loadSecrets(), /Invalid .*secrets\.json/);
  // untouched, so nothing in it is lost
  assert.equal(await readFile(join(HORTUS_DIR, "config.json"), "utf8"), config);
});

test("saveConfig replaces config.json whole, mode 0644, leaving no temp file", async () => {
  await saveConfig({ provider: "a", model: "b" });
  // readers racing a save see the old file or the new one, never a truncated one
  const saves = (async () => {
    for (let i = 0; i < 20; i++) await saveConfig({ provider: "a", model: `m${i}` });
  })();
  for (let i = 0; i < 20; i++) assert.equal((await loadConfig()).provider, "a");
  await saves;
  assert.equal((await stat(join(HORTUS_DIR, "config.json"))).mode & 0o777, 0o644);
  assert.deepEqual(
    (await readdir(HORTUS_DIR)).filter((f) => f.startsWith("config")),
    ["config.json"],
  );
});
