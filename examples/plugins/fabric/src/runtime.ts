import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";
import type { BashDetails, Image, Tool, ToolCtx, ToolResult } from "@hortus/core";
import { z } from "zod";

/** Pi's core tools: reachable as `pi.<name>`, hidden from the model in full code mode. */
export const CORE = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
const ident = (s: string) => s.replace(/\W/g, "_");

/** A tool's Fabric ref: `pi.<core tool>`, `mcp.<server>.<tool>` (names sanitized), else `extensions.<name>`. */
export function refOf(name: string): string {
  if (CORE.has(name)) return `pi.${name}`;
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `mcp.${ident(m[1] ?? "")}.${ident(m[2] ?? "")}` : `extensions.${name}`;
}

/**
 * The tools a program can call: every one but `fabric_exec` in full code mode; otherwise (orchestration-only) MCP
 * tools and tools nothing else declares (`exposure: "codemode"`), as Pi's core and extension tools stay native.
 */
export const reachable = (tools: readonly Tool[], full: boolean): Tool[] =>
  tools.filter(
    (t) => t.name !== "fabric_exec" && (full || refOf(t.name).startsWith("mcp.") || t.exposure === "codemode"),
  );

/** One nested call, as `fabric_exec` reports it in its `details` (for the renderer). */
export interface FabricCall {
  ref: string;
  input: unknown;
  status: "running" | "done" | "error";
}
export interface FabricDetails {
  calls: FabricCall[];
}

/** What a program passes to `agents.run`. */
export interface AgentRequest {
  task: string;
  /** names of the tools the child may call (default: every tool of the run's plugins) */
  tools?: string[];
  /** relative to the parent's */
  cwd?: string;
  model?: string;
  provider?: string;
  /** the child's whole system prompt */
  systemPrompt?: string;
}

export interface Program {
  code: string;
  payloads: Record<string, string>;
  timeoutMs: number;
  /** "auto": strings as text, other values as JSON; "json": always JSON */
  resultFormat: "auto" | "json";
  maxOutputChars: number;
}

const firstLine = (s: string) => [...(s.trim().split(/\r?\n/)[0] ?? "")].slice(0, 320).join("");
const schemaOf = (t: Tool) => z.toJSONSchema(t.inputSchema) as { required?: string[] };

/** Keeps both ends of an oversized output; the whole of it goes to a 0600 temp file named in the cut. */
async function cap(text: string, max: number): Promise<string> {
  if (text.length <= max) return text;
  const path = join(tmpdir(), `hortus-fabric-${randomUUID()}.txt`);
  await writeFile(path, text, { mode: 0o600 });
  const note = `\n… [${text.length - max} characters omitted; full output: ${path}] …\n`;
  const half = Math.max(0, Math.floor((max - note.length) / 2));
  return text.slice(0, half) + note + text.slice(-half);
}

/**
 * Runs a Fabric program: TypeScript (types stripped, not checked) as an async function body in a fresh `node:vm`
 * context whose only way out is the host bridge: `pi.*`, `mcp.*`, `extensions.*` and `tools.call` all go through
 * `ctx.runTool`, so every nested call passes `tool_call` (guard, approvals) as a child of the `fabric_exec` call.
 * Returns the returned value (and `print` lines), with the images it returned attached.
 */
