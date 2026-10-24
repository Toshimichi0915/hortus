import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { HORTUS_DIR } from "./config.ts";

const SecretSchema = z
  .object({
    /** name of a plugin provider, e.g. "openai" */
    type: z.string(),
    apiKey: z.string(),
    /** base URL override, e.g. "https://openrouter.ai/api/v1" */
    endpoint: z.string().optional(),
  })
  .optional();

// keyed by the name users select with config.provider / /model, e.g. { openrouter: { type: "openai", ... } }
export const SecretsSchema = z.record(z.string(), SecretSchema);
export type Secrets = z.infer<typeof SecretsSchema>;

export async function loadSecrets(): Promise<Secrets> {
  try {
    return SecretsSchema.parse(await JSON.parse(await readFile(join(HORTUS_DIR, "secrets.json"), "utf8")));
  } catch (e) {
    if (e instanceof z.ZodError || (e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

export async function saveSecrets(data: Secrets) {
  await mkdir(HORTUS_DIR, { recursive: true, mode: 0o700 });
  const path = join(HORTUS_DIR, "secrets.json");
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
