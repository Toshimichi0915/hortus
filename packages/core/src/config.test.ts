import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// HORTUS_DIR comes from the home directory when the module loads; each test file runs in its own process
process.env.HOME = await mkdtemp(join(tmpdir(), "hortus-"));
const { HORTUS_DIR, loadConfig } = await import("./config.ts");
const { loadSecrets } = await import("./secrets.ts");

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