export async function runProgram(tools: Tool[], p: Program, ctx: ToolCtx): Promise<string | Image[]> {
  const byRef = new Map(tools.map((t) => [refOf(t.name), t]));
  const calls: FabricCall[] = [];
  const logs: string[] = [];
  /** image descriptors handed to the guest, and the image each stands for */
  const media = new Map<object, Image>();
  const report = () => ctx.update({ calls: calls.map((c) => ({ ...c })) } satisfies FabricDetails);
  // a timeout, an abort or the program's end cancels the nested calls still running
  const stop = new AbortController();

  const shape = (ref: string, r: ToolResult, settle: boolean) => {
    // builtin:bash's error details say how it ended
    const code = r.isError && settle ? (r.details as BashDetails | undefined)?.exitCode : undefined;
    if (typeof code === "number")
      return { ok: false, exitCode: code, output: r.output, details: null, error: `Command exited with code ${code}` };
    if (r.isError) throw new Error(`${ref}: ${r.output}`);
    const images = (r.images ?? []).map((img) => {
      const d = { type: "image", mediaIndex: media.size, mimeType: img.mediaType };
      media.set(d, img);
      return d;
    });
    if (images.length) return { text: r.output, images };
    if (ref === "pi.bash" || ref === "pi.edit" || ref === "pi.write")
      return { ok: true, output: r.output, details: r.details ?? null };
    if (ref.startsWith("pi.")) return r.output;
    if (ref.startsWith("mcp.")) return "value" in r ? r.value : r.output;
    return { text: r.output, details: r.details ?? null, structuredContent: r.value, isError: false };
  };

  const invoke = async (ref: string, args?: unknown) => {
    const t = byRef.get(ref);
    if (!t) throw new Error(`Unknown ref ${ref}: find refs with tools.search({ query }) or tools.list()`);
    // positional shorthand: pi.read("a.ts"), pi.bash("ls")
    let input = (typeof args === "string" ? { [schemaOf(t).required?.[0] ?? "input"]: args } : (args ?? {})) as Record<
      string,
      unknown
    >;
    const settle = t.name === "bash" && input.settle === true;
    if (t.name === "bash") {
      const { settle: _, ...rest } = input;
      input = rest;
    }
    const call: FabricCall = { ref, input, status: "running" };
    calls.push(call);
    report();
    // core gives it the id `<fabric_exec call>/<n>` and runs it through the gate
    const r = await ctx.runTool({ id: "", name: t.name, input }, { signal: stop.signal });
    call.status = r.isError ? "error" : "done";
    report();
    return shape(ref, r, settle);
  };

  const actions = () =>
    [...byRef].map(([ref, t]) => ({
      ref,
      provider: ref.slice(0, ref.lastIndexOf(".")),
      name: t.name,
      description: firstLine(t.description),
    }));
  const terms = (s: string) =>
    s
      .toLowerCase()
      .split(/[\s_.\-/]+/)
      .filter(Boolean);
  const find = (ref: string) => {
    const t = byRef.get(ref);
    if (t) return [ref, t] as const;
    // a bare name, when exactly one provider has it
    const named = [...byRef].filter(([r]) => r.split(".").at(-1) === ref);
    if (named.length === 1 && named[0]) return named[0];
    throw new Error(
      named.length ? `Ambiguous ${ref}: ${named.map(([r]) => r).join(", ")}` : `Unknown ref ${ref}: try tools.search`,
    );
  };
  const api = {
    providers: async () => [...new Set(actions().map((a) => a.provider))].map((name) => ({ name })),
    list: async ({ provider, query, limit = 100 }: { provider?: string; query?: string; limit?: number } = {}) =>
      actions()
        .filter((a) => (!provider || a.provider === provider) && (!query || a.ref.includes(query)))
        .slice(0, Math.min(limit, 1000)),
    search: async ({ query = "", limit = 20 }: { query?: string; limit?: number } = {}) => {
      const q = terms(query);
      return actions()
        .map((a) => ({
          a,
          score: q.filter((w) => terms(`${a.ref} ${a.description}`).some((x) => x.includes(w))).length,
        }))
        .filter((s) => s.score > 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, limit)
        .map((s) => s.a);
    },
    describe: async ({ ref }: { ref: string }) => {
      const [r, t] = find(ref);
      return { ref: r, name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.inputSchema) };
    },
    call: ({ ref, args }: { ref: string; args?: unknown }) => invoke(ref, args),
  };

  const pi: Record<string, unknown> = {};
  const extensions: Record<string, unknown> = {};
  const mcp: Record<string, Record<string, unknown>> = {};
  for (const [ref, t] of byRef) {
    const fn = (args?: unknown) => invoke(ref, args);
    const [ns, a = "", b = ""] = ref.split(".");
    if (ns === "pi") pi[a] = fn;
    else if (ns === "mcp") mcp[a] = { ...mcp[a], [b]: fn };
    else extensions[ident(t.name)] = fn;
  }
  const payloads = new Proxy(Object.freeze({ ...p.payloads }), {
    get: (o, k) => {
      if (typeof k !== "string" || k === "toJSON" || k === "then" || Object.hasOwn(o, k)) return Reflect.get(o, k);
      throw new Error(`π.${k} is not a payload of this call; its payloads: ${Object.keys(o).join(", ") || "(none)"}`);
    },
  });
  /** Fabric's `agents.run`: a one-shot child run (`ctx.subrun`) in memory, cancelled with the program */
  const agents = {
    run: async ({ task, tools, cwd, model, provider, systemPrompt }: AgentRequest) => {
      const call: FabricCall = { ref: "agents.run", input: { task }, status: "running" };
      calls.push(call);
      report();
      const child = ctx.subrun(task, {
        ...(tools && { tools }),
        ...(cwd && { cwd: resolve(ctx.cwd, cwd) }),
        ...(model && { model }),
        ...(provider && { provider }),
        ...(systemPrompt && { system: systemPrompt }),
        signal: stop.signal,
      });
      const end = await child.done;
      const last = end?.messages.at(-1);
      const status = end?.error !== undefined ? "failed" : end?.aborted ? "aborted" : "completed";
      call.status = status === "completed" ? "done" : "error";
      report();
      return {
        id: child.id,
        status,
        text: last?.role === "assistant" ? last.text : "",
        ...(end?.error !== undefined && { error: end.error instanceof Error ? end.error.message : String(end.error) }),
      };
    },
  };
  const print = (...args: unknown[]) =>
    void logs.push(args.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
  const context = vm.createContext({
    pi,
    extensions,
    mcp,
    tools: api,
    agents,
    π: payloads,
    print,
    console: { log: print, info: print, warn: print, error: print, debug: print },
  });

  const used: Image[] = [];
  const format = (v: unknown) => {
    if (v === undefined) return "";
    if (typeof v === "string" && p.resultFormat === "auto") return v;
    return JSON.stringify(
      v,
      (_, x) => {
        const img = x && typeof x === "object" ? media.get(x) : undefined;
        if (img && !used.includes(img)) used.push(img);
        return x;
      },
      2,
    );
  };
  const withLogs = (out: string) => [out, ...(logs.length ? [`Logs:\n${logs.join("\n")}`] : [])].filter(Boolean);

  let timer: NodeJS.Timeout | undefined;
  let onAbort = () => {};
  try {
    const js = stripTypeScriptTypes(`(async () => {\n${p.code}\n})()`);
    const program = vm.runInContext(js, context, { timeout: p.timeoutMs });
    const value = await Promise.race([
      program,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Program timed out after ${p.timeoutMs} ms`)), p.timeoutMs);
        onAbort = () => reject(new Error("Aborted"));
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    const text = (await cap(withLogs(format(value)).join("\n"), p.maxOutputChars)) || "(no output)";
    return used.length ? used.map((img, i) => (i ? img : { ...img, text })) : text;
  } catch (e) {
    // ponytail: a timeout or abort can't stop an async busy loop in the vm (nested calls are cancelled, in `finally`);
    // QuickJS with interrupts would bound it
    const done = calls.filter((c) => c.status === "done").map((c) => c.ref);
    const progress = done.length ? `\nCompleted before the failure: ${done.slice(0, 8).join(", ")}` : "";
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      await cap([...withLogs(""), `Program error: ${msg}${progress}`].join("\n"), Math.min(p.maxOutputChars, 20_000)),
    );
  } finally {
    clearTimeout(timer);
    stop.abort(new Error("The program ended"));
    ctx.signal.removeEventListener("abort", onAbort);
  }
}
