import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { EFFORTS } from "./llm.ts";

/** `~/.hortus`, read from `HOME` on every call, so tests can point it elsewhere (see `testing.ts`). */
export const hortusDir = () => join(homedir(), ".hortus");

export const ConfigSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  /** the CLI's initial effort; `/effort` and shift+tab save it here */
  effort: z.enum(EFFORTS).optional(),
  /** old: `false` is read as `disabledPlugins: ["builtin:codemode"]` (and saved that way) */
  codemode: z.boolean().optional(),
  /** the TUI's theme, by name (its own, or a plugin's `cli.themes`); `/theme` saves it */
  theme: z.string().optional(),
  /** plugins not to load, by name: built-in pieces (`builtin:bash`, `cli:effort`) or directory plugins */
  disabledPlugins: z.array(z.string()).optional(),
  /**
   * builtin:compaction: `enabled` (default true) turns automatic compaction on, when the context passes the window
   * less `reserve` tokens (default 16384) or overflows; it keeps about `keepRecent` tokens of recent messages (20000)
   */
  compaction: z
    .object({ enabled: z.boolean().optional(), reserve: z.number().optional(), keepRecent: z.number().optional() })
    .optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(): Promise<Config> {
  const path = join(hortusDir(), "config.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  // thrown, not read as empty: saving over an invalid file would lose the rest of it
  let config: Config;
  try {
    config = ConfigSchema.parse(JSON.parse(text));
  } catch (e) {
    throw new Error(`Invalid ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { codemode, ...rest } = config;
  if (codemode !== false) return rest;
  return { ...rest, disabledPlugins: [...new Set([...(rest.disabledPlugins ?? []), "builtin:codemode"])] };
}

/** Replaces config.json (mode 0644) in one rename, so a reader (another hortus starting) never sees half of it. */
export async function saveConfig(data: Config) {
  await mkdir(hortusDir(), { recursive: true, mode: 0o700 });
  const path = join(hortusDir(), "config.json");
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644 });
  await chmod(tmp, 0o644);
  await rename(tmp, path);
}
