import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { type CliPlugin, theme, usePluginCtx, useSession, useTheme } from "@hortus/cli";
import { type Ctx, type PluginEntry, type SessionState, stateOf as pluginState, tool } from "@hortus/core";
import { Box, Text } from "ink";
import type { ComponentType } from "react";
import { z } from "zod";
import {
  type ChecklistItem,
  checklistWindow,
  doneSteps,
  formatTodoList,
  parseChecklist,
  renderCompleted,
  sameSteps,
} from "./checklist.ts";
import {
  loadConfig,
  type Phase,
  type PlannotatorConfig,
  projectConfigPath,
  renderTemplate,
  resolveProfile,
} from "./config.ts";
import { type Decision, openBrowser, type ReviewServer, startReviewServer } from "./server.ts";

const SUBMIT = "plannotator_submit_plan";
const DONE = "plannotator_mark_done";
const TOOL = "plannotator";

type Action = "plan-review" | "code-review" | "annotate" | "annotate-last";
interface SessionOpened {
  id: string;
  action: Action;
  url: string;
  openedAt: number;
  sessionId?: string;
  reviewId?: string;
  requestId?: string;
}
interface Response {
  status: "handled" | "pending" | "unhandled" | "error";
  result?: unknown;
  error?: string;
}

/** Plannotator's shared event bus (Pi: `pi.events`), so other plugins reuse its reviews and plan mode. */
declare module "@hortus/core" {
  interface Events {
    "plannotator:request": {
      requestId: string;
      action: "plan-mode" | "review-status" | Action;
      // biome-ignore lint/suspicious/noExplicitAny: each action's own payload (see the README of @plannotator/pi-extension)
      payload?: any;
      respond(response: Response): void;
    };
    "plannotator:review-result": { reviewId: string; approved: boolean; feedback?: string };
    "plannotator:plan-approved": { cwd: string; planFilePath: string; planContent: string; feedback?: string };
    "plannotator:session-opened": SessionOpened;
    "plannotator:session-closed": SessionOpened & {
      outcome: "approved" | "submitted" | "closed";
      closedBy?: "reviewer" | "agent" | "stopped";
      closedAt: number;
    };
  }
}

/** The session branch's plan mode (its last `plannotator:state` entry). */
interface PlanState {
  phase: Phase;
  planPath?: string;
  /** the plan text the reviewer approved: execution works from it, not the file (none for auto-approved plans) */
  approvedPlan?: string;
  items: ChecklistItem[];
  /** the phase's framing message is in the history (once per phase entry) */
  framingDelivered?: boolean;
  /** plan mode just ended: the next run gets the "plan mode off" notice */
  idleNoticePending?: boolean;
}
const IDLE: PlanState = { phase: "idle", items: [] };
const stateOf = (s: SessionState | undefined, plugin: string) => (s?.data[plugin] as PlanState | undefined) ?? IDLE;
const current = (ctx: Ctx) => stateOf(ctx.session?.getState(), ctx.plugin);

/** An open review page. */
interface Review {
  id: string;
  action: Action;
  subject: string;
  target?: string;
  url: string;
  /** the session that opened it */
  owner?: string;
  server: ReviewServer;
  /** the host ctx it delivers through (it follows the current session) */
  host: Ctx;
  opened: SessionOpened;
  /** a plan review's file and the text last pushed to it */
  plan?: { filePath: string; content: string };
}
/** Per agent (`ctx.state`). */
interface Shared {
  /** the host ctx from `init`: follows the current session, for decisions that arrive between runs */
  host?: Ctx;
  reviews: Map<string, Review>;
  /** sessions whose plan was auto-approved by the tool: continue once the run ends */
  justApproved: Set<string>;
  /** project config path → trusted, as `ctx.trust` last said (for `configNow`) */
  trusted: Map<string, boolean>;
  warned: Set<string>;
  /** plan reviews opened through the bus, by reviewId, once decided */
  results: Map<string, { approved: boolean; feedback?: string }>;
}
function shared(ctx: Ctx): Shared {
  return pluginState(
    ctx,
    "shared",
    (): Shared => ({
      reviews: new Map(),
      justApproved: new Set(),
      trusted: new Map(),
      warned: new Set(),
      results: new Map(),
    }),
  );
}
const hostOf = (ctx: Ctx) => shared(ctx).host ?? ctx;

const warnOnce = (ctx: Ctx, text: string) => {
  const { warned } = shared(ctx);
  if (!warned.has(text)) void ctx.notify(text, "warn");
  warned.add(text);
};

/** The project config is project input: load it only once the project is trusted (`ctx.trust`). */
async function trusted(ctx: Ctx): Promise<boolean> {
  const path = projectConfigPath(ctx.cwd);
  if (!existsSync(path)) return false;
  const ok = await ctx.trust(ctx.cwd, { reason: `(${path} can change models and phase instructions)` });
  shared(ctx).trusted.set(path, ok);
  if (!ok && !ctx.host.interactive) warnOnce(ctx, `Plannotator: skipping ${path}: the project isn't trusted`);
  return ok;
}

