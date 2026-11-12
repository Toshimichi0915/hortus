import vm from "node:vm";
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

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/**
 * `codemode`'s `details` (every `ctx.update`, and so the result's), for card renderers: the tool calls its script made,
 * in order, each running until it settles.
 */
export interface CodemodeDetails {
  calls: { tool: string; input: unknown; status: "running" | "done" | "error" }[];
}

/**
 * Runs `code` as an async function body with `tools` (each call through `ctx.runTool`, so gated like a model's, as a
 * child of the codemode call), `text`, `image` and `console`; returns what the script showed.
 */
export async function runScript(tools: Tool[], code: string, timeout: number, ctx: ToolCtx): Promise<string | Image[]> {
  const items: string[] = [];
  const logs: string[] = [];
  const attached: Image[] = [];
  const calls: CodemodeDetails["calls"] = [];
  const report = () => ctx.update({ calls: calls.map((c) => ({ ...c })) } satisfies CodemodeDetails);
  // a timeout or error ends the script's calls still running too
  const stop = new AbortController();
  const api = Object.fromEntries(
    tools.map((t) => [
      ident(t.name),
      async (input: unknown = {}) => {
        const call: CodemodeDetails["calls"][number] = { tool: t.name, input, status: "running" };
        calls.push(call);
        report();
        // core gives it the id `<codemode call>/<n>`
        const r = await ctx.runTool({ id: "", name: t.name, input }, { signal: stop.signal });
        call.status = r.isError ? "error" : "done";
        report();
        if (r.isError) throw new Error(r.output);
        // images as blocks (`image()` attaches them), the output (their text) on the first; else the value, else text
        const [first, ...rest] = r.images ?? [];
        if (first) return rest.length ? [{ ...first, text: r.output }, ...rest] : { ...first, text: r.output };
        return "value" in r ? r.value : r.output;
      },
    ]),
  );
  const log = (...args: unknown[]) => void logs.push(args.map(show).join(" "));
  const context = vm.createContext({
    tools: api,
    text: (v: unknown) => void items.push(show(v)),
    image: (v: Image) => {
      if (v?.type !== "image" || typeof v.data !== "string") throw new Error("image() takes an image a tool returned");
      const { text: shown, ...img } = v;
      // a tool's result images are saved already, and their text names the file
      const path = img.path ?? saveImage(img);
      attached.push({ ...img, path });
      if (shown) items.push(shown);
      if (!img.path) items.push(`[Image saved to ${path}]`);
    },
    console: { log, info: log, warn: log, error: log, debug: log },
  });
  const output = () =>
    [...items, ...(logs.length ? [`<console_output>\n${logs.join("\n")}\n</console_output>`] : [])].join("\n");
  let timer: NodeJS.Timeout | undefined;
  try {
    // ponytail: node:vm is not a sandbox: a script reaches `process` (`console.log.constructor("return process")()`)
    // and so anything, unseen by gates, which is why the tool declares `effects.code` (gates ask before it runs, or
    // block). Its timeout only covers synchronous code; a busy loop after an await hangs the run. Upgrade path: run
    // scripts in a real isolate (QuickJS-wasm, or isolated-vm) with `tools` as the only bridge, then drop the effect.
    const script = vm.runInContext(`(async () => {\n${code}\n})()`, context, { timeout: timeout * 1000 });
    const value = await Promise.race([
      script,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Script timed out after ${timeout} seconds`)), timeout * 1000);
      }),
    ]);
    if (value !== undefined) items.push(show(value));
  } catch (e) {
    throw new Error(`${output()}\nScript error: ${e instanceof Error ? e.message : String(e)}`.trim());
  } finally {
    clearTimeout(timer);
    stop.abort(new Error("The script ended"));
  }
  const text = output() || "(no output)";
  // the text rides on the first image
  return attached.length ? attached.map((a, i) => (i ? a : { ...a, text })) : text;
}

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
  // node:vm is no sandbox: a script can do anything, so gates treat the call as running arbitrary code
  effects: { code: ["code"] },
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
