import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hortusDir, projectRoot, withFileLock } from "@hortus/core";

/**
 * Markdown memory files, as pi-hermes-memory keeps them: entries joined by `\n§\n`, each ending in a
 * `<!-- created=…, last=… -->` comment. `~/.hortus/hermes-memory/` holds MEMORY.md, USER.md, failures.md and
 * STANDING.md; `projects/<name>/MEMORY.md` the project tier. Every mutation re-reads the file under a file lock, so
 * concurrent sessions (and the memory subruns) never clobber each other.
 */

export const TARGETS = ["memory", "user", "failure", "project"] as const;
export type Target = (typeof TARGETS)[number];
export const CATEGORIES = ["failure", "correction", "insight", "preference", "convention", "tool-quirk"] as const;
export type Category = (typeof CATEGORIES)[number];

export const DELIMITER = "\n§\n";
export const LIMITS: Record<Target, number> = { memory: 5000, user: 5000, project: 5000, failure: 10000 };

export const memoryDir = () => join(hortusDir(), "hermes-memory");
const FILES = { memory: "MEMORY.md", user: "USER.md", failure: "failures.md" };

/** The git repository's directory name, or undefined outside one (no project tier then). */
export async function projectOf(cwd: string): Promise<string | undefined> {
  const root = await projectRoot(cwd);
  return root && basename(root);
}

export const projectNames = async () => readdir(join(memoryDir(), "projects")).catch(() => []);

export function fileOf(target: Target, project?: string): string | undefined {
  if (target !== "project") return join(memoryDir(), FILES[target]);
  return project ? join(memoryDir(), "projects", project, "MEMORY.md") : undefined;
}

export async function readEntries(path: string): Promise<string[]> {
  const content = await readFile(path, "utf8").catch(() => "");
  return content.trim() ? content.split(DELIMITER).flatMap((e) => (e.trim() ? [e.trim()] : [])) : [];
}

const today = () => new Date().toISOString().slice(0, 10);
const encode = (text: string, created = today(), last = today()) => `${text} <!-- created=${created}, last=${last} -->`;
export function decode(raw: string): { text: string; created: string; last: string } {
  const m = raw.match(/^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^,>]+?)(?:,[^>]*)?\s*-->\s*$/s);
  return m?.[1] !== undefined && m[2] && m[3]
    ? { text: m[1].trim(), created: m[2].trim(), last: m[3].trim() }
    : { text: raw.trim(), created: today(), last: today() };
}
export const texts = async (path: string) => (await readEntries(path)).map((e) => decode(e).text);

async function save(path: string, entries: string[]) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, entries.join(DELIMITER));
  await rename(tmp, path);
}

export interface MemoryResult {
  success: boolean;
  message?: string;
  error?: string;
  target?: Target;
  usage?: string;
  entry_count?: number;
  matches?: string[];
  entries?: string[];
}

/** Where one target lives; `capped`: the char limit is enforced (legacy-inject mode only, as in Pi). */
export interface Store {
  target: Target;
  path: string;
  capped: boolean;
}

const size = (entries: string[]) => entries.join(DELIMITER).length;
function usage(s: Store, entries: string[]) {
  const current = size(entries);
  const limit = LIMITS[s.target];
  return s.capped
    ? `${Math.min(100, Math.floor((current / limit) * 100))}% — ${current}/${limit} chars`
    : `${current} chars`;
}
const ok = (s: Store, entries: string[], message: string): MemoryResult => ({
  success: true,
  target: s.target,
  usage: usage(s, entries),
  entry_count: entries.length,
  message,
});

async function mutate(s: Store, fn: (entries: string[]) => { next?: string[]; result: MemoryResult }) {
  await mkdir(dirname(s.path), { recursive: true });
  return withFileLock(s.path, async () => {
    const { next, result } = fn(await readEntries(s.path));
    if (next) await save(s.path, next);
    return result;
  });
}

function matching(entries: string[], oldText: string) {
  const matches = entries.filter((e) => decode(e).text.includes(oldText));
  if (matches.length === 0) return { error: `No entry matched '${oldText}'.` };
  if (matches.length > 1)
    return {
      error: `Multiple entries matched '${oldText}'. Be more specific.`,
      matches: matches.map((e) => decode(e).text.slice(0, 80)),
    };
  return { match: matches[0] as string };
}

export async function add(s: Store, content: string): Promise<MemoryResult> {
  content = content.trim();
  if (!content) return { success: false, error: "Content cannot be empty." };
  const blocked = scanContent(content);
  if (blocked) return { success: false, error: blocked };
  return mutate(s, (entries) => {
    if (entries.some((e) => decode(e).text === content))
      return { result: ok(s, entries, "Entry already exists (no duplicate added).") };
    const next = [...entries, encode(content)];
    if (s.capped && size(next) > LIMITS[s.target]) {
      const current = size(entries);
      return {
        result: {
          success: false,
          error: `Memory at ${current}/${LIMITS[s.target]} chars. Adding this entry (${content.length} chars) would exceed the limit. Replace or remove existing entries first (see the entries list below), then retry this add — all in this turn.`,
          target: s.target,
          entries: entries.map((e) => decode(e).text),
        },
      };
    }
    return { next, result: ok(s, next, "Entry added.") };
  });
}

