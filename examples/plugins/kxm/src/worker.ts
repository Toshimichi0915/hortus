/**
 * `kxm worker`, ported: a supervised worker agent. It registers its own hub identity and answers each inbound request
 * in a `hortus -p --json --session key:<scope> --name <scope>` child (one hortus session per worker and workflow run, as
 * Pi's worker keeps one Pi session per run), replying with the child's final answer. A child that fails is restarted on
 * the request (without sending it again once saved: `-p` with no prompt runs on it) with backoff, through the model fallbacks, up to `maxRestarts`; then the request stays acknowledged and
 * unreplied (retained) for an operator.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { hortusBin } from "@hortus/cli";
import type { Ctx } from "@hortus/core";
import {
  errorText,
  HubClient,
  type HubOptions,
  Inbox,
  inboundPrompt,
  type MessageRecord,
  workflowRunId,
} from "./client.ts";

export interface WorkerOptions {
  name: string;
  purpose: string;
  /** `--model` per attempt: the primary, then fallbacks (none: the children's configured model) */
  models: string[];
  /** `--tools` for the children (none: all) */
  tools: string[];
  maxRestarts: number;
  /** first restart delay, doubled per restart */
  backoffMs: number;
}

export interface Worker {
  options: WorkerOptions;
  client: HubClient;
  inbox: Inbox;
  children: Set<ChildProcess>;
  stop(): Promise<void>;
}

/** `KXM_WORKER_*` as the worker supervisor reads them. */
export function workerOptions(name: string, purpose: string | undefined, env = process.env): WorkerOptions {
  const list = (v?: string) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    name,
    purpose: purpose || env.KXM_AGENT_PURPOSE || "Supervised hortus worker",
    models: [...new Set([...list(env.KXM_WORKER_MODEL), ...list(env.KXM_WORKER_FALLBACK_MODELS)])],
    tools: list(env.KXM_WORKER_TOOLS),
    maxRestarts: Number(env.KXM_WORKER_MAX_RESTARTS ?? 3),
    backoffMs: Number(env.KXM_WORKER_MIN_BACKOFF_MS ?? 1000),
  };
}

export async function startWorker(
  ctx: Ctx,
  hub: Omit<HubOptions, "name" | "purpose" | "fetch">,
  options: WorkerOptions,
): Promise<Worker> {
  const client = new HubClient({ ...hub, name: options.name, purpose: options.purpose, fetch: ctx.fetch });
  const children = new Set<ChildProcess>();
  let stopped = false;
  // sticky, as Pi's worker: a fallback that worked stays selected
  let modelIndex = 0;

  const answer = async (m: MessageRecord): Promise<string | undefined> => {
    const runId = workflowRunId(m);
    // the scope's session, opened (else created) by its key
    const title = `kxm:${hub.project}:${options.name}:${runId ? `workflow:${runId}` : "default"}`;
    /** the request is saved in the session already (an earlier attempt got that far): a retry runs on it */
    const saved = { value: false };
    for (let attempt = 0; attempt <= options.maxRestarts && !stopped; attempt++) {
      const model = options.models[modelIndex];
      try {
        return await runChild(
          m,
          [
            "--session",
            `key:${title}`,
            "--name",
            title,
            ...(model ? ["--model", model] : []),
            ...(options.tools.length ? ["--tools", options.tools.join(",")] : []),
            ...(saved.value ? [] : [inboundPrompt(m)]),
          ],
          saved,
        );
      } catch (e) {
        if (stopped) return undefined;
        if (modelIndex < options.models.length - 1) modelIndex++;
        void ctx.notify(`kxm worker ${options.name}: ${m.id} failed (attempt ${attempt + 1}): ${errorText(e)}`, "warn");
        if (attempt < options.maxRestarts) await new Promise((r) => setTimeout(r, options.backoffMs * 2 ** attempt));
      }
    }
    if (!stopped) void ctx.notify(`kxm worker ${options.name} retained ${m.id}: every restart failed`, "error");
    return undefined;
  };

  /**
   * one `hortus -p --json` child on `m`; resolves with its last top-level answer, rejects with its errors; sets
   * `saved` once its top-level user message is saved
   */
  const runChild = (m: MessageRecord, args: string[], saved: { value: boolean }) =>
    new Promise<string>((ok, fail) => {
      const child = spawn(process.execPath, [hortusBin, "-p", "--json", ...args], {
        cwd: ctx.cwd,
        // the child acts as this worker on the hub (its kxm tools), continuing the request's hop chain
        env: {
          ...process.env,
          KXM_WORKER_CHILD: "1",
          KXM_AGENT_NAME: options.name,
          KXM_AGENT_ID: client.agent?.id ?? "",
          KXM_AGENT_KEY: client.key ?? "",
          KXM_HOPS: String(m.hops + 1),
          KXM_MAX_HOPS: String(m.maxHops),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      // nor does a child outlive this process (a crash, a second Ctrl+C)
      const kill = () => child.kill();
      process.once("exit", kill);
      let answer = "";
      const errors: string[] = [];
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      createInterface({ input: child.stdout }).on("line", (l) => {
        try {
          const line = JSON.parse(l);
          if (line.error) errors.push(String(line.error));
          else if (line.event === "message" && line.payload?.role === "user" && !line.run?.depth) saved.value = true;
          else if (line.event === "message" && line.payload?.role === "assistant" && !line.run?.depth)
            answer = line.payload.text;
        } catch {}
      });
      child.on("error", fail);
      child.on("close", (code) => {
        children.delete(child);
        process.off("exit", kill);
        if (code === 0) ok(answer.trim() || "The peer agent completed without a textual response.");
        else fail(new Error(errors.join("\n") || stderr.trim() || `exited with ${code}`));
      });
    });

  const inbox = new Inbox(client, answer, (text, level) => void ctx.notify(text, level));
  await client.start(inbox.receive);
  return {
    options,
    client,
    inbox,
    children,
    async stop() {
      stopped = true;
      inbox.stop();
      // SIGINT: hortus -p aborts its run gracefully (its session keeps what completed)
      for (const c of children) c.kill("SIGINT");
      await client.stop();
    },
  };
}
