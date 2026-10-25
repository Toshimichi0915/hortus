import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { EFFORTS } from "./llm.ts";

export const HORTUS_DIR = join(homedir(), ".hortus");

export const ConfigSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  /** the CLI's initial effort; `/effort` and shift+tab save it here */
  effort: z.enum(EFFORTS).optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(): Promise<Config> {
  const path = join(HORTUS_DIR, "config.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  // thrown, not read as empty: saving over an invalid file would lose the rest of it
  try {
    return ConfigSchema.parse(JSON.parse(text));
  } catch (e) {
    throw new Error(`Invalid ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function saveConfig(data: Config) {
  await mkdir(HORTUS_DIR, { recursive: true, mode: 0o700 });
  const path = join(HORTUS_DIR, "config.json");
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644 });
  await chmod(path, 0o644);
}
