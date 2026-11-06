import vm from "node:vm";
import * as z from "zod";
import { type Image, type Tool, tool } from "./llm.ts";
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
    const schema = z.toJSONSchema(t.inputSchema) as Schema;
    return `${doc({ description: t.description }, "  ")}  ${ident(t.name)}(input: ${tsType(schema, "  ")}): Promise<unknown>;`;
  });
  return `declare const tools: {\n${methods.join("\n")}\n};`;
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** Runs `code` as an async function body with `tools`, `text`, `image` and `console`; returns what the script showed. */
export async function runScript(tools: Tool[], code: string, timeout: number): Promise<string | Image> {
  const items: string[] = [];
  const logs: string[] = [];
  let attached: Image | undefined;
  const api = Object.fromEntries(
    tools.map((t) => [
      ident(t.name),
      async (args: unknown = {}) => {
        const input = t.inputSchema.safeParse(args);
        if (!input.success) throw new Error(`Invalid input for ${t.name}: ${input.error.message}`);
        return t.execute(input.data as never);
      },
    ]),
  );
  const log = (...args: unknown[]) => void logs.push(args.map(show).join(" "));
  const context = vm.createContext({
    tools: api,
    text: (v: unknown) => void items.push(show(v)),
    image: (v: Image) => {
      if (v?.type !== "image" || typeof v.data !== "string") throw new Error("image() takes an image a tool returned");
      // saved, so images before the attached last one aren't lost
      const path = saveImage(v);
      attached = { ...v, path };
      if (v.text) items.push(v.text);
      items.push(`[Image saved to ${path}]`);
    },
    console: { log, info: log, warn: log, error: log, debug: log },
  });
  const output = () =>
    [...items, ...(logs.length ? [`<console_output>\n${logs.join("\n")}\n</console_output>`] : [])].join("\n");
  let timer: NodeJS.Timeout | undefined;
  try {
    // ponytail: node:vm isolates globals, not the process (the agent has bash anyway), and its timeout only covers
    // synchronous code; a busy loop after an await hangs the run. Use a worker or QuickJS if scripts must be contained.
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
  }
  const text = output() || "(no output)";
  return attached ? { ...attached, text } : text;
}

/** The `codemode` tool: a script that calls `tools`, so only its output reaches the model. */
export const codemodeTool = (tools: Tool[]) =>
  tool({
    name: "codemode",
    description: `Run JavaScript that calls tools. The code is the body of an async function: top-level await and return work. Only the script's output reaches you, so chain calls, run independent ones in parallel (Promise.all) and filter large results in the script.

Globals:
- tools.<name>(input): call a tool. Resolves to its output: a string for text output (MCP tools too, unless they return structured content, which resolves as the value), or an image block { type: "image", mediaType, data, text } when it returns an image. Rejects with an Error on failure.
- text(value): add a text item to the output (non-strings as JSON). A returned value is added the same way.
- image(block): attach an image block a tool returned (only the last one is attached). Each one is also saved to a file, named in the output.
- console.log(...): add a line to a <console_output> block after the output.

There is no require, import, fs or network: reach the outside world through tools.

${declare(tools)}`,
    inputSchema: z.object({
      code: z.string().describe("JavaScript source: the body of an async function"),
      timeout: z.number().positive().optional().describe("Timeout in seconds (default: 120)"),
    }),
    execute: ({ code, timeout = 120 }) => runScript(tools, code, timeout),
  });
