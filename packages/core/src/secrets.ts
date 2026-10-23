import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { PHI_DIR } from "./config.ts";

const ApiKeySchema = z
  .object({
    apiKey: z.string(),
    expires: z.string().optional(),
  })
  .optional();

export const SecretsSchema = z.object({
  openrouter: ApiKeySchema,
  openai: ApiKeySchema,
  anthropic: ApiKeySchema,
});
export type Secrets = z.infer<typeof SecretsSchema>;

export async function loadSecrets(): Promise<Secrets> {
  try {
    return SecretsSchema.parse(await JSON.parse(await readFile(join(PHI_DIR, "secrets.json"), "utf8")));
  } catch (e) {
    if (e instanceof z.ZodError || (e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

export async function saveSecrets(data: Secrets) {
  await mkdir(PHI_DIR, { recursive: true, mode: 0o700 });
  const path = join(PHI_DIR, "secrets.json");
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
