import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createStore, type StoreApi } from "zustand/vanilla";
import { HORTUS_DIR } from "./config.ts";
import type { Message } from "./llm.ts";

export const sessionsDir = join(HORTUS_DIR, "sessions");

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

/**
 * Read-only store of the current branch: `subscribe` reports every change along with the previous state.
 * Changes go through the methods below, which also append to the file, so state and file never drift apart.
 */
export interface Session extends Pick<StoreApi<SessionState>, "getState" | "getInitialState" | "subscribe"> {
  path: string;
  /** last entry of the current branch; new entries hang off it */
  leafId: string | null;
  /** adds to `messages` and the file */
  append(msgs: Message[]): Promise<void>;
  /** `provider` defaults to the current one; both go in one entry */
  setModel(model: string, provider?: string): Promise<void>;
  setProvider(provider: string): Promise<void>;
}

interface Parser {
  v: number;
  type: string;
  apply(entry: any, state: SessionState): void;
}

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

export interface SessionInfo {
  /** the uuid in the file name */
  id: string;
  path: string;
  /** last-appended entry, what `openSession` resumes from */
  leafId: string;
  /** first user message, for picking a session */
  title: string;
  created: Date;
}

/** Non-empty sessions in `dir`, newest first. */
export async function listSessions(dir = sessionsDir): Promise<SessionInfo[]> {
  // epoch prefix makes lexical order chronological
  const names = (await readdir(dir).catch(() => []))
    .filter((n) => n.endsWith(".jsonl"))
    .sort()
    .reverse();
  const out: SessionInfo[] = [];
  // ponytail: parses every session file in full; keep a title/leaf index if this gets slow
  for (const n of names) {
    const entries = parse(await readFile(join(dir, n), "utf8"));
    const leaf = entries.at(-1);
    if (!leaf) continue;
    const title = entries.find((e) => e.type === "message" && e.message.role === "user");
    const [epoch = "0", id = n] = n.slice(0, -".jsonl".length).split("_");
    out.push({
      id,
      path: join(dir, n),
      leafId: leaf.id,
      title: title?.type === "message" && title.message.role === "user" ? title.message.content : "",
      created: new Date(Number(epoch) * 1000),
    });
  }
  return out;
}

/** id: entry to resume from (its session file is found by scanning `dir`), null = new session */
export async function openSession(id: string | null, dir = sessionsDir): Promise<Session> {
  await mkdir(dir, { recursive: true });
  let name = `${Math.floor(Date.now() / 1000)}_${randomUUID()}.jsonl`;
  let state: SessionState = { messages: [] };

  if (id !== null) {
    // epoch prefix makes lexical order chronological; newest first since recent entries are the likely target
    const names = (await readdir(dir))
      .filter((n) => n.endsWith(".jsonl"))
      .sort()
      .reverse();
    let found = false;
    // ponytail: linear scan of every session file; add an id -> file index if this gets slow
    for (const n of names) {
      const entries = parse(await readFile(join(dir, n), "utf8"));
      if (!entries.some((e) => e.id === id)) continue;
      name = n;
      state = branch(entries, id);
      found = true;
      break;
    }
    if (!found) throw new Error(`Entry not found: ${id}`);
  }

  const path = join(dir, name);
  const store = createStore<SessionState>()(() => state);
  const session: Session = {
    getState: store.getState,
    getInitialState: store.getInitialState,
    subscribe: store.subscribe,
    path,
    leafId: id,
    append: (msgs) => {
      store.setState((s) => ({ messages: [...s.messages, ...msgs] }));
      return write(msgs.map((message) => ({ type: "message", message })));
    },
    setModel: (model, provider = store.getState().provider) => {
      store.setState({ model, provider });
      return write([{ type: "model", model, provider }]);
    },
    setProvider: (provider) => {
      store.setState({ provider });
      return write([{ type: "model", model: store.getState().model, provider }]);
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
