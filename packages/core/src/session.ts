import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PHI_DIR } from "./config.ts";
import type { Message } from "./llm.ts";

export const sessionsDir = join(PHI_DIR, "sessions");

/** One jsonl line. Entries form a tree via parentId; a branch is the path from a leaf up to the root. */
export type SessionEntry = { v: 1; id: string; parentId: string | null } & EntryBody;
type EntryBody =
  | { type: "message"; message: Message }
  // snapshot of both settings; undefined = config default
  | { type: "model"; model?: string; provider?: string };

/** State rebuilt by replaying a branch's entries from the root down. */
export interface SessionState {
  messages: Message[];
  /** model picked with setModel on this branch; undefined = config default */
  model?: string;
  /** provider picked with setProvider on this branch; undefined = config default */
  provider?: string;
}

export interface Session extends SessionState {
  path: string;
  /** last entry of the current branch; new entries hang off it */
  leafId: string | null;
  append(msgs: Message[]): Promise<void>;
  setModel(model: string): Promise<void>;
  setProvider(provider: string): Promise<void>;
}

type Parser = { v: number; type: string; apply(entry: any, state: SessionState): void };

/** A line is replayed by the parser matching its v and type; lines no parser knows are skipped. */
const parsers: Parser[] = [
  { v: 1, type: "message", apply: (e: { message: Message }, s) => s.messages.push(e.message) },
  {
    v: 1,
    type: "model",
    apply: (e: { model?: string; provider?: string }, s) => {
      s.model = e.model;
      s.provider = e.provider;
    },
  },
];

// ponytail: plain JSON, binary parts (images/files) won't round-trip; add a reviver if tools return them
const parse = (text: string): SessionEntry[] =>
  text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/** State from replaying the root down to `leafId`. */
export function branch(entries: SessionEntry[], leafId: string): SessionState {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const path: SessionEntry[] = [];
  for (let e = byId.get(leafId); e; e = e.parentId === null ? undefined : byId.get(e.parentId)) path.push(e);
  const state: SessionState = { messages: [] };
  for (const e of path.reverse()) parsers.find((p) => p.v === e.v && p.type === e.type)?.apply(e, state);
  return state;
}

/** Last-appended entry id of a session. sessionId: uuid (or file name) to match, true = latest session */
export async function lastEntryId(sessionId: string | true) {
  // epoch prefix makes lexical order chronological
  const names = (await readdir(sessionsDir).catch(() => [])).filter((n) => n.endsWith(".jsonl")).sort();
  const found = sessionId === true ? names.at(-1) : names.find((n) => n.includes(sessionId));
  if (!found) throw new Error(sessionId === true ? "No sessions to resume" : `Session not found: ${sessionId}`);
  const last = parse(await readFile(join(sessionsDir, found), "utf8")).at(-1);
  if (!last) throw new Error(`Session is empty: ${found}`);
  return last.id;
}

/** id: entry to resume from (its session file is found by scanning), null = new session */
export async function openSession(id: string | null): Promise<Session> {
  await mkdir(sessionsDir, { recursive: true });
  let name = `${Math.floor(Date.now() / 1000)}_${randomUUID()}.jsonl`;
  let state: SessionState = { messages: [] };

  if (id !== null) {
    // epoch prefix makes lexical order chronological; newest first since recent entries are the likely target
    const names = (await readdir(sessionsDir))
      .filter((n) => n.endsWith(".jsonl"))
      .sort()
      .reverse();
    let found = false;
    // ponytail: linear scan of every session file; add an id -> file index if this gets slow
    for (const n of names) {
      const entries = parse(await readFile(join(sessionsDir, n), "utf8"));
      if (!entries.some((e) => e.id === id)) continue;
      name = n;
      state = branch(entries, id);
      found = true;
      break;
    }
    if (!found) throw new Error(`Entry not found: ${id}`);
  }

  const path = join(sessionsDir, name);
  const session: Session = {
    ...state,
    path,
    leafId: id,
    append: (msgs) => write(msgs.map((message) => ({ type: "message", message }))),
    setModel: async (model) => {
      session.model = model;
      await write([{ type: "model", model, provider: session.provider }]);
    },
    setProvider: async (provider) => {
      session.provider = provider;
      await write([{ type: "model", model: session.model, provider }]);
    },
  };
  async function write(items: EntryBody[]) {
    let lines = "";
    for (const item of items) {
      const entry: SessionEntry = { v: 1, id: randomUUID(), parentId: session.leafId, ...item };
      session.leafId = entry.id;
      lines += `${JSON.stringify(entry)}\n`;
    }
    await appendFile(path, lines);
  }
  return session;
}
