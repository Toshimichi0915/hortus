import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "./llm.ts";
import { KANAI_DIR } from "./config.ts";

export const sessionsDir = join(KANAI_DIR, "sessions");

/** resume: true = latest session, string = session uuid (or file name), undefined = new session */
export async function openSession(resume?: string | true) {
  await mkdir(sessionsDir, { recursive: true });
  let name = `${Math.floor(Date.now() / 1000)}_${randomUUID()}.jsonl`;
  let messages: Message[] = [];

  if (resume) {
    // epoch prefix makes lexical order chronological
    const names = (await readdir(sessionsDir)).filter((n) => n.endsWith(".jsonl")).sort();
    const found = resume === true ? names.at(-1) : names.find((n) => n.includes(resume));
    if (!found) throw new Error(resume === true ? "No sessions to resume" : `Session not found: ${resume}`);
    name = found;
    const text = await readFile(join(sessionsDir, name), "utf8");
    // ponytail: plain JSON, binary parts (images/files) won't round-trip; add a reviver if tools return them
    messages = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  const path = join(sessionsDir, name);
  return {
    path,
    messages,
    append: (msgs: Message[]) => appendFile(path, msgs.map((m) => `${JSON.stringify(m)}\n`).join("")),
  };
}
