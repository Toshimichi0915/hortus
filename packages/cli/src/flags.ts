import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  childDir,
  EFFORTS,
  type Effort,
  type LoadOptions,
  listSessions,
  type Message,
  memorySession,
  type Named,
  newSession,
  openSession,
  type Plugin,
  type Session,
  sessionsDir,
} from "@hortus/core";

/** The command line: a mode (`-p`, `--rpc`, else the TUI) and the flags every mode shares, mirroring `subrun`'s options. */
export interface Flags {
  /** `-p`: one prompt without the TUI */
  print: boolean;
  /** with `-p`: every event as a JSON line */
  json: boolean;
  /** `--rpc`: JSON lines on stdin and stdout */
  rpc: boolean;
  /** `-r [id]`: resume that session (true: pick one) */
  resume?: string | true;
  provider?: string;
  model?: string;
  /** "auto": the session's effort is cleared (the provider's default) */
  effort?: Effort | "auto";
  /** a session id, "new" (default), "memory" or "key:<key>" */
  session?: string;
  /** `--parent <session id>` (`-p`/`--rpc`): this process's sessions are that one's children (see `flaggedSession`) */
  parent?: string;
  /** `--seed <file.json>`: messages (`Message[]`) appended to the session (new or empty) before anything runs */
  seed?: string;
  name?: string;
  cwd?: string;
  appendSystem?: string;
  disable: string[];
  only: string[];
  plugins: string[];
  tools: string[];
  /** the initial prompt (the positional arguments) */
  prompt?: string;
}

export const USAGE = `usage: hortus [-r [session_id]] [-p [--json] | --rpc] [options] [prompt]
  -p                    run the prompt without the TUI and exit (--json: every event as a JSON line)
  --rpc                 JSON-line commands on stdin, events on stdout
  --model <p>/<m>       --effort <auto|${EFFORTS.join("|")}>
  --session <id|new|memory|key:<key>>   --parent <session_id>   --seed <messages.json>   --name <title>   --cwd <dir>
  --append-system <text>
  --disable <plugin,...>   --only <plugin,...>   --plugin <path>   --tools <name,...>`;

const list = (v: string[] | undefined) => (v ?? []).flatMap((s) => s.split(",")).filter(Boolean);

/** Parses `argv` (without node and the script); throws a usage error. */
export function parseFlags(argv: string[]): Flags {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      p: { type: "boolean", short: "p" },
      json: { type: "boolean" },
      rpc: { type: "boolean" },
      r: { type: "boolean", short: "r" },
      model: { type: "string" },
      effort: { type: "string" },
      session: { type: "string" },
      parent: { type: "string" },
      seed: { type: "string" },
      name: { type: "string" },
      cwd: { type: "string" },
      "append-system": { type: "string" },
      disable: { type: "string", multiple: true },
      only: { type: "string", multiple: true },
      plugin: { type: "string", multiple: true },
      tools: { type: "string", multiple: true },
    },
  });
  // `-r <id>`: the first positional is the session
  const [id, ...rest] = v.r ? positionals : [undefined, ...positionals];
  const prompt = rest.join(" ");
  if (v.r && (v.p || v.rpc)) throw new Error("-r is for the TUI (use --session <id>)");
  if (v.p && v.rpc) throw new Error("-p and --rpc exclude each other");
  if (v.json && !v.p) throw new Error("--json needs -p");
  if (v.r && v.session) throw new Error("-r and --session exclude each other");
  if (v.parent !== undefined && !v.p && !v.rpc) throw new Error("--parent needs -p or --rpc");
  let provider: string | undefined;
  let model: string | undefined;
  if (v.model !== undefined) {
    [, provider, model] = v.model.match(/^([^/\s]+)\/(\S+)$/) ?? [];
    if (!provider || !model) throw new Error("--model needs <provider>/<model>");
  }
  if (v.effort !== undefined && v.effort !== "auto" && !EFFORTS.includes(v.effort as Effort))
    throw new Error(`--effort needs auto or one of ${EFFORTS.join(", ")}`);
  return {
    print: !!v.p,
    json: !!v.json,
    rpc: !!v.rpc,
    ...(v.r && { resume: id ?? true }),
    ...(provider && { provider, model }),
    ...(v.effort !== undefined && { effort: v.effort as Effort | "auto" }),
    ...(v.session !== undefined && { session: v.session }),
    ...(v.parent !== undefined && { parent: v.parent }),
    ...(v.seed !== undefined && { seed: resolve(v.seed) }),
    ...(v.name !== undefined && { name: v.name }),
    ...(v.cwd !== undefined && { cwd: resolve(v.cwd) }),
    ...(v["append-system"] !== undefined && { appendSystem: v["append-system"] }),
    disable: list(v.disable),
    only: list(v.only),
    plugins: (v.plugin ?? []).map((p) => resolve(p)),
    tools: list(v.tools),
    ...(prompt && { prompt }),
  };
}

