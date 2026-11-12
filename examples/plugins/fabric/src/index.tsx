import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CliPlugin, linesRenderer, type Span, theme } from "@hortus/cli";
import { hortusDir, type Tool, tool, tsType } from "@hortus/core";
import { z } from "zod";
import { CORE, type FabricDetails, reachable, refOf, runProgram } from "./runtime.ts";

type Risk = "read" | "write" | "execute" | "network";
type Policy = "allow" | "ask" | "deny";

/** `~/.hortus/fabric.json`, over these defaults (Fabric's own). */
export interface FabricConfig {
  /** hide the core and extension tools from the model: only `fabric_exec` (and `foreground`) is declared */
  fullCodeMode: boolean;
  /** extension tools still declared beside `fabric_exec` in full code mode (never core tools; at most `maxTools`) */
  foreground: { tools: string[]; maxTools: number };
  executor: { timeoutMs: number; maxTimeoutMs: number; maxOutputChars: number; resultFormat: "auto" | "json" };
  /** per risk class, for direct and nested calls alike */
  approvals: Partial<Record<Risk, Policy>>;
  /** tool name → risk class, for tools other than the core ones (default "execute") */
  capture: { risks: Record<string, Risk> };
}

const DEFAULTS: FabricConfig = {
  fullCodeMode: true,
  foreground: { tools: [], maxTools: 4 },
  executor: { timeoutMs: 120_000, maxTimeoutMs: 900_000, maxOutputChars: 50_000, resultFormat: "auto" },
  approvals: {},
  capture: { risks: {} },
};

