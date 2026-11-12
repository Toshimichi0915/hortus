import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createStore, type StoreApi } from "zustand/vanilla";
import { hortusDir } from "./config.ts";
import { addUsage, type Effort, type Image, type Message, type ToolResult, type Usage } from "./llm.ts";

export const sessionsDir = () => join(hortusDir(), "sessions");

/** One jsonl line. Entries form a tree via parentId; a branch is the path from a leaf up to the root. */
export type SessionEntry = { v: 1; id: string; parentId: string | null } & EntryBody;
type EntryBody =
  // stored without its `entryId` (the entry's own id)
  | { type: "message"; message: Message }
  // snapshot of the three settings; undefined = config default
  | { type: "model"; model?: string; provider?: string; effort?: Effort }
  | { type: "name"; name: string }
  // the working directory runs on the session use (`Session.setCwd`)
  | { type: "cwd"; cwd: string }
  // tokens spent outside its messages: a subrun started outside a tool (`Session.addUsage`)
  | { type: "usage"; usage: Usage }
  // a plugin's, `<plugin>:<type>`, replayed by its `Plugin.entries`
  | { type: `${string}:${string}`; data: unknown };

/** A plugin's entry (`appendEntry`), as its `Plugin.entries` reducer gets it; `T` is its `data`. */
export interface PluginEntry<T = unknown> {
  v: 1;
  id: string;
  parentId: string | null;
  type: `${string}:${string}`;
  data: T;
}

/** Replays plugin entries by their full type (`<plugin>:<type>`); the agent builds them from `Plugin.entries`. */
export type Reducers = Record<string, (entry: PluginEntry, state: SessionState) => void>;

/** State rebuilt by replaying a branch's entries from the root down. */
export interface SessionState {
  /** each with its `entryId` */
  messages: Message[];
  /** model picked with setModel on this branch; undefined = config default */
  model?: string;
  /** provider picked with setProvider on this branch; undefined = config default */
  provider?: string;
  /** effort picked with setEffort on this branch; undefined = the host's default */
  effort?: Effort;
  /** the session's title, from setName */
  name?: string;
  /** the working directory its runs use (`setCwd`); the agent records the first run's */
  cwd?: string;
  /** tokens spent outside its messages (`addUsage`: subruns not started from a tool), summed */
  usage?: Usage;
  /** plugins' state, rebuilt from their entries (see `Plugin.entries`) */
  data: Record<string, unknown>;
}

/**
 * Read-only store of the current branch: `subscribe` reports every change along with the previous state.
 * Changes go through the methods below, which also append to the file, so state and file never drift apart.
 */
export interface Session extends Pick<StoreApi<SessionState>, "getState" | "getInitialState" | "subscribe"> {
  /** the uuid in the file name */
  id: string;
  /** undefined for an in-memory session (`memorySession`) */
  path?: string;
  /** last entry of the current branch; new entries hang off it */
  leafId: string | null;
  /** the branch's entries, root first (messages as replay reads them: upgraded to the current format) */
  entries(): SessionEntry[];
  /**
   * every entry of every branch, in the order they were written (once written), upgraded like `entries()`: the file's
   * lines (a crash's cut-short one skipped); an in-memory session's are its branch's
   */
  allEntries(): Promise<SessionEntry[]>;
  /** adds to `messages` and the file; resolves (once written) with them as saved, each with its `entryId` */
  append(msgs: Message[]): Promise<Message[]>;
  /**
   * a plugin's entry (`type` is `<plugin>:<type>`), replayed into `data` by its reducer; resolves with its id (once
   * written). The reducer has run, and `getState()` shows it, before this returns: a read of the state and the append
   * it computes, with no `await` between them, is atomic (no other append can land in between). `data` goes through
   * JSON first, so the reducer sees live what it sees on replay (no undefined fields, Dates as strings).
   */
  appendEntry(type: `${string}:${string}`, data: unknown): Promise<string>;
  /** `provider` defaults to the current one; model, provider and effort go in one entry */
  setModel(model: string, provider?: string): Promise<void>;
  setProvider(provider: string): Promise<void>;
  setEffort(effort: Effort | undefined): Promise<void>;
  setName(name: string): Promise<void>;
  /** the working directory its runs use from then on (`ctx.run.cwd`); a plugin switching into a worktree sets it */
  setCwd(cwd: string): Promise<void>;
  /** adds to `usage`, the tokens spent outside the messages */
  addUsage(usage: Usage): Promise<void>;
  /** replays the branch with `reducers` (the agent's, when it runs on the session) unless they are the ones it has */
  replay(reducers: Reducers): void;
}