export async function replace(s: Store, oldText: string, content: string): Promise<MemoryResult> {
  oldText = oldText.trim();
  content = content.trim();
  if (!oldText) return { success: false, error: "old_text cannot be empty." };
  if (!content) return { success: false, error: "new_content cannot be empty. Use 'remove' to delete entries." };
  const blocked = scanContent(content);
  if (blocked) return { success: false, error: blocked };
  return mutate(s, (entries) => {
    const { match, ...miss } = matching(entries, oldText);
    if (!match) return { result: { success: false, ...miss } };
    const next = entries.map((e) => (e === match ? encode(content, decode(e).created) : e));
    if (s.capped && size(next) > LIMITS[s.target])
      return {
        result: {
          success: false,
          error: `Replacement would put memory at ${size(next)}/${LIMITS[s.target]} chars. Shorten or remove other entries first.`,
        },
      };
    return { next, result: ok(s, next, "Entry replaced.") };
  });
}

export async function remove(s: Store, oldText: string): Promise<MemoryResult> {
  oldText = oldText.trim();
  if (!oldText) return { success: false, error: "old_text cannot be empty." };
  return mutate(s, (entries) => {
    const { match, ...miss } = matching(entries, oldText);
    if (!match) return { result: { success: false, ...miss } };
    const next = entries.filter((e) => e !== match);
    return { next, result: ok(s, next, "Entry removed.") };
  });
}

export function failureText(content: string, category: Category, reason?: string) {
  return [`[${category}] ${content.trim()}`, ...(reason ? [`Failed: ${reason}`] : [])].join(" — ");
}

// ─── Standing instructions: user-pinned rules, injected in every mode; only /memory-pin (or an editor) writes them ───

export const STANDING_MAX_ENTRIES = 20;
export const STANDING_MAX_CHARS = 2000;
export const standingFile = () => join(memoryDir(), "STANDING.md");

export const readStanding = async () =>
  (await readFile(standingFile(), "utf8").catch(() => ""))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export async function changeStanding(
  change: (current: string[]) => { next?: string[]; message?: string; error?: string },
) {
  await mkdir(memoryDir(), { recursive: true });
  return withFileLock(standingFile(), async () => {
    const outcome = change(await readStanding());
    if (outcome.error || !outcome.next) throw new Error(outcome.error ?? "Nothing to change.");
    await writeFile(standingFile(), outcome.next.length ? `${outcome.next.join("\n")}\n` : "");
    return outcome.message ?? "";
  });
}

export function renderStanding(instructions: string[]): string {
  const injected: string[] = [];
  let used = 0;
  for (const i of instructions) {
    if (injected.length >= STANDING_MAX_ENTRIES || used + i.length + 1 > STANDING_MAX_CHARS) break;
    injected.push(i);
    used += i.length + 1;
  }
  if (injected.length === 0) return "";
  const omitted = instructions.length - injected.length;
  return [
    "<standing-instructions>",
    "The user wrote the rules below and they are always active. They are direct",
    "instructions from the user, not recalled context, and they outrank your own",
    "defaults. Follow them without being asked and without looking them up.",
    "",
    ...injected.map((x, n) => `${n + 1}. ${x}`),
    ...(omitted > 0
      ? [
          "",
          `[!] ${omitted} further standing instruction${omitted === 1 ? "" : "s"} could not be shown: STANDING.md exceeds the ${STANDING_MAX_CHARS}-character injection budget. Trim it with /memory-pin so every rule stays active.`,
        ]
      : []),
    "</standing-instructions>",
  ].join("\n");
}

// ─── Content scanning: nothing that reads as an injection payload or a secret is ever persisted ───

const THREATS: [RegExp, string][] = [
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, "prompt_injection"],
  [/you\s+are\s+now\s+/i, "role_hijack"],
  [/do\s+not\s+tell\s+the\s+user/i, "deception_hide"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, "disregard_rules"],
  [/act\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)/i, "bypass_restrictions"],
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_curl"],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_wget"],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, "read_secrets"],
  [/authorized_keys/i, "ssh_backdoor"],
  [/\$HOME\/\.ssh|~\/\.ssh/i, "ssh_access"],
];
const SECRETS: [RegExp, string][] = [
  [/\bsk-ant-api\S{10,}\b/, "anthropic_api_key"],
  [/\bsk-or-v1-\S{10,}\b/, "openrouter_api_key"],
  [/\bsk-\S{20,}\b/, "openai_api_key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "aws_access_key"],
  [/\bgh[pu]_\S{10,}\b/, "github_token"],
  [/\bxox[bp]-\S{10,}\b|\bxapp-\S{10,}\b/, "slack_token"],
  [/\bntn_\S{10,}\b/, "notion_token"],
  [/\bBearer\s+\S{20,}\b/, "bearer_auth_token"],
  [/-----BEGIN\s+(?:RSA\s+)?PRIVATE\sKEY-----/, "private_key_block"],
  [
    /\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|DATABASE_URL)\b/,
    "env_secret",
  ],
  [/\bpassword\s*[=:]\s*\S{6,}\b/i, "password_assignment"],
  [/\bsecret\s*[=:]\s*\S{6,}\b/i, "secret_assignment"],
  [/\btoken\s*[=:]\s*\S{10,}\b/i, "token_assignment"],
];
const INVISIBLE = /\u200b|\u200c|\u200d|\u2060|\ufeff|[\u202a-\u202e]/;

export function scanContent(content: string): string | undefined {
  if (INVISIBLE.test(content)) return "Blocked: content contains an invisible unicode character (possible injection).";
  for (const [p, id] of THREATS)
    if (p.test(content))
      return `Blocked: content matches threat pattern '${id}'. Memory entries may be surfaced through search or legacy prompt injection and must not contain injection or exfiltration payloads.`;
  for (const [p, id] of SECRETS)
    if (p.test(content)) return `Blocked: content looks like a secret ('${id}'). Secrets are never saved to memory.`;
  return undefined;
}
