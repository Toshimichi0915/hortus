/** Helpers for whole-run tests of hortus and its plugins: `@hortus/core/testing`. */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Config } from "./config.ts";
import type {
  AssistantMessage,
  CompleteCallbacks,
  CompletionRequest,
  Ctx,
  Events,
  Plugin,
  Provider,
  ProviderDef,
  ToolCtx,
} from "./llm.ts";
import type { McpConfig } from "./mcp.ts";
import type { Secrets } from "./secrets.ts";

/** A new temp dir, removed after test `t`. */
export async function tempDir(t: { after(fn: () => unknown): void }, prefix = "hortus-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

/** Polls `cond` every 5ms until it holds; throws after `ms`. */
export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  for (const end = Date.now() + ms; !cond(); await new Promise((r) => setTimeout(r, 5)))
    if (Date.now() > end) throw new Error("until: condition not met in time");
}

/**
 * One scripted model turn; missing fields default to no text and no tool calls. A function gets the request, the
 * caller's ctx and the callbacks (e.g. to stream text before an abort), and may be async (e.g. to wait for `req.signal`).
 */
export type Turn =
  | Partial<AssistantMessage>
  | ((
      req: CompletionRequest,
      ctx?: Ctx,
      callbacks?: CompleteCallbacks,
    ) => Partial<AssistantMessage> | Promise<Partial<AssistantMessage>>);

/**
 * A provider whose `complete` answers with `turns` in order, streaming each turn's text through `callbacks.text`, and
 * throws once they run out. `requests` records every request, with `messages` copied as they were then, without their
 * `entryId` (which, like every provider, it doesn't send).
 */
export function scripted(turns: Turn[]): ProviderDef & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  const provider: Provider = {
    async complete(req, callbacks = {}, ctx) {
      requests.push({ ...req, messages: req.messages.map(({ entryId: _, ...m }) => m) });
      const turn = turns[requests.length - 1];
      if (!turn) throw new Error(`scripted: no turn left for request ${requests.length}`);
      const message: AssistantMessage = {
        role: "assistant",
        text: "",
        toolCalls: [],
        ...(typeof turn === "function" ? await turn(req, ctx, callbacks) : turn),
      };
      if (message.text) callbacks.text?.(message.text);
      return message;
    },
    listModels: async () => ["scripted"],
  };
  return { create: () => provider, requests };
}

export interface HomeFiles {
  /** default: `{ provider: "scripted", model: "scripted" }` */
  config?: Config;
  /** default: `{ scripted: { type: "scripted", apiKey: "scripted" } }`, for a `scripted` provider passed in `extra` */
  secrets?: Secrets;
  mcp?: McpConfig;
  /** plugin dir name -> a directory to link there (a plugin on disk) or its files */
  plugins?: Record<string, string | Record<string, string>>;
}

/**
 * Points `HOME` at a fresh temp dir and writes `~/.hortus` from `files`. Returns a cleanup that restores `HOME` and
 * deletes the dir. `HOME` is process-wide, so tests using it must not run concurrently within one file.
 */
export async function tempHome(files: HomeFiles = {}): Promise<() => Promise<void>> {
  const prev = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "hortus-home-"));
  const dir = join(home, ".hortus");
  const write = async (path: string, content: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  const json = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;
  await write(join(dir, "config.json"), json(files.config ?? { provider: "scripted", model: "scripted" }));
  await write(join(dir, "secrets.json"), json(files.secrets ?? { scripted: { type: "scripted", apiKey: "scripted" } }));
  if (files.mcp) await write(join(dir, "mcp.json"), json(files.mcp));
  for (const [name, plugin] of Object.entries(files.plugins ?? {})) {
    const pluginDir = join(dir, "plugins", name);
    if (typeof plugin === "string") {
      await mkdir(dirname(pluginDir), { recursive: true });
      // linked, not copied: its imports (`@hortus/core`, ...) resolve from its real path, to the same modules as the test's
      await symlink(resolve(plugin), pluginDir, "dir");
    } else {
      for (const [file, content] of Object.entries(plugin)) await write(join(pluginDir, file), content);
    }
  }
  process.env.HOME = home;
  return async () => {
    process.env.HOME = prev;
    await rm(home, { recursive: true, force: true });
  };
}

export interface Recorded {
  name: keyof Events;
  payload: unknown;
}

/** A plugin (pass it in `extra`) that logs every event it sees, with a clone of its payload, in order. */
export function record(): Plugin & { events: Recorded[] } {
  const events: Recorded[] = [];
  const clone = (p: unknown) => {
    try {
      return structuredClone(p);
    } catch {
      return p; // e.g. a payload holding functions
    }
  };
  // a proxy, so events added later are recorded too
  const on = new Proxy(
    {},
    { get: (_, name) => (p: unknown) => void events.push({ name: name as keyof Events, payload: clone(p) }) },
  );
  return { on, events };
}

/**
 * A `ToolCtx` for calling a tool's `execute` directly: call id "test", a signal never aborted, no-op `update`, the
 * global `fetch`, the process's cwd, plus `overrides`. Anything else (`secrets`, `runTool`, ...) is missing unless overridden.
 */
export const toolCtx = (overrides: Partial<ToolCtx> = {}): ToolCtx =>
  ({
    callId: "test",
    signal: new AbortController().signal,
    cwd: process.cwd(),
    update: () => {},
    fetch,
    ...overrides,
  }) as ToolCtx;

/**
 * A directory plugin's files providing the `scripted` provider with `turns`, the JS source of a `Turn[]` (functions
 * allowed), for a spawned hortus process: `tempHome({ plugins: { scripted: scriptedPlugin("[{ text: 'hi' }]") } })`.
 */
export const scriptedPlugin = (turns: string): Record<string, string> => ({
  "hortus.json": JSON.stringify({ name: "scripted", version: "0.0.0", entrypoint: "index.js" }),
  // by URL: in-process (no host resolve hook) too
  "index.js": `import { scripted } from ${JSON.stringify(import.meta.url)};\nexport default { providers: { scripted: scripted(${turns}) } };\n`,
});

/** `v` without any `durationMs` (tool results' timing, which varies), in plain objects and arrays, for `deepEqual`. */
export function untimed<T>(v: T): T {
  if (Array.isArray(v)) return v.map(untimed) as T;
  if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) return v;
  return Object.fromEntries(Object.entries(v).flatMap(([k, x]) => (k === "durationMs" ? [] : [[k, untimed(x)]]))) as T;
}
