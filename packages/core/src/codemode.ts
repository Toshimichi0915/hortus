import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import * as z from "zod";
import { type Image, type Tool, type ToolCtx, tool, toolSchema } from "./llm.ts";
import { saveImage } from "./tools.ts";

interface Schema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  anyOf?: Schema[];
  oneOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
}

const doc = (s: Schema, indent: string) =>
  s.description ? `${indent}/** ${s.description.replace(/\*\//g, "*\\/")} */\n` : "";

/** A TypeScript type for a JSON Schema; models write calls against TypeScript better than against JSON Schema. */
export function tsType(s: Schema, indent = ""): string {
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  const union = s.anyOf ?? s.oneOf;
  if (union) return union.map((u) => tsType(u, indent)).join(" | ");
  if (Array.isArray(s.type)) return s.type.map((type) => tsType({ ...s, type }, indent)).join(" | ");
  switch (s.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = s.items ? tsType(s.items, indent) : "unknown";
      return /[ |]/.test(item) && !item.startsWith("{") ? `(${item})[]` : `${item}[]`;
    }
    case "object":
    case undefined: {
      if (!s.properties) return s.type ? "Record<string, unknown>" : "unknown";
      const inner = `${indent}  `;
      const props = Object.entries(s.properties).map(
        ([k, p]) =>
          `${doc(p, inner)}${inner}${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${s.required?.includes(k) ? "" : "?"}: ${tsType(p, inner)};`,
      );
      return `{\n${props.join("\n")}\n${indent}}`;
    }
    default:
      return "unknown";
  }
}

/** A tool's name as a JS identifier: `mcp__chrome-devtools__click` is `tools.mcp__chrome_devtools__click`. */
const ident = (name: string) => name.replace(/\W/g, "_");

/** The `tools` declaration listed in the codemode description. */
export function declare(tools: Tool[]): string {
  const methods = tools.map((t) => {
    const schema = toolSchema(t) as Schema;
    // a result's `value` (structured content) when the tool declares it, else unknown (text, or images)
    const out = t.outputSchema ? tsType(t.outputSchema as Schema, "  ") : "unknown";
    return `${doc({ description: t.description }, "  ")}  ${ident(t.name)}(input: ${tsType(schema, "  ")}): Promise<${out}>;`;
  });
  return `declare const tools: {\n${methods.join("\n")}\n};`;
}

/**
 * `codemode`'s `details` (every `ctx.update`, and so the result's), for card renderers: the tool calls its script made,
 * in order, each running until it settles.
 */
export interface CodemodeDetails {
  calls: { tool: string; input: unknown; status: "running" | "done" | "error" }[];
}

/** The QuickJS engine (WebAssembly), loaded once per process on the first script. */
let engine: Promise<QuickJSWASMModule> | undefined;
const quickjs = () => {
  engine ??= newQuickJSWASMModuleFromVariant(import("@jitl/quickjs-wasmfile-release-sync"));
  return engine;
};

/** A script's memory limit (Pi's too). */
const MEMORY = 256 * 1024 * 1024;

/** The script's globals, written in the script's own JS over the host bridge (`__call`, `__text`, ...): only strings cross. */
const PRELUDE = `
const __show = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
globalThis.tools = Object.fromEntries(__names.split("\\n").filter(Boolean).map((n) => [n, async (input = {}) => {
  const r = JSON.parse(await __call(n, JSON.stringify(input)));
  return r.v;
}]));
globalThis.text = (v) => void __text(__show(v));
globalThis.image = (v) => void __image(JSON.stringify(v ?? null));
const __log = (...args) => void __log1(args.map(__show).join(" "));
globalThis.console = { log: __log, info: __log, warn: __log, error: __log, debug: __log };
`;

/**
 * Runs `code` as an async function body in a QuickJS (WebAssembly) isolate whose only way out is `tools` (each call
 * through `ctx.runTool`, so gated like a model's, as a child of the codemode call), plus `text`, `image` and `console`;
 * returns what the script showed. No Node APIs, file system, network or timers; 256 MB of memory; `timeout` is a hard
 * deadline, busy loops included.
 */