async function config(ctx: Ctx): Promise<PlannotatorConfig> {
  const { config, warnings } = loadConfig(ctx.cwd, await trusted(ctx));
  for (const w of warnings) warnOnce(ctx, `Plannotator config: ${w}`);
  return config;
}
/** Without asking: what the status bar and openers need. */
const configNow = (ctx: Ctx) =>
  loadConfig(ctx.cwd, shared(ctx).trusted.get(projectConfigPath(ctx.cwd)) === true).config;

/** Planning writes and plan files: markdown inside the working directory. */
function planPathAllowed(path: string, cwd: string) {
  const rel = relative(resolve(cwd), resolve(cwd, path));
  return (
    !!path &&
    rel !== "" &&
    !rel.startsWith("..") &&
    !isAbsolute(rel) &&
    [".md", ".mdx"].includes(extname(rel).toLowerCase())
  );
}

async function showStatus(ctx: Ctx, st = current(ctx)) {
  // the TUI shows the status of the session it's set on (`ctx.session`) only while that one is shown
  if (!ctx.session) return;
  const label = st.phase === "idle" ? undefined : resolveProfile(configNow(ctx), st.phase).statusLabel;
  const done = st.items.filter((i) => i.completed).length;
  const text = st.phase === "executing" && st.items.length ? `📋 ${done}/${st.items.length}` : label;
  // Pi's colors: planning in warning, executing in accent
  await ctx.status("plannotator", text && { text, color: st.phase === "planning" ? "yellow" : "accent" });
}

async function save(ctx: Ctx, patch: Partial<PlanState>) {
  if (!ctx.session) throw new Error("Plannotator: no session");
  const next = { ...current(ctx), ...patch };
  await ctx.session.appendEntry(`${ctx.plugin}:state`, next);
  await showStatus(ctx, next);
  return next;
}

/** Ends the open plan reviews of `session` without delivering anything. */
function stopPlanReviews(ctx: Ctx, session?: string) {
  for (const r of shared(ctx).reviews.values())
    if (r.action === "plan-review" && r.owner === session && r.plan) r.server.stop();
}

async function enterPlanning(ctx: Ctx) {
  await save(ctx, { phase: "planning", items: [], framingDelivered: false, idleNoticePending: false });
  if (!ctx.host.interactive)
    void ctx.notify("Plannotator: interactive plan review is unavailable here: plans auto-approve on submit.", "warn");
  return "Plannotator: planning mode enabled.";
}

async function returnToIdle(ctx: Ctx) {
  stopPlanReviews(ctx, ctx.session?.id);
  await save(ctx, {
    phase: "idle",
    planPath: undefined,
    approvedPlan: undefined,
    items: [],
    framingDelivered: false,
    idleNoticePending: true,
  });
}

async function togglePlanMode(ctx: Ctx) {
  if (current(ctx).phase === "idle") return enterPlanning(ctx);
  await returnToIdle(ctx);
  return "Plannotator: disabled. Full access restored.";
}

async function handoff(ctx: Ctx, planFilePath: string, planContent: string, feedback?: string) {
  await returnToIdle(ctx);
  await ctx.emit("plannotator:plan-approved", {
    cwd: ctx.cwd,
    planFilePath,
    planContent,
    ...(feedback && { feedback }),
  });
  void ctx.notify("Plannotator: approved plan handed off for external execution.");
}

async function markDone(ctx: Ctx, steps: number[]) {
  const st = current(ctx);
  const items = st.items.map((i) => (steps.includes(i.step) ? { ...i, completed: true } : i));
  if (st.planPath)
    try {
      const path = resolve(ctx.cwd, st.planPath);
      const content = readFileSync(path, "utf8");
      // an approved snapshot's checks go to the file only while it still holds that checklist
      if (st.approvedPlan === undefined || sameSteps(parseChecklist(content), items)) {
        const updated = renderCompleted(content, items);
        if (updated !== content) writeFileSync(path, updated);
      }
    } catch {}
  await save(ctx, { items });
}

// ── Messages (Plannotator's prompts, Pi runtime) ──────────────────────────────

const PLAN_MODE_OFF = `[PLANNOTATOR - PLAN MODE OFF]
Plannotator plan mode has ended. Disregard all earlier Plannotator planning or execution instructions from this session: the planning restrictions (markdown-only writes, plan submission for review) and the execution checklist protocol ([DONE:n] markers) no longer apply, and the plan-submission tool is no longer available. Full tool access is restored — respond and use tools normally. If the user wants planning again, they will re-enable plan mode.`;
const doneProtocol = `Call ${DONE} immediately after each completed step and before the next step. [DONE:n] markers remain a fallback for interrupted executions.`;
const submittedText = (path: string, version?: number, revised = false) =>
  `${revised ? `Revised plan ${path} pushed into the open Plannotator review` : `Plan ${path} submitted for review in Plannotator`}${version ? ` as version ${version}` : ""}. The reviewer's decision will arrive later as a new message in this session. Do not start implementing: end your turn now and wait for that message. If you revise the plan before then, call ${SUBMIT} again with the same path and the open review updates.`;