/** Read on every use, so edits apply to the next call. A missing file is the defaults; an invalid one throws. */
export function loadConfig(): FabricConfig {
  let raw: Partial<FabricConfig>;
  try {
    raw = JSON.parse(readFileSync(join(hortusDir(), "fabric.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return DEFAULTS;
    throw new Error(`Invalid ~/.hortus/fabric.json: ${(e as Error).message}`);
  }
  return {
    ...DEFAULTS,
    ...raw,
    foreground: { ...DEFAULTS.foreground, ...raw.foreground },
    executor: { ...DEFAULTS.executor, ...raw.executor },
    capture: { ...DEFAULTS.capture, ...raw.capture },
  };
}

/** Pi's core tools hortus doesn't have, by name */
const RISKS: Record<string, Risk> = { grep: "read", find: "read", ls: "read" };
/** what the tool declares (`effects`: the core tools'), else `capture.risks`, else Pi's table, else "execute" */
const riskOf = (name: string, tool: Tool | undefined, cfg: FabricConfig): Risk => {
  const e = tool?.effects;
  const declared =
    e &&
    (e.exec?.length || e.code?.length
      ? "execute"
      : e.writes?.length
        ? "write"
        : e.readOnly || e.reads
          ? "read"
          : undefined);
  return declared ?? cfg.capture.risks[name] ?? RISKS[name] ?? "execute";
};

/** The foreground tools that are declared: registered, not core, in order, at most `maxTools`. */
const foreground = (cfg: FabricConfig, tools: readonly Tool[]) =>
  cfg.foreground.tools
    .filter((n) => !CORE.has(n) && n !== "fabric_exec" && tools.some((t) => t.name === n))
    .slice(0, cfg.foreground.maxTools);

const RETURNS: Record<string, string> = {
  bash: "{ ok: true; output: string; details: unknown } | { ok: false; exitCode: number; output: string; details: null; error: string }",
  edit: "{ ok: true; output: string; details: unknown }",
  write: "{ ok: true; output: string; details: unknown }",
};

/** `fabric_exec`'s description: `pi.*` typed, MCP and extension tools as a names-only roster (describe them first). */
export function description(tools: Tool[]): string {
  const core = tools.filter((t) => CORE.has(t.name));
  const roster = tools.filter((t) => !CORE.has(t.name)).map((t) => refOf(t.name));
  const pi = core.map((t) => {
    const input = tsType(z.toJSONSchema(t.inputSchema) as Parameters<typeof tsType>[0], "  ");
    const extra = t.name === "bash" ? " & { settle?: boolean }" : "";
    return `  /** ${t.description.split("\n")[0]} */\n  ${t.name}(input: ${input}${extra}): Promise<${RETURNS[t.name] ?? "string"}>;`;
  });
  return `Execute a TypeScript program (the body of an async function: top-level await and return work; types are stripped, not checked). Only its return value (strings as text, anything else as JSON) and print() lines reach you, so chain calls, run independent ones with Promise.all, and return compact evidence.

Globals:
- pi.<tool>(input): Pi's core tools. Rejects when the tool fails; pi.bash({ command, settle: true }) resolves { ok: false, exitCode, ... } on a nonzero exit instead.
- mcp.<server>.<tool>(input), extensions.<tool>(input): the other tools. Look them up first: their schemas aren't listed here.
- tools.providers(), tools.list({ provider?, query?, limit? }), tools.search({ query, limit? }), tools.describe({ ref }), tools.call({ ref, args }): discovery and calls by ref ("pi.read", "mcp.server.tool", "extensions.name").
- agents.run({ task, tools?, cwd?, model?, provider?, systemPrompt? }): a one-shot child agent; resolves { id, status: "completed" | "failed" | "aborted", text, error? } (check status before relying on text).
- π.<key>: this call's \`payloads\` (strings awkward to quote in code, e.g. file contents for pi.write).
- print(...) / console.log(...): lines added after the result.
Images a tool returns come back as { type: "image", mediaIndex, mimeType } descriptors; return one to attach it. There is no require, import, fs or network.
${pi.length ? `\ndeclare const pi: {\n${pi.join("\n")}\n};\n` : ""}${roster.length ? `\nOther refs: ${roster.join(", ")}` : ""}`;
}

const GUIDELINES = `Fabric: use fabric_exec for tool work. Batch independent I/O in one program (Promise.all), keep dependent calls sequential, search before reading (pi.bash with grep/find, then pi.read with offset/limit), and pass edit/write contents through \`payloads\` (π.key). Read skill files with pi.read. Give each program a \`display.name\` and an objective \`display.description\`.`;

const displayOf = (d: unknown): { name?: string; description?: string } => {
  if (typeof d !== "string") return (d ?? {}) as { name?: string };
  try {
    const parsed = JSON.parse(d);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  return { name: d };
};

const fabricExec = tool({
  name: "fabric_exec",
  description: description([]),
  // MCP tools (`exposure: "codemode"`) stay callable from programs and are never declared by core
  codemodeHost: true,
  // its programs run in node:vm, which is no sandbox: gates treat a call as running arbitrary code
  effects: { code: ["code"] },
  prompt: GUIDELINES,
  inputSchema: z.object({
    code: z.string().describe("TypeScript async function body"),
    payloads: z
      .union([z.record(z.string(), z.string()), z.string()])
      .optional()
      .describe("Named strings exposed as π.key (a JSON-object string is parsed)"),
    display: z
      .union([z.object({ name: z.string().optional(), description: z.string().optional() }), z.string()])
      .optional()
      .describe("A short milestone name and objective, shown in the activity UI"),
    timeoutMs: z
      .number()
      .positive()
      .optional()
      .describe("Whole-program deadline in ms; raises (never lowers) the configured one"),
    resultFormat: z.enum(["auto", "json"]).optional(),
  }),
  execute: async (input, ctx) => {
    const cfg = loadConfig();
    const payloads = typeof input.payloads === "string" ? JSON.parse(input.payloads) : (input.payloads ?? {});
    const { timeoutMs, maxTimeoutMs, maxOutputChars, resultFormat } = cfg.executor;
    return runProgram(
      reachable(ctx.tools, cfg.fullCodeMode),
      {
        code: input.code,
        payloads,
        timeoutMs: Math.min(maxTimeoutMs, Math.max(timeoutMs, input.timeoutMs ?? 0)),
        resultFormat: input.resultFormat ?? resultFormat,
        maxOutputChars,
      },
      ctx,
    );
  },
});

/** "Allow for this session" grants, per session id, until it closes. */
const grants = new Map<string, Set<Risk>>();

const MARK = { running: "…", done: "✓", error: "✗" } as const;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * pi-fabric: `fabric_exec` in place of builtin:codemode. In full code mode (the default) it is the only tool the model
 * sees (plus `foreground` ones); programs reach Pi's core tools as `pi.*`, MCP tools as `mcp.<server>.<tool>`, every
 * other tool as `extensions.*`, and all of them through `tools.*` discovery. Every nested call goes through
 * `ctx.runTool`, so `tool_gate` handlers (guard's, and Fabric's own approval policy, by the tool's `effects`) gate it
 * like a direct one.
 */
export default {
  tools: [fabricExec],
  on: {
    request: (r, ctx) => {
      if (r.source !== "run" && r.source !== "preview") return;
      const self = r.tools.find((t) => t.name === "fabric_exec");
      // removed in run_start (a plan mode): the run keeps its tools as they are
      if (!self) return;
      const cfg = loadConfig();
      const fg = foreground(cfg, ctx.tools);
      // full code mode: only the foreground tools beside it (from every callable one: MCP tools aren't in r.tools)
      const keep = cfg.fullCodeMode ? ctx.tools.filter((t) => fg.includes(t.name)) : r.tools.filter((t) => t !== self);
      r.tools.splice(
        0,
        r.tools.length,
        { ...self, description: description(reachable(ctx.tools, cfg.fullCodeMode)) },
        ...keep,
      );
    },
    tool_gate: async (p, ctx) => {
      if (p.block !== undefined || p.call.name === "fabric_exec") return;
      const cfg = loadConfig();
      const risk = riskOf(p.call.name, p.tool, cfg);
      const policy = cfg.approvals[risk] ?? "allow";
      const session = ctx.session?.id ?? "";
      if (policy === "allow" || grants.get(session)?.has(risk)) return;
      const deny = (why: string) => {
        p.block = `Denied by fabric (${risk}): ${why}`;
      };
      if (policy === "deny") return deny(`approvals.${risk} is "deny"`);
      // ponytail: concurrent asks aren't serialized, so two calls of one risk class may both ask before either grant
      const answer = await ctx.ask({
        question: `Allow ${refOf(p.call.name)} (${risk})?`,
        options: [{ label: "Allow once" }, { label: "Allow for this session" }, { label: "Deny" }],
      });
      if (answer === "Allow for this session") grants.set(session, new Set([...(grants.get(session) ?? []), risk]));
      else if (answer !== "Allow once") deny(answer === undefined ? "no one approved it" : "the user denied it");
    },
    tool_result: ({ call, result }, ctx) => {
      // a direct call to a hidden tool: say how to reach it
      if (result.output !== `Unknown tool: ${call.name}` || call.parentId) return;
      if (ctx.tools.some((t) => t.name === call.name) && ctx.tools.some((t) => t.name === "fabric_exec"))
        result.output += ` (call it from fabric_exec: \`await ${refOf(call.name)}(input)\`)`;
    },
    session_close: ({ session }) => void grants.delete(session.id),
  },
  cli: {
    tools: {
      // compact: the display name and objective, then each nested call; Ctrl+O adds the program and the whole result
      fabric_exec: linesRenderer(({ call, result, details, expanded }) => {
        const input = (call.input ?? {}) as { code?: unknown; display?: unknown };
        const d = displayOf(input.display);
        const rows: Span[][] = [[{ text: `fabric ${d.name ?? "program"}`, bold: true, color: theme.toolTitle }]];
        if (d.description) rows.push([{ text: d.description, color: theme.toolOutput }]);
        for (const c of (details as FabricDetails | undefined)?.calls ?? [])
          rows.push([
            { text: `${MARK[c.status]} `, color: c.status === "error" ? theme.toolError : theme.toolDone },
            { text: `${c.ref} ${clip(JSON.stringify(c.input) ?? "", 80)}`, color: theme.toolOutput },
          ]);
        if (expanded && typeof input.code === "string")
          rows.push([], ...input.code.split("\n").map((text): Span[] => [{ text, color: theme.mdCodeBlock }]));
        if (result) {
          const lines = result.output.split("\n");
          const shown =
            expanded || lines.length <= 5 ? lines : [...lines.slice(0, 5), `… (${lines.length - 5} more lines)`];
          const color = result.isError ? theme.toolError : theme.toolOutput;
          rows.push([], ...shown.map((text): Span[] => [{ text, color }]));
        }
        return rows;
      }),
    },
  },
} satisfies CliPlugin;