export async function runScript(tools: Tool[], code: string, timeout: number, ctx: ToolCtx): Promise<string | Image[]> {
  const items: string[] = [];
  const logs: string[] = [];
  const attached: Image[] = [];
  const calls: CodemodeDetails["calls"] = [];
  const report = () => ctx.update({ calls: calls.map((c) => ({ ...c })) } satisfies CodemodeDetails);
  const byIdent = new Map(tools.map((t) => [ident(t.name), t]));
  // a timeout, error or abort ends the script's calls still running too
  const stop = new AbortController();
  const deadline = Date.now() + timeout * 1000;
  const runtime = (await quickjs()).newRuntime();
  runtime.setMemoryLimit(MEMORY);
  runtime.setInterruptHandler(() => Date.now() > deadline || stop.signal.aborted);
  const vm = runtime.newContext();
  /** host calls not settled yet; while any is, the script may still finish */
  const pending = new Set<QuickJSDeferredPromise>();
  let finish!: (value: string | undefined) => void;
  let fail!: (e: Error) => void;
  const result = new Promise<string | undefined>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  let over = false;
  const end = (e?: Error, value?: string) => {
    if (over) return;
    over = true;
    if (e) fail(e);
    else finish(value);
  };
  /** runs the script's ready jobs; then, with nothing running in it or for it, it can never finish */
  const pump = () => {
    if (over) return;
    const r = runtime.executePendingJobs();
    if (r.error) {
      const e = vm.dump(r.error);
      r.error.dispose();
      return end(new Error(Date.now() > deadline ? "interrupted" : errorText(e)));
    }
    if (!over && !pending.size) end(new Error("The script awaits a promise that can never settle"));
  };
  const fn = (name: string, f: (...args: (string | undefined)[]) => string | QuickJSHandle | undefined) => {
    const h = vm.newFunction(name, (...args) => {
      const r = f(...args.map((a) => vm.dump(a) as string | undefined));
      return typeof r === "string" ? vm.newString(r) : r;
    });
    vm.setProp(vm.global, name, h);
    h.dispose();
  };
  fn("__call", (name, json) => {
    const t = byIdent.get(name ?? "");
    const input = JSON.parse(json ?? "null") as unknown;
    const deferred = vm.newPromise();
    pending.add(deferred);
    const call: CodemodeDetails["calls"][number] = { tool: t?.name ?? String(name), input, status: "running" };
    calls.push(call);
    report();
    // core gives it the id `<codemode call>/<n>`
    const settle = ctx
      .runTool({ id: "", name: t?.name ?? String(name), input }, { signal: stop.signal })
      .catch((e: unknown) => ({ id: "", output: e instanceof Error ? e.message : String(e), isError: true as const }));
    void settle.then((r) => {
      call.status = r.isError ? "error" : "done";
      report();
      pending.delete(deferred);
      // the script ended: its runtime (and this promise) is gone
      if (over) return;
      if (r.isError) {
        const err = vm.newError(r.output);
        deferred.reject(err);
        err.dispose();
      } else {
        // images as blocks (`image()` attaches them), the output (their text) on the first; else the value, else text
        const [first, ...rest] = r.images ?? [];
        const v = first
          ? rest.length
            ? [{ ...first, text: r.output }, ...rest]
            : { ...first, text: r.output }
          : "value" in r
            ? r.value
            : r.output;
        const s = vm.newString(JSON.stringify({ v }));
        deferred.resolve(s);
        s.dispose();
      }
      deferred.dispose();
      pump();
    });
    return deferred.handle;
  });
  fn("__text", (v) => void items.push(v ?? ""));
  fn("__log1", (v) => void logs.push(v ?? ""));
  fn("__image", (json) => {
    const v = JSON.parse(json ?? "null") as Image | null;
    if (v?.type !== "image" || typeof v.data !== "string") throw new Error("image() takes an image a tool returned");
    const { text: shown, ...img } = v;
    // a tool's result images are saved already, and their text names the file
    const path = img.path ?? saveImage(img);
    attached.push({ ...img, path });
    if (shown) items.push(shown);
    if (!img.path) items.push(`[Image saved to ${path}]`);
  });
  fn("__done", (v) => void end(undefined, v));
  fn("__fail", (m) => void end(new Error(m ?? "Error")));
  const names = vm.newString([...byIdent.keys()].join("\n"));
  vm.setProp(vm.global, "__names", names);
  names.dispose();

  const output = () =>
    [...items, ...(logs.length ? [`<console_output>\n${logs.join("\n")}\n</console_output>`] : [])].join("\n");
  const onAbort = () => end(new Error("Aborted"));
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  // the deadline also covers waits on tools (the interrupt handler only runs while the script computes)
  const timer = setTimeout(() => end(new Error(`Script timed out after ${timeout} seconds`)), timeout * 1000);
  try {
    const started = vm.evalCode(
      `${PRELUDE}\n(async () => {\n${code}\n})().then((v) => __done(v === undefined ? undefined : __show(v)), (e) => __fail(e instanceof Error ? e.message : String(e)));`,
      "script.js",
    );
    if (started.error) {
      const e = vm.dump(started.error);
      started.error.dispose();
      end(new Error(Date.now() > deadline ? `Script timed out after ${timeout} seconds` : errorText(e)));
    } else {
      started.value.dispose();
      pump();
    }
    const value = await result;
    if (value !== undefined) items.push(value);
  } catch (e) {
    let message = e instanceof Error ? e.message : String(e);
    if (message === "interrupted") message = `Script timed out after ${timeout} seconds`;
    throw new Error(`${output()}\nScript error: ${message}`.trim());
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onAbort);
    over = true;
    stop.abort(new Error("The script ended"));
    for (const d of pending) d.dispose();
    vm.dispose();
    runtime.dispose();
  }
  const text = output() || "(no output)";
  // the text rides on the first image
  return attached.length ? attached.map((a, i) => (i ? a : { ...a, text })) : text;
}

