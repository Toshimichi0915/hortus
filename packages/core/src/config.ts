import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod";

export const PHI_DIR = join(homedir(), ".phi");

export const ConfigSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  /** plugin module paths, relative to ~/.phi */
  plugins: z.array(z.string()).optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(): Promise<Config> {
  try {
    return ConfigSchema.parse(await JSON.parse(await readFile(join(PHI_DIR, "config.json"), "utf8")));
  } catch (e) {
    if (e instanceof z.ZodError || (e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

export async function saveConfig(data: Config) {
  await mkdir(PHI_DIR, { recursive: true, mode: 0o700 });
  const path = join(PHI_DIR, "config.json");
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644 });
  await chmod(path, 0o644);
}