/** The session id `key:<key>` stands for: a uuid-shaped hash of the key, so the same key always opens the same file. */
export function keyedId(key: string) {
  const h = createHash("sha256").update(`hortus-session:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * The session `--session` (or a resumed `id`) names: an id, "new" (default), "memory", or "key:<key>" (opened, else
 * created, by a stable key: renaming it doesn't lose it). With `parent` (`--parent`), file sessions are looked up and
 * made among that session's children (`childDir(parent)`), so listings of the top level skip them.
 */
export async function flaggedSession(session = "new", parent?: string): Promise<Session> {
  const dir = parent === undefined ? sessionsDir() : childDir(parent);
  if (session === "memory") return memorySession();
  if (session === "new") return openSession(null, dir);
  const key = session.startsWith("key:") ? session.slice(4) : undefined;
  if (key === "") throw new Error("--session key: needs a key");
  const id = key === undefined ? session : keyedId(key);
  const found = (await listSessions(dir)).find((s) => s.id === id);
  if (found) return openSession(found.leafId, dir);
  if (key === undefined) throw new Error(`Session not found: ${session}`);
  return newSession(dir, id);
}

/**
 * Applies `--model`, `--effort`, `--name` and `--cwd` to `session` (each written to it, as `/model` would, when it
 * changes something), then appends `--seed`'s messages (only to a session without messages: a seed isn't appended
 * twice). `check` sees the messages the session will have and may throw before anything is written.
 */
export async function applyFlags(session: Session, f: Flags, check?: (messages: Message[]) => void) {
  const s = session.getState();
  let seed: Message[] = [];
  if (f.seed) {
    const parsed: unknown = JSON.parse(await readFile(f.seed, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("--seed needs a JSON array of messages");
    if (s.messages.length) throw new Error("--seed needs a new or empty session");
    seed = parsed as Message[];
  }
  check?.([...s.messages, ...seed]);
  if (f.model && (s.model !== f.model || s.provider !== f.provider)) await session.setModel(f.model, f.provider);
  const effort = f.effort === "auto" ? undefined : f.effort;
  if (f.effort && s.effort !== effort) await session.setEffort(effort);
  if (f.name !== undefined && s.name !== f.name) await session.setName(f.name);
  if (f.cwd !== undefined && s.cwd !== f.cwd) await session.setCwd(f.cwd);
  if (seed.length) await session.append(seed);
}

/**
 * `LoadOptions` for the flags: `--disable`, `--only`, then the extras: `cli:flags` (`--tools` keeps only those tools in
 * every run's `run_start`; `--append-system` adds a prompt part) and each `--plugin` module (named by its path).
 */
export async function flagOptions(f: Flags): Promise<LoadOptions> {
  const flags: Plugin = {
    on: {
      run_start: (p) => {
        if (f.tools.length) p.tools.splice(0, Infinity, ...p.tools.filter((t) => f.tools.includes(t.name)));
      },
      prompt: (p) => {
        if (f.appendSystem) p.system.push(f.appendSystem);
      },
    },
  };
  const extra: Named[] = [{ name: "cli:flags", plugin: flags }];
  for (const path of f.plugins)
    extra.push({ name: path, plugin: (await import(pathToFileURL(path).href)).default as Plugin });
  return {
    ...(f.parent !== undefined && { parent: f.parent }),
    ...(f.disable.length && { disabled: f.disable }),
    ...(f.only.length && { only: f.only }),
    extra,
  };
}