/** A QuickJS error dumped to the host: its message. */
const errorText = (e: unknown) =>
  e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);

/** The `codemode` tool's description, declaring `tools`. */
export const codemodeDescription = (tools: Tool[]) =>
  `Run JavaScript that calls tools. The code is the body of an async function: top-level await and return work. Only the script's output reaches you, so chain calls, run independent ones in parallel (Promise.all) and filter large results in the script.

Globals:
- tools.<name>(input): call a tool. Resolves to its output: a string for text output (MCP tools too, unless they return structured content, which resolves as the value), or an image block { type: "image", mediaType, data, text } when it returns an image. Rejects with an Error on failure.
- text(value): add a text item to the output (non-strings as JSON). A returned value is added the same way.
- image(block): attach an image block a tool returned; every one attached reaches you. Each one is also saved to a file, named in the output.
- console.log(...): add a line to a <console_output> block after the output.

There is no require, import, fs or network: reach the outside world through tools.

${declare(tools)}`;

/**
 * The `codemode` tool: a script that calls the run's tools (`ctx.tools`, but itself), so only its output reaches the
 * model. Its description declares no tools; builtin:codemode declares the run's in `run_start`.
 */
export const codemodeTool = tool({
  name: "codemode",
  description: codemodeDescription([]),
  codemodeHost: true,
  // scripts run in a QuickJS isolate whose only way out is `tools`, each call gated: the script itself needs no gate
  inputSchema: z.object({
    code: z.string().describe("JavaScript source: the body of an async function"),
    timeout: z.number().positive().optional().describe("Timeout in seconds (default: 120)"),
  }),
  execute: ({ code, timeout = 120 }, ctx) =>
    runScript(
      ctx.tools.filter((t) => t.name !== "codemode"),
      code,
      timeout,
      ctx,
    ),
});