interface Parser {
  v: number;
  type: string;
  apply(entry: any, state: SessionState): void;
}

/**
 * Session files keep what they were written with: `usage.cacheRead` was once `cached`, and a tool result's `images`
 * was once one `image`.
 */
function upgrade(m: Message): Message {
  if (m.role === "tool" && m.results.some((r) => "image" in r))
    return {
      ...m,
      results: m.results.map((r) => {
        if (!("image" in r)) return r;
        const { image, ...rest } = r as ToolResult & { image: Image };
        return { ...rest, images: [image] };
      }),
    };
  if (m.role !== "assistant" || !m.usage || !("cached" in m.usage)) return m;
  const { cached, ...usage } = m.usage as Usage & { cached: number };
  return { ...m, usage: { ...usage, cacheRead: cached } };
}

const upgradeEntry = (e: SessionEntry): SessionEntry =>
  e.type === "message" ? { ...e, message: upgrade(e.message) } : e;

/** A line is replayed by the parser matching its v and type; lines no parser knows are skipped. */
const parsers: Parser[] = [
  {
    v: 1,
    type: "message",
    apply: (e: { id: string; message: Message }, s) => s.messages.push({ ...upgrade(e.message), entryId: e.id }),
  },
  {
    v: 1,
    type: "model",
    apply: (e: { model?: string; provider?: string; effort?: Effort }, s) => {
      s.model = e.model;
      s.provider = e.provider;
      s.effort = e.effort;
    },
  },
  {
    v: 1,
    type: "name",
    apply: (e: { name: string }, s) => {
      s.name = e.name;
    },
  },
  {
    v: 1,
    type: "cwd",
    apply: (e: { cwd: string }, s) => {
      s.cwd = e.cwd;
    },
  },
  {
    v: 1,
    type: "usage",
    apply: (e: { usage: Usage }, s) => {
      s.usage = addUsage(s.usage, e.usage);
    },
  },
];

/** Applies `e` to `state`: a core parser, else the plugin reducer for its type; lines neither knows are skipped. */
function apply(e: SessionEntry, state: SessionState, reducers: Reducers) {
  const parser = parsers.find((p) => p.v === e.v && p.type === e.type);
  if (parser) parser.apply(e, state);
  else if (e.v === 1 && Object.hasOwn(reducers, e.type)) reducers[e.type]?.(e as PluginEntry, state);
}

/** The entries from the root down to `leafId`. */
function pathTo(entries: SessionEntry[], leafId: string): SessionEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const path: SessionEntry[] = [];
  for (let e = byId.get(leafId); e; e = e.parentId === null ? undefined : byId.get(e.parentId)) path.push(e);
  return path.reverse();
}

const replayPath = (path: SessionEntry[], reducers: Reducers): SessionState => {
  const state: SessionState = { messages: [], data: {} };
  for (const e of path) apply(e, state, reducers);
  return state;
};

// ponytail: plain JSON, binary parts (images/files) won't round-trip; add a reviver if tools return them
const parse = (text: string): SessionEntry[] =>
  text.split("\n").flatMap((line) => {
    // a line cut short by a crash mid-write is skipped, like one no parser knows
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });

/** State from replaying the root down to `leafId`; plugin entries through `reducers`. */
export const branch = (entries: SessionEntry[], leafId: string, reducers: Reducers = {}): SessionState =>
  replayPath(pathTo(entries, leafId), reducers);

export interface SessionInfo {
  /** the uuid in the file name */
  id: string;
  path: string;
  /** last-appended entry, what `openSession` resumes from */
  leafId: string;
  /** its name (the last `name` entry), else its first user message, for picking a session */
  title: string;
  /** the working directory it last recorded (`setCwd`), if any */
  cwd?: string;
  created: Date;
}

