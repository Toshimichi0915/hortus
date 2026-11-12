import { writeFileSync } from "node:fs";
import { addUsage, agentsMdPrompt, type Ctx, loadAgentsMd, type Plugin, tool, type Usage } from "@hortus/core";
import { z } from "zod";

/** What a child run needs to know about itself: its agent, how its prompt is built, and where it reports. */
export interface ChildConfig {
  /** the parent plugin's loaded name: the supervisor ask's kind is `<plugin>:supervisor` */
  plugin: string;
  agent: string;
  runId: string;
  /** the agent's system prompt */
  prompt: string;
  mode: "replace" | "append";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  excludeTools: string[];
  /** fork: the parent's system prompt, sent unchanged (the agent prompt goes in the task message instead) */
  system?: string;
  /** background: the file its final answer goes to (`ResultFile`), written at each top-level run's end */
  resultFile?: string;
  /** the depth of the child's own runs (in-process); deeper ones are its children */
  depth: number;
  /**
   * background: the session its process runs under (`--parent`): its own runs are those whose `parent.session` it is
   * (their depth counts from that session's)
   */
  parent?: string;
}

/** What a background child leaves behind: its last top-level run's outcome. */
export interface ResultFile {
  status: "completed" | "failed" | "paused";
  output: string;
  error?: string;
  /** what its runs in this process spent (replies, and tools' own model calls) */
  usage?: Usage;
}

/** The boundary Pi gives every child: it isn't the orchestrator, and how to reach its supervisor. */
export const boundary = (agent: string) =>
  `You are the "${agent}" subagent, working on a task the parent agent delegated to you. You are not the parent orchestrator: do the assigned task yourself and do not propose or run subagents unless your tools include \`subagent\` for assigned fanout. If you are blocked or need a decision, call \`contact_supervisor\` with reason "need_decision" and wait for the reply instead of guessing; use "progress_update" only for discoveries that change the plan. Do not send routine completion handoffs: end with your result.`;

/** The last assistant text of `messages`. */
export const lastText = (messages: { role: string; text?: string }[]) =>
  messages.filter((m) => m.role === "assistant" && m.text).at(-1)?.text ?? "";

/**
 * The plugin shaping a child run (Pi's child runtime): its system prompt (the agent's, replacing or after hortus's,
 * with project context and skills only when the agent inherits them), its excluded tools, `contact_supervisor`, and
 * (background) its result file. `observe` sees the child's own events (in-process children report progress through it).
 */
export function childPlugin(cfg: ChildConfig, observe?: (event: string, payload: unknown, ctx: Ctx) => void): Plugin {
  const top = (ctx: Ctx) => (cfg.parent ? ctx.run?.parent?.session === cfg.parent : ctx.run?.depth === cfg.depth);
  let usage: Usage | undefined;
  return {
    tools: [
      tool({
        name: "contact_supervisor",
        description:
          'Reach the parent agent (your supervisor). reason "need_decision" or "interview_request": ask and wait for the reply; "progress_update": a short non-blocking update when a discovery changes the plan.',
        inputSchema: z.object({
          reason: z.enum(["need_decision", "interview_request", "progress_update"]),
          message: z.string().describe("The question or update"),
        }),
        execute: async ({ reason, message }, ctx) => {
          if (reason === "progress_update") return "Progress update sent to the supervisor.";
          const answer = await ctx.ask({
            kind: `${cfg.plugin}:supervisor`,
            question: `${cfg.agent} asks: ${message}`,
            allowText: true,
            data: { reason, agent: cfg.agent, runId: cfg.runId },
          });
          if (answer === undefined)
            return "No reply from the supervisor (none is available). Do not guess: report the open decision with your partial results and stop.";
          return `Supervisor reply: ${Array.isArray(answer) ? answer.join(", ") : answer}`;
        },
      }),
    ],
    on: {
      run_start: async (p, ctx) => {
        if (!cfg.inheritSkills) p.skills = [];
        if (!cfg.inheritProjectContext) p.context.length = 0;
        // replace mode runs without builtin:prompt, which would have loaded them
        else if (cfg.mode === "replace" && !p.context.length) p.context.push(...(await loadAgentsMd(ctx.cwd)));
        for (let i = p.tools.length - 1; i >= 0; i--)
          if (cfg.excludeTools.includes(p.tools[i]?.name ?? "")) p.tools.splice(i, 1);
      },
      prompt: ({ system, context }, ctx) => {
        if (cfg.system !== undefined) {
          system.splice(0, system.length, cfg.system);
          return;
        }
        if (cfg.mode === "append") system.push(cfg.prompt, boundary(cfg.agent));
        else
          system.unshift(
            cfg.prompt,
            `Working directory: ${ctx.cwd}.`,
            ...(context.length ? [agentsMdPrompt(context)] : []),
            boundary(cfg.agent),
          );
      },
      message: (p, ctx) => {
        if (!top(ctx)) return;
        observe?.("message", p, ctx);
        if (p.role === "assistant") usage = addUsage(usage, p.usage);
        else if (p.role === "tool") for (const r of p.results) usage = addUsage(usage, r.usage);
      },
      tool_call: (p, ctx) => {
        if (top(ctx)) observe?.("tool_call", p, ctx);
      },
      run_end: (end, ctx) => {
        if (!cfg.resultFile || !top(ctx) || end.source !== "run") return;
        const result: ResultFile = {
          status: end.error !== undefined ? "failed" : end.aborted ? "paused" : "completed",
          output: lastText(end.messages),
          ...(usage && { usage }),
          ...(end.error !== undefined && { error: end.error instanceof Error ? end.error.message : String(end.error) }),
        };
        writeFileSync(cfg.resultFile, JSON.stringify(result));
      },
    },
  };
}