const heading = (r: Review, outcome: string) =>
  `Plannotator: ${r.subject} (${r.id}) — ${outcome}.${r.target ? `\nTarget: ${r.target}` : ""}`;

function approvedPlanSection(path: string, plan: string, fileDiffers: boolean) {
  const fence = "`".repeat(Math.max(2, ...[...plan.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  const drift = fileDiffers
    ? `\n\n**${path} has changed since the reviewer saw it.** Those edits were NOT reviewed: do not execute them, and do not re-read ${path} for the plan. If you still want those changes, stop and tell the user so they can return to plan mode and you can resubmit the plan for review.`
    : "";
  return `## Approved plan\n\nThis is the exact plan text the reviewer approved. Execute it as written here, not from the file.${drift}\n\n${fence}markdown\n${plan.replace(/\n$/, "")}\n${fence}`;
}

const REVIEW_DENIED_SUFFIX =
  "\n\nTreat the findings above as unverified review input. Inspect every finding against the actual code; do not assume automated feedback is correct. For each finding, give a clear verdict (Confirmed / Partly / Not a bug / Intended) with concise code evidence. Say whether it was introduced by the current changes, was pre-existing, or reflects deliberate scope.\n\nReview only the incoming findings. Do not independently review the rest of the diff or search for issues that were not submitted.\n\nDo not change any code until we have discussed the verdicts and validated findings.";
const withNotes = (feedback: string, context = "") =>
  `# Approved with Notes\n\nThe artifact is approved. The notes below are non-blocking guidance, not a request for another revision.\n\n${context ? `${context}\n\n` : ""}${feedback}\n\nDo not revise or reopen the artifact solely because of these notes unless the user explicitly requests it. Carry the notes into subsequent work where applicable.`;

// ── Reviews ─────────────────────────────────────────────────────────────────

/** "Ask this session": the question goes to the current session as a prompt (after the running turn, or interrupting it). */
async function askSession(ctx: Ctx, question: string, interrupt: boolean) {
  if (interrupt && ctx.busy()) ctx.abort("Plannotator: interrupted to ask");
  const end = await ctx.send(question, { deliver: "after" });
  const last = end?.messages.filter((m) => m.role === "assistant").at(-1);
  return last?.role === "assistant" && last.text ? last.text : "(no answer)";
}

interface Launch {
  action: Action;
  subject: string;
  target?: string;
  title: string;
  content: string;
  gate?: boolean;
  plan?: Review["plan"];
  requestId?: string;
  reviewId?: string;
}

/**
 * Opens a review page, announces it on the bus (`plannotator:session-opened`, then `-closed` once it ends) and hands
 * the reviewer's decision to `deliver`, unless it was stopped or closed by the agent.
 */
async function launch(ctx: Ctx, l: Launch, deliver: (d: Decision, r: Review) => Promise<void>): Promise<Review> {
  const sh = shared(ctx);
  const host = hostOf(ctx);
  const server = await startReviewServer({
    kind:
      l.action === "plan-review"
        ? "plan"
        : l.action === "code-review"
          ? "review"
          : l.action === "annotate"
            ? "annotate"
            : "last",
    title: l.subject,
    content: l.content,
    gate: l.gate,
    ask: (q, interrupt) => askSession(host, q, interrupt),
  });
  const id = `pn-${randomBytes(3).toString("hex")}`;
  const opened: SessionOpened = {
    id,
    action: l.action,
    url: server.url,
    openedAt: Date.now(),
    ...(ctx.session && { sessionId: ctx.session.id }),
    ...(l.reviewId && { reviewId: l.reviewId }),
    ...(l.requestId && { requestId: l.requestId }),
  };
  const review: Review = { id, ...l, url: server.url, owner: ctx.session?.id, server, host, opened };
  sh.reviews.set(id, review);
  void server.decision
    .then(async (d) => {
      sh.reviews.delete(id);
      await host.emit("plannotator:session-closed", {
        ...opened,
        outcome: d.exit ? "closed" : d.approved ? "approved" : "submitted",
        ...(d.exit && { closedBy: d.closedBy ?? "reviewer" }),
        closedAt: Date.now(),
      });
      if (d.closedBy === "stopped") return;
      if (d.closedBy === "agent")
        return void host.notify(`Plannotator: ${review.subject} (${id}) closed by the agent.`);
      await deliver(d, review);
    })
    .catch((e) => host.notify(`Plannotator: ${review.subject}: ${(e as Error).message}`, "error"));
  await host.emit("plannotator:session-opened", opened);
  openBrowser(server.url, configNow(ctx).browser);
  return review;
}

/** A follow-up to the current session: after the running turn, else at once. */
const followUp = (ctx: Ctx, text: string) =>
  void hostOf(ctx)
    .send(text, { deliver: "after" })
    .catch((e) => hostOf(ctx).notify(`Plannotator could not deliver feedback: ${(e as Error).message}`, "error"));

async function deliverPlanDecision(d: Decision, review: Review) {
  const ctx = review.host;
  if (ctx.session?.id !== review.owner || current(ctx).phase !== "planning" || !review.plan) return;
  const { filePath } = review.plan;
  const plan = d.plan ?? review.plan.content;
  if (!d.approved) {
    const feedback = d.feedback || "Plan rejected. Please revise.";
    return followUp(
      ctx,
      `YOUR PLAN WAS NOT APPROVED.\n\nYou MUST revise the plan to address ALL of the feedback below before calling ${SUBMIT} again.\n\nRules:\n- Your plan is saved at: ${filePath}\n  You can edit this file to make targeted changes, then pass its path to ${SUBMIT}.\n- Do not resubmit the same plan unchanged.\n- Do NOT change the plan title (first # heading) unless the user explicitly asks you to.\n\n${feedback}`,
    );
  }
  if ((await config(ctx)).executionMode === "external") {
    await handoff(ctx, filePath, plan, d.feedback);
    await ctx.send({
      content: "Plan approved and handed off for external execution.",
      meta: { plugin: ctx.plugin, type: "handoff", display: true, details: { planFilePath: filePath } },
    });
    return;
  }
  let fileDiffers = true;
  try {
    fileDiffers = readFileSync(resolve(ctx.cwd, filePath), "utf8") !== plan;
  } catch {}
  const items = parseChecklist(plan);
  await save(ctx, { phase: "executing", planPath: filePath, approvedPlan: plan, items, framingDelivered: false });
  const done = items.length ? ` ${doneProtocol}` : "";
  const approved = d.feedback
    ? `Plan approved with notes! You now have full tool access (read, bash, edit, write). Execute the plan in ${filePath}.${done}\n\n## Implementation Notes\n\nThe user approved your plan but added the following notes to consider during implementation:\n\n${d.feedback}\n\nProceed with implementation, incorporating these notes where applicable.`
    : `Plan approved. You now have full tool access (read, bash, edit, write). Execute the plan in ${filePath}.${done}`;
  followUp(ctx, `${approved}\n\n${approvedPlanSection(filePath, plan, fileDiffers)}`);
  void ctx.notify("Plannotator: plan approved.");
}
async function launchPlan(ctx: Ctx, filePath: string, content: string, extra: Partial<Launch> = {}) {
  return launch(
    ctx,
    {
      action: "plan-review",
      subject: `plan ${filePath}`,
      target: resolve(ctx.cwd, filePath),
      title: filePath,
      content,
      plan: { filePath, content },
      ...extra,
    },
    deliverPlanDecision,
  );
}

const run = promisify(execFile);

async function launchCodeReview(ctx: Ctx, dir = "", deliver?: (d: Decision, r: Review) => Promise<void>) {
  const cwd = resolve(ctx.cwd, dir);
  const git = (...args: string[]) => run("git", args, { cwd, maxBuffer: 64 << 20 }).then((r) => r.stdout);
  let diff: string;
  try {
    diff = await git("diff", "HEAD");
    const untracked = (await git("ls-files", "--others", "--exclude-standard")).split("\n").filter(Boolean);
    if (untracked.length) diff += `\n# Untracked files\n${untracked.join("\n")}\n`;
  } catch (e) {
    throw new Error(`Plannotator: no git changes to review in ${cwd}: ${(e as Error).message.split("\n")[0]}`);
  }
  if (!diff.trim()) throw new Error("Plannotator: no changes to review.");
  return launch(
    ctx,
    {
      action: "code-review",
      subject: `changes in ${relative(ctx.cwd, cwd) || "."}`,
      target: cwd,
      title: cwd,
      content: diff,
      gate: true,
    },
    deliver ??
      (async (d, r) => {
        if (d.exit) return void hostOf(ctx).notify("Code review session closed.");
        if (d.approved) {
          const body = d.feedback
            ? `# Code Review — Approved with Notes\n\nCode review completed — the changes are approved. The notes below are non-blocking guidance, not a request for another revision.\n\n${d.feedback}\n\nDo not revise or reopen the reviewed changes solely because of these notes unless the user explicitly requests it. Carry them into subsequent work where applicable.`
            : "# Code Review\n\nCode review completed — no changes requested.";
          return followUp(ctx, `${heading(r, d.feedback ? "Approved with notes" : "Approved")}\n\n${body}`);
        }
        if (!d.feedback) return void hostOf(ctx).notify("Code review closed (no feedback).");
        followUp(ctx, `${heading(r, "Changes requested")}\n\n${d.feedback}${REVIEW_DENIED_SUFFIX}`);
      }),
  );
}

/** Annotation outcomes: closed, approved (sent only when `deliverApproval`), notes, or feedback wrapped by `wrap`. */
const annotateOutcome =
  (ctx: Ctx, wrap: (feedback: string) => string, context: string | undefined, deliverApproval: boolean) =>
  async (d: Decision, r: Review) => {
    const host = hostOf(ctx);
    if (d.exit) return void host.notify("Annotation session closed.");
    if (d.approved && !d.feedback) {
      if (deliverApproval) followUp(ctx, `${heading(r, "Approved")}\n\nThe user approved.`);
      return void host.notify("Annotation approved.");
    }
    if (!d.feedback) return void host.notify("Annotation closed (no feedback).");
    followUp(
      ctx,
      `${heading(r, d.approved ? "Approved with notes" : "Feedback")}\n\n${d.approved ? withNotes(d.feedback, context) : wrap(d.feedback)}`,
    );
  };

async function launchAnnotate(
  ctx: Ctx,
  target: string,
  gate = false,
  deliver?: (d: Decision, r: Review) => Promise<void>,
) {
  if (!target) throw new Error("Usage: /plannotator-annotate <file.md | url>");
  let content: string;
  let where = target;
  if (/^https?:\/\//i.test(target)) {
    const res = await ctx.fetch(target);
    if (!res.ok) throw new Error(`Plannotator: ${target} answered ${res.status}`);
    content = await res.text();
  } else {
    where = resolve(ctx.cwd, target);
    if (statSync(where).isDirectory())
      throw new Error(
        "Plannotator: annotating a folder needs Plannotator's file browser, which this port doesn't have",
      );
    content = await readFile(where, "utf8");
  }
  return launch(
    ctx,
    { action: "annotate", subject: target, target: where, title: target, content, gate },
    deliver ??
      annotateOutcome(
        ctx,
        (f) => `# Markdown Annotations\n\nFile: ${where}\n\n${f}\n\nPlease address the annotation feedback above.`,
        `File: ${where}`,
        gate,
      ),
  );
}

async function launchLast(
  ctx: Ctx,
  gate = false,
  skipCallId?: string,
  deliver?: (d: Decision, r: Review) => Promise<void>,
) {
  const last = ctx.session
    ?.getState()
    .messages.filter((m) => m.role === "assistant" && m.text.trim() && !m.toolCalls.some((c) => c.id === skipCallId))
    .at(-1);
  if (last?.role !== "assistant") throw new Error("No assistant message found in session.");
  return launch(
    ctx,
    { action: "annotate-last", subject: "last message", title: "Last assistant message", content: last.text, gate },
    deliver ??
      annotateOutcome(
        ctx,
        (f) => `# Message Annotations\n\n${f}\n\nPlease address the annotation feedback above.`,
        undefined,
        gate,
      ),
  );
}

const openedText = (r: Review, gate: boolean) =>
  [
    `Session: ${r.id}`,
    `Opened ${r.subject} in Plannotator: ${r.url}`,
    'The reviewer is looking at it now. End your turn now and wait: their decision arrives later as a message in this conversation that starts with "Plannotator:".',
    gate
      ? "If they approve, an approval message arrives; if they send annotations, the feedback arrives. Closing it sends nothing."
      : "When they send annotations, the feedback arrives. Closing it with nothing to send sends nothing.",
    "Do not poll, reopen it, or run the plannotator CLI for this session.",
  ].join("\n");

// ── The plugin ──────────────────────────────────────────────────────────────

/** Ends the run after the tool's batch (Pi's `terminate: true`). */
const terminate = (ctx: { stop(): void }, text: string) => {
  ctx.stop();
  return text;
};

/**
 * Plannotator: file-based plan mode with a browser review. `/plannotator-plan-mode` toggles it: planning writes only
 * markdown inside the working directory, the model writes a plan file and submits it with `plannotator_submit_plan`,
 * which opens a local review page and ends the turn; the reviewer's decision comes back as a message (approve → the
 * executing phase, its checklist tracked with `plannotator_mark_done` / `[DONE:n]`; deny → revise). Phase framing is
 * a hidden message once per phase entry; the phase is a session entry. `/plannotator-review`, `/plannotator-annotate`
 * and `/plannotator-last` open code review and annotation pages the same way.
 */
export default {
  tools: [
    tool({
      name: SUBMIT,
      description:
        "Submit your Plannotator plan for user review. Call this only while Plannotator planning mode is active, after writing your plan as a markdown file anywhere inside the working directory. Pass the path to the plan file (e.g. PLAN.md or plans/auth.md). The user reviews the plan in a visual browser UI and can approve, deny with feedback, or annotate it. This tool returns as soon as the review is open; the decision arrives later as a new message, so end your turn and wait for it, and do not implement before approval. If you revise the plan while the review is open, call this again with the same path to update the open review. If denied, edit the same file in place, then call this again with the same path.",
      inputSchema: z.object({
        filePath: z
          .string()
          .describe(
            "Path to the markdown plan file, relative to the working directory. Must end in .md or .mdx and resolve inside cwd.",
          ),
      }),
      // an "edit plan + submit plan" batch: the edit lands first
      sequential: true,
      execute: async ({ filePath }, ctx) => {
        if (current(ctx).phase !== "planning")
          throw new Error("Not in plan mode. Use /plannotator-plan-mode to enter planning mode first.");
        const input = filePath.trim();
        if (!planPathAllowed(input, ctx.cwd))
          throw new Error(
            `plan file must be a markdown file (.md or .mdx) inside the working directory. Rejected: ${input}`,
          );
        let content: string;
        try {
          if (!statSync(resolve(ctx.cwd, input)).isFile()) throw new Error();
          content = readFileSync(resolve(ctx.cwd, input), "utf8");
        } catch {
          throw new Error(
            `${input} does not exist. Write your plan using the write tool first, then call ${SUBMIT} again.`,
          );
        }
        if (!content.trim()) throw new Error(`${input} is empty. Write your plan first, then call ${SUBMIT} again.`);

        if (!ctx.host.interactive) {
          if ((await config(ctx)).executionMode === "external") {
            await handoff(ctx, input, content);
            return terminate(ctx, "Plan approved and handed off for external execution.");
          }
          await save(ctx, {
            phase: "executing",
            planPath: input,
            approvedPlan: undefined,
            items: parseChecklist(content),
            framingDelivered: false,
          });
          if (ctx.session) shared(ctx).justApproved.add(ctx.session.id);
          return terminate(ctx, "Plan auto-approved (non-interactive mode). Execute the plan now.");
        }

        // a plan already in review: the open page shows the revision
        const open = [...shared(ctx).reviews.values()].find((r) => r.plan && r.owner === ctx.session?.id);
        if (open?.plan) {
          const rev = open.server.update(content);
          if (!rev)
            return terminate(
              ctx,
              `The reviewer has just decided on the version of the plan that was open for review, so this revision was not sent. Do not start implementing: end your turn now and wait for the reviewer's decision, which arrives as a new message in this session. If it asks for changes, call ${SUBMIT} again afterwards.`,
            );
          open.plan = { filePath: input, content };
          if (rev.unchanged)
            return terminate(
              ctx,
              `${input} is unchanged from the plan already open for review. Do not start implementing: end your turn now and wait for the reviewer's decision, which arrives as a new message in this session.`,
            );
          void ctx.notify(`Plannotator: revised plan sent to the open review (version ${rev.version}).`);
          return terminate(ctx, submittedText(input, rev.version, true));
        }
        const review = await launchPlan(ctx, input, content);
        void ctx.notify(`Plannotator: plan review opened: ${review.url}`);
        return terminate(ctx, submittedText(input));
      },
    }),
    tool({
      name: DONE,
      description:
        "Mark one approved-plan checklist step complete. Call this immediately after finishing each step and before starting the next one.",
      inputSchema: z.object({
        step: z.number().int().describe("One-based number of the completed plan checklist step."),
      }),
      execute: async ({ step }, ctx) => {
        const st = current(ctx);
        if (st.phase !== "executing") throw new Error("No approved plan is executing.");
        if (!st.items.some((i) => i.step === step)) throw new Error(`Plan checklist step ${step} does not exist.`);
        await markDone(ctx, [step]);
        ctx.update({ completed: true, step });
        return `Plan checklist step ${step} marked complete.`;
      },
    }),
    tool({
      name: TOOL,
      description: [
        "Open Plannotator, the browser review UI, for the user, and return at once. Also lists and closes the reviews opened in this conversation (by this tool or the user's /plannotator-* commands).",
        '- action "annotate": annotate a file or a URL; `target` is required. `gate: true` adds an Approve button for an explicit sign-off.',
        '- action "review": review code changes; `target` is an optional repository directory. `gate: true` when you wait for the sign-off: a bare Approve reaches you too.',
        '- action "last": annotate your own last assistant message; no target.',
        '- action "list": the reviews opened in this conversation that are still open, one line each.',
        '- action "close": close a review opened in this conversation; `session` is its id (pn-...) or "all". Nothing is sent to you. Plan reviews are not closed this way.',
        "Opening only opens the page and names its session id (pn-...). The reviewer's feedback arrives later as a message that names the same id, so end your turn after opening and wait for it.",
      ].join("\n"),
      inputSchema: z.object({
        action: z.enum(["annotate", "review", "last", "list", "close"]),
        target: z.string().optional(),
        gate: z.boolean().optional(),
        session: z.string().optional(),
      }),
      execute: async ({ action, target, gate = false, session }, ctx) => {
        const mine = [...shared(ctx).reviews.values()].filter((r) => r.owner === ctx.session?.id);
        if (action === "list")
          return (
            mine
              .map((r) => `${r.id}  ${r.subject}  ${r.url}  ${Math.round((Date.now() - r.opened.openedAt) / 1000)}s`)
              .join("\n") || "No open reviews."
          );
        if (action === "close") {
          const closing = mine.filter((r) => !r.plan && (session === "all" || r.id === session));
          if (!closing.length)
            throw new Error(`No open review ${session ?? ""} to close (plan reviews end with a decision).`);
          for (const r of closing) r.server.stop("agent");
          return `Closed ${closing.map((r) => r.id).join(", ")}.`;
        }
        const review =
          action === "annotate"
            ? await launchAnnotate(ctx, target ?? "", gate)
            : action === "review"
              ? await launchCodeReview(ctx, target)
              : await launchLast(ctx, gate, ctx.callId);
        return terminate(ctx, openedText(review, gate || action === "review"));
      },
    }),
  ],
  entries: {
    state: (entry: PluginEntry<PlanState>, state, plugin) => {
      state.data[plugin] = entry.data;
    },
  },
  on: {
    init: (_, ctx) => {
      shared(ctx).host = ctx;
    },
    session_open: (_, ctx) => showStatus(ctx),
    // a plan decision belongs to the session that is planning: its review ends with it
    session_closed: ({ session }, ctx) => stopPlanReviews(ctx, session.id),
    // a compaction may have summarized the framing away: the next run delivers it again
    compacted: async (_, ctx) => {
      if (current(ctx).phase !== "idle") await save(ctx, { framingDelivered: false });
    },
    close: (_, ctx) => {
      for (const r of shared(ctx).reviews.values()) r.server.stop();
    },
    run_start: async (p, ctx) => {
      const st = current(ctx);
      const cfg = await config(ctx);
      const agentTool = cfg.agentTool === true || process.env.PLANNOTATOR_AGENT_TOOL === "1";
      p.tools = p.tools.filter(
        (t) =>
          (t.name !== SUBMIT || st.phase === "planning") &&
          (t.name !== DONE || st.phase === "executing") &&
          // nothing could deliver a decision to a host nobody answers
          (t.name !== TOOL || (agentTool && ctx.host.interactive)),
      );
      if (st.phase === "idle") {
        if (p.source === "run" && st.idleNoticePending) {
          await save(ctx, { idleNoticePending: false });
          await ctx.send({
            content: PLAN_MODE_OFF,
            meta: { plugin: ctx.plugin, type: "framing", display: false, details: { phase: "idle" } },
          });
        }
        return;
      }
      const profile = resolveProfile(cfg, st.phase);
      if (profile.model)
        try {
          await ctx.resolve({ provider: profile.model.provider, model: profile.model.id });
          p.provider = profile.model.provider;
          p.model = profile.model.id;
        } catch (e) {
          warnOnce(
            ctx,
            `Plannotator: ${st.phase} model ${profile.model.provider}/${profile.model.id}: ${(e as Error).message}`,
          );
        }
      if (profile.thinking) p.effort = profile.thinking;
      // the phase's tools join the run's (the agent's own, should another plugin have taken one out)
      for (const name of profile.activeTools) {
        const t = hostOf(ctx).tools.find((t) => t.name === name);
        if (t && !p.tools.some((x) => x.name === name)) p.tools.push(t);
      }
      if (p.source !== "run") return;

      let items = st.items;
      if (st.phase === "executing" && st.planPath && st.approvedPlan === undefined) {
        // an auto-approved plan's file is the plan: re-read it every run
        try {
          items = parseChecklist(readFileSync(resolve(ctx.cwd, st.planPath), "utf8"));
        } catch {
          await returnToIdle(ctx);
          return void ctx.notify(`Plannotator: ${st.planPath} is gone; plan mode is off.`, "warn");
        }
      }
      const planRef =
        st.planPath && st.approvedPlan !== undefined
          ? `the approved plan in the approval message (${st.planPath} as the reviewer approved it)`
          : (st.planPath ?? "your plan file");
      const todo = formatTodoList(st.phase === "executing" ? items : []);
      const todoStatus =
        st.phase === "executing" && todo.remainingCount > 0
          ? `[PLANNOTATOR - EXECUTING PLAN]\nTodo status for ${planRef}: ${todo.completedCount}/${todo.totalCount} steps complete.\n\nRemaining steps:\n${todo.todoList}\n\n${doneProtocol}`
          : undefined;
      let content = todoStatus;
      let type = "context";
      if (!st.framingDelivered && profile.instructions) {
        const rendered = renderTemplate(profile.instructions, { planFilePath: planRef, phase: st.phase, ...todo });
        if (rendered.unknown.length)
          warnOnce(
            ctx,
            `Plannotator: unknown template variables in ${st.phase} instructions: ${rendered.unknown.join(", ")}`,
          );
        content = rendered.text;
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the template variable, literally
        if (todoStatus && !profile.instructions.includes("${todoList}")) content += `\n\n${todoStatus}`;
        type = "framing";
      }
      if (!st.framingDelivered || items !== st.items) await save(ctx, { framingDelivered: true, items });
      if (content)
        await ctx.send({ content, meta: { plugin: ctx.plugin, type, display: false, details: { phase: st.phase } } });
    },
    // a gate: on the input that runs, after every tool_call handler
    tool_gate: ({ call }, ctx) => {
      if ((call.name !== "write" && call.name !== "edit") || current(ctx).phase !== "planning") return;
      const path = (call.input as { path?: unknown }).path;
      if (typeof path !== "string" || !planPathAllowed(path, ctx.cwd))
        throw new Error(
          `Plannotator: during planning, ${call.name === "write" ? "writes" : "edits"} are limited to markdown files (.md, .mdx) inside the working directory. Blocked: ${String(path)}`,
        );
    },
    turn_end: async (p, ctx) => {
      const st = current(ctx);
      if (st.phase !== "executing" || !st.items.length) return;
      const steps = doneSteps(p.assistant.text);
      if (steps.length) await markDone(ctx, steps);
    },
    run_end: async (p, ctx) => {
      if (p.source !== "run" || !ctx.session) return;
      const st = current(ctx);
      if (st.phase !== "executing") return;
      if (shared(ctx).justApproved.delete(ctx.session.id)) {
        if (!p.aborted && !p.error) void ctx.send("Continue with the approved plan.", { deliver: "steer" });
        return;
      }
      if (st.items.length && st.items.every((i) => i.completed)) {
        await ctx.send({
          content: `**Plan Complete!** ✓\n\n${st.items.map((i) => `- [x] ~~${i.text}~~`).join("\n")}`,
          meta: { plugin: ctx.plugin, type: "complete", display: true },
        });
        await returnToIdle(ctx);
      }
    },
    "plannotator:request": async (req, ctx) => {
      const { action, payload = {}, respond } = req;
      // a request/response review: the decision goes back to the caller, not to the model
      const answer = async (d: Decision) => respond({ status: "handled", result: d });
      try {
        if (action === "plan-mode") {
          const mode = payload.mode ?? "toggle";
          const phase = current(ctx).phase;
          if (mode === "toggle" || (mode === "enter" && phase === "idle") || (mode === "exit" && phase !== "idle"))
            await togglePlanMode(ctx);
          return respond({ status: "handled", result: { phase: current(ctx).phase } });
        }
        if (action === "plan-review") {
          const reviewId = `review-${randomBytes(6).toString("hex")}`;
          const sh = shared(ctx);
          await launch(
            ctx,
            {
              action,
              subject: "plan",
              title: payload.planFilePath ?? "Plan",
              content: String(payload.planContent ?? ""),
              gate: true,
              reviewId,
              requestId: req.requestId,
            },
            async (d) => {
              const result = { approved: d.approved === true, ...(d.feedback && { feedback: d.feedback }) };
              sh.results.set(reviewId, result);
              await hostOf(ctx).emit("plannotator:review-result", { reviewId, ...result });
            },
          );
          return respond({ status: "handled", result: { status: "pending", reviewId } });
        }
        if (action === "review-status") {
          const done = shared(ctx).results.get(payload.reviewId);
          return respond({
            status: "handled",
            result: done ? { status: "completed", ...done } : { status: "pending" },
          });
        }
        if (action === "code-review") return void (await launchCodeReview(ctx, payload.cwd, answer));
        if (action === "annotate") return void (await launchAnnotate(ctx, payload.filePath, false, answer));
        if (action === "annotate-last") return void (await launchLast(ctx, false, undefined, answer));
        respond({ status: "unhandled" });
      } catch (e) {
        respond({ status: "error", error: (e as Error).message });
      }
    },
  },
  commands: [
    {
      name: "plannotator-plan-mode",
      description: "Toggle Plannotator planning mode",
      run: (_, ctx) => togglePlanMode(ctx),
    },
    {
      name: "plannotator-review",
      args: "[directory]",
      description: "Review the current changes in Plannotator",
      run: async (arg, ctx) => `Code review opened: ${(await launchCodeReview(ctx, arg.trim())).url}`,
    },
    {
      name: "plannotator-annotate",
      args: "<file.md | url>",
      description: "Annotate a file or URL in Plannotator",
      run: async (arg, ctx) => `Annotation opened: ${(await launchAnnotate(ctx, arg.trim())).url}`,
    },
    {
      name: "plannotator-last",
      description: "Annotate the last assistant message in Plannotator",
      run: async (_, ctx) => `Last-message annotation opened: ${(await launchLast(ctx)).url}`,
    },
  ],
  cli: { aboveInput: Progress },
} satisfies CliPlugin;

/** The executing plan's checklist above the input (Pi's `plannotator-progress` widget). */
function Progress({ Default }: { Default: ComponentType }) {
  const plugin = usePluginCtx().plugin;
  const st = useSession((s) => s.data[plugin] as PlanState | undefined);
  useTheme();
  return (
    <Box flexDirection="column" flexShrink={0}>
      {st?.phase === "executing" && st.items.length ? (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          {checklistWindow(st.items).map((i) => (
            <Text key={i.step} color={i.completed ? theme.dim : theme.text} strikethrough={i.completed}>
              {`${i.completed ? "☑" : "☐"} ${i.text}`}
            </Text>
          ))}
        </Box>
      ) : null}
      <Default />
    </Box>
  );
}