/**
 * The state of the session file at `path` (a `SessionInfo.path`) on the branch ending at `leafId` (default its last
 * entry), without opening it: nothing is written, and the agent's current session is untouched.
 */
export async function readSession(path: string, leafId?: string, reducers: Reducers = {}): Promise<SessionState> {
  const entries = parse(await readFile(path, "utf8"));
  const leaf = leafId ?? entries.at(-1)?.id;
  return replayPath(leaf ? pathTo(entries, leaf) : [], reducers);
}

/**
 * Non-empty sessions in `dir` (default `sessionsDir()`), newest first. Child sessions (file-backed subruns) live in a
 * directory named after their parent's id, so they are only listed with `{ parent }`: that session's children.
 */
export async function listSessions(where: string | { dir?: string; parent?: string } = {}): Promise<SessionInfo[]> {
  const { dir: root = sessionsDir(), parent } = typeof where === "string" ? { dir: where } : where;
  const dir = parent ? childDir(parent, root) : root;
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
    const first = entries.find((e) => e.type === "message" && e.message.role === "user" && !e.message.meta);
    const name = entries.filter((e) => e.type === "name").at(-1);
    const cwd = entries.filter((e) => e.type === "cwd").at(-1);
    const [epoch = "0", id = n] = n.slice(0, -".jsonl".length).split("_");
    out.push({
      id,
      path: join(dir, n),
      leafId: leaf.id,
      title:
        name?.type === "name"
          ? name.name
          : first?.type === "message" && first.message.role === "user"
            ? first.message.content
            : "",
      ...(cwd?.type === "cwd" && { cwd: cwd.cwd }),
      created: new Date(Number(epoch) * 1000),
    });
  }
  return out;
}

/** Where the file-backed children of session `parent` (its id) live: a directory of their own, so lists skip them. */
export const childDir = (parent: string, dir = sessionsDir()) => join(dir, parent);

/**
 * Where session `id` sits in the tree of sessions under `dir`: `depth` 0 for a top-level file, one more for each
 * `childDir` it is nested in (a child's file is in its parent's), and `root`, the top-level session's id. A session with
 * no file (in memory, or not written yet) counts as top-level.
 */
export async function sessionLineage(id: string, dir = sessionsDir()): Promise<{ depth: number; root: string }> {
  const ids = new Set<string>();
  /** the parent of the session whose file is `<epoch>_<id>.jsonl`: the child dir it's in, if any */
  const files = new Map<string, string | undefined>();
  const scan = async (d: string, parent?: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const m = e.isFile() ? e.name.match(/^\d+_(.+)\.jsonl$/) : null;
      if (m?.[1]) files.set(m[1], parent);
    }
  };
  await scan(dir);
  // ponytail: reads every child dir once; index lineage if session trees get large
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => []))
    if (e.isDirectory()) await scan(join(dir, e.name), e.name);
  let root = id;
  let depth = 0;
  for (let up = files.get(id); up !== undefined && !ids.has(up); up = files.get(up)) {
    ids.add(up);
    root = up;
    depth++;
  }
  return { depth, root };
}

/** A new session file in `dir` (created, with the dir, on its first write), with id `id` (default a random uuid). */
export const newSession = (dir = sessionsDir(), id: string = randomUUID()): Session =>
  makeSession(join(dir, `${Math.floor(Date.now() / 1000)}_${id}.jsonl`), []);

/** id: entry to resume from (its session file is found by scanning `dir`), null = new session */
export async function openSession(id: string | null, dir = sessionsDir()): Promise<Session> {
  await mkdir(dir, { recursive: true });
  if (id === null) return newSession(dir);
  // epoch prefix makes lexical order chronological; newest first since recent entries are the likely target
  const names = (await readdir(dir))
    .filter((n) => n.endsWith(".jsonl"))
    .sort()
    .reverse();
  // ponytail: linear scan of every session file; add an id -> file index if this gets slow
  for (const n of names) {
    const text = await readFile(join(dir, n), "utf8");
    const entries = parse(text);
    if (!entries.some((e) => e.id === id)) continue;
    // ends a line cut short by a crash, so the next entry doesn't join it
    return makeSession(join(dir, n), pathTo(entries, id), text.endsWith("\n") ? "" : "\n");
  }
  throw new Error(`Entry not found: ${id}`);
}

