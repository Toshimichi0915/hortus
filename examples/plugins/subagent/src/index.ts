import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { AskRequest, Ctx, Message, Plugin, ToolCtx } from "@hortus/core";
import { tool } from "@hortus/core";
import { z } from "zod";

/** What a subagent may call: reading only. */
export const TOOLS = ["read"];

/** Background children still running, per agent, killed at exit. */
const jobs = (ctx: Ctx) => {
  ctx.state.jobs ??= new Set<ChildProcess>();
  return ctx.state.jobs as Set<ChildProcess>;
};

/**
 * Runs `task` in a separate `hortus --rpc --parent <this session> --session memory --disable subagent` process (the same
 * restrictions as a foreground subagent: read-only tools, its own cwd, the caller's model) and resolves with its final
 * answer: the task's `run_end` reply. Its asks (a guard's approval, say) are relayed to whoever answers this agent's
 * (`ctx.ask`: the TUI's dialog), their answers written back. Rejects with the run's error, else its error lines (or
 * stderr) when it fails.
 */
async function runInBackground(ctx: ToolCtx, task: string, cwd: string): Promise<string> {
  // imported only here: the foreground subagent needs no CLI (the host's own, through its resolve hook)
  const { hortusBin } = await import("@hortus/cli");
  const run = ctx.run;
  const args = [
    hortusBin,
    "--rpc",
    ...(ctx.session ? ["--parent", ctx.session.id] : []),
    "--session",
    "memory",
    "--disable",
    "subagent",
    "--tools",
    TOOLS.join(","),
    "--cwd",
    cwd,
    ...(run ? ["--model", `${run.provider}/${run.model}`] : []),
    ...(run?.effort ? ["--effort", run.effort] : []),
  ];
  // `ctx.env`: what wrappers of this tool pass on (a tracer's parent run)
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...ctx.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  jobs(ctx).add(child);
  // nor the process (a crash, a second Ctrl+C)
  const kill = () => child.kill();
  process.once("exit", kill);
  const write = (cmd: object) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(cmd)}\n`);
  };
  child.stdin.on("error", () => {});
  let reply: { messages?: Message[]; error?: { message?: string } } | undefined;
  const errors: string[] = [];
  let stderr = "";
  /** the child's asks open here, by askId */
  const asks = new Map<string, AbortController>();
  child.stderr.on("data", (d) => (stderr += d));
  createInterface({ input: child.stdout }).on("line", (l) => {
    try {
      const line = JSON.parse(l);
      if (line.error && !line.response) errors.push(line.error);
      else if (line.response === "prompt" && line.id === "task") {
        reply = line;
        // its task is done: it exits once nothing else runs
        child.stdin.end();
      } else if (line.event === "ask" && line.payload?.askId) {
        const { askId, ...req } = line.payload as AskRequest & { askId: string };
        // withdrawn once the child settles it itself (its `answered`, ours included) or exits
        const abort = new AbortController();
        asks.set(askId, abort);
        void ctx.ask(req, { signal: abort.signal }).then(
          (answer) => {
            if (!abort.signal.aborted) write({ type: "answer", askId, answer: answer ?? null });
          },
          () => write({ type: "answer", askId, answer: null }),
        );
      } else if (line.event === "answered" && line.payload?.askId) {
        asks.get(line.payload.askId)?.abort();
        asks.delete(line.payload.askId);
      }
    } catch {}
  });
  write({ type: "prompt", text: task, id: "task" });
  return new Promise((ok, fail) => {
    child.on("error", fail);
    child.on("close", (code) => {
      for (const a of asks.values()) a.abort();
      jobs(ctx).delete(child);
      process.off("exit", kill);
      const last = reply?.messages?.at(-1);
      if (reply && !reply.error) ok(last?.role === "assistant" ? last.text : "");
      else fail(new Error(reply?.error?.message ?? (errors.join("\n") || stderr.trim() || `exited with ${code}`)));
    });
  });
}

/**
 * A `subagent` tool: delegates a task to a nested run (`ctx.subrun`) in its own directory, with a read-only tool set and
 * without this plugin (so it can't delegate again), and returns the child's final text. The child's tokens count toward
 * the call's result (core adds them), and aborting the run aborts it. With `background`, the task runs in a separate
 * `hortus --rpc` process under this session (`--parent`) instead, its asks relayed to this agent's, and the tool
 * returns at once; the result arrives later as a `subagent:result`
 * message (`ctx.send(..., { deliver: "after" })`: a turn of its own once the current one ends); only on an interactive
 * host, as one that isn't (`hortus -p`) may exit first: there it runs in the foreground.
 */
export default {
  tools: [
    tool({
      name: "subagent",
      description:
        "Delegate a self-contained, read-only task (research, reading code) to a subagent, which reports back. Give it everything it needs to know: it sees only the task. With background: true it runs on its own and its report arrives later, as a message.",
      inputSchema: z.object({
        task: z.string().describe("What the subagent should do and report"),
        cwd: z.string().optional().describe("Directory it works in (default: yours)"),
        background: z.boolean().optional().describe("Run it in the background; its report arrives as a later message"),
      }),
      execute: async ({ task, cwd, background }, ctx) => {
        const dir = resolve(ctx.cwd, cwd ?? ".");
        // a host that isn't interactive (`hortus -p`) may end before a background result arrives: run it here
        if (background && ctx.host.interactive) {
          const id = randomUUID().slice(0, 8);
          void runInBackground(ctx, task, dir)
            .then(
              (answer) => `Background subagent ${id} finished:\n\n${answer}`,
              (e) => `Background subagent ${id} failed: ${e instanceof Error ? e.message : String(e)}`,
            )
            .then((content) =>
              ctx.send(
                { content, meta: { plugin: ctx.plugin, type: "result", details: { id } } },
                { deliver: "after" },
              ),
            )
            .catch((e) => ctx.notify(`Delivering subagent ${id}'s result failed: ${e}`, "error"));
          return `Started background subagent ${id}; its report will arrive as a message when it finishes.`;
        }
        const child = ctx.subrun(task, { cwd: dir, tools: TOOLS, plugins: { disable: ["subagent"] } });
        const end = await child.done;
        if (end?.error !== undefined) throw end.error;
        if (end?.aborted) throw new Error(`The subagent was aborted by ${end.aborted.by}`);
        const last = end?.messages.at(-1);
        return last?.role === "assistant" ? last.text : "";
      },
    }),
  ],
  on: {
    // background children don't outlive the agent
    close: (_, ctx) => {
      for (const child of jobs(ctx)) child.kill();
    },
  },
} satisfies Plugin;