/** A session kept in memory only (nothing is written), e.g. for a run without one. */
export const memorySession = (): Session => makeSession(undefined, []);

/** A session on `path` (none: in memory) whose branch is `path`, written to with `lead` first. */
function makeSession(path: string | undefined, branchPath: SessionEntry[], lead = ""): Session {
  let reducers: Reducers = {};
  const store = createStore<SessionState>()(() => replayPath(branchPath, reducers));
  // one write at a time, so entries land in the order they were made
  let writing: Promise<unknown> = Promise.resolve();
  let made: Promise<unknown> | undefined;
  const session: Session = {
    getState: store.getState,
    getInitialState: store.getInitialState,
    subscribe: store.subscribe,
    id: path ? (basename(path, ".jsonl").split("_")[1] ?? basename(path)) : randomUUID(),
    ...(path && { path }),
    leafId: branchPath.at(-1)?.id ?? null,
    entries: () => branchPath.map(upgradeEntry),
    allEntries: async () => {
      if (!path) return branchPath.map(upgradeEntry);
      // what was appended so far is written first; a new session's file may not exist yet
      await writing;
      return parse(await readFile(path, "utf8").catch(() => "")).map(upgradeEntry);
    },
    append: async (msgs) => {
      const entries = add(msgs.map(({ entryId: _, ...message }) => ({ type: "message", message }) as const));
      const saved = msgs.map((m, i) => ({ ...m, entryId: entries[i]?.id }));
      store.setState((s) => ({ messages: [...s.messages, ...saved] }));
      await write(entries);
      return saved;
    },
    appendEntry: async (type, data) => {
      // as replay will see it: JSON (undefined fields gone, Dates as strings), not the caller's object
      const [entry] = add([{ type, data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)) }]);
      if (!entry) throw new Error("unreachable");
      const next = { ...store.getState(), data: { ...store.getState().data } };
      apply(entry, next, reducers);
      store.setState(next, true);
      await write([entry]);
      return entry.id;
    },
    setModel: (model, provider = store.getState().provider) => settings({ model, provider }),
    setProvider: (provider) => settings({ provider }),
    setEffort: (effort) => settings({ effort }),
    setName: async (name) => {
      store.setState({ name });
      await write(add([{ type: "name", name }]));
    },
    setCwd: async (cwd) => {
      store.setState({ cwd });
      await write(add([{ type: "cwd", cwd }]));
    },
    addUsage: async (usage) => {
      store.setState((s) => ({ usage: addUsage(s.usage, usage) }));
      await write(add([{ type: "usage", usage }]));
    },
    replay: (r) => {
      if (r === reducers) return;
      reducers = r;
      store.setState(replayPath(branchPath, reducers), true);
    },
  };
  /** One `model` entry with the settings as they are, changed by `change`. */
  async function settings(change: Pick<SessionState, "model" | "provider" | "effort">) {
    const { model, provider, effort } = { ...store.getState(), ...change };
    // all three, as replaying the entry sets them
    store.setState({ model, provider, effort });
    await write(add([{ type: "model", model, provider, effort }]));
  }
  /** Entries for `items`, hanging off the leaf in turn, added to the branch. */
  function add(items: EntryBody[]): SessionEntry[] {
    return items.map((item) => {
      const entry = { v: 1, id: randomUUID(), parentId: session.leafId, ...item } as SessionEntry;
      session.leafId = entry.id;
      branchPath.push(entry);
      return entry;
    });
  }
  function write(entries: SessionEntry[]): Promise<void> {
    if (!path) return Promise.resolve();
    const lines = lead + entries.map((e) => `${JSON.stringify(e)}\n`).join("");
    lead = "";
    const done = writing.then(async () => {
      // a `newSession`'s dir may not exist yet
      made ??= mkdir(dirname(path), { recursive: true });
      await made;
      await appendFile(path, lines);
    });
    writing = done.catch(() => {});
    return done;
  }
  return session;
}
