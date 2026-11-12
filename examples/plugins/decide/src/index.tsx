import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { CliPlugin } from "@hortus/cli";
import { type AskEvent, type AskRequest, type Ctx, hortusDir, type Session, tool } from "@hortus/core";
import { z } from "zod";
import { DecideDialog } from "./dialog.tsx";
import {
  type DecideConfig,
  type DecisionResult,
  type DialogAnswer,
  type DialogOutcome,
  describePolicy,
  formatResult,
  fromDialog,
  fromGeneric,
  type HostKind,
  loadConfig,
  type PolicyMode,
  type Question,
  type Questionnaire,
  resolvePolicy,
  runAutopilot,
  statusBadge,
  synthesizeAnswers,
  validateQuestionnaire,
  buildTranscript,
  type Answer,
} from "./engine.ts";

/** The `ask` kind of a questionnaire: its rich dialog is `cli.asks[KIND]`. */
export const KIND = "decide";
export const TOOL_NAME = "ask_user_question";
const STATUS_KEY = "decide";

/** What a questionnaire's ask carries in `data`, for the countdown (this plugin's `ask` handler) and the dialog. */
export interface AskData {
  questionnaire: Questionnaire;
  /** the question the ask's generic fields describe (a remote answerer's plain answer is to it) */
  index: number;
  /** seconds after it is shown until the autopilot takes over; none = waits forever */
  timeoutSeconds?: number;
  deadlineKind: "auto" | "deadline";
  hint?: string;
  bell: boolean;
}

/** The rich dialog's answers (an `Answer` can't carry notes, free text per question, or several questions): its `value`. */
export interface DialogResult {
  answers: [number, DialogAnswer][];
  globalNote?: string;
}

export const configPath = () => join(hortusDir(), "decide.json");

/** `/decide` overrides, per session and not saved (Pi's are this session's too). */
interface Overrides {
  mode?: PolicyMode;
  timeout?: number;
  deadline?: number;
}
const overrides = new WeakMap<Session, Overrides>();
// ponytail: an agent without a session (an embedder's) shares one set process-wide; key by agent if that matters
const sessionless: Overrides = {};
const overridesOf = (ctx: Ctx): Overrides => {
  if (!ctx.session) return sessionless;
  const o = overrides.get(ctx.session) ?? {};
  overrides.set(ctx.session, o);
  return o;
};

/** The config file, re-read every call, with the session's `/decide` delays merged in. */
function effectiveConfig(ctx: Ctx): DecideConfig {
  const { config, warning } = loadConfig(configPath());
  if (warning) void ctx.notify(`[decide] ${warning}`, "warn");
  const o = overridesOf(ctx);
  return {
    ...config,
    autopilot: {
      ...config.autopilot,
      ...(o.timeout !== undefined && { timeoutSeconds: o.timeout }),
      ...(o.deadline !== undefined && { deadlineSeconds: o.deadline }),
    },
  };
}

const hostKind = (ctx: Ctx): HostKind => (!ctx.host.interactive ? "none" : ctx.host.kind === "tui" ? "tui" : "rpc");

const policyOf = (ctx: Ctx, config: DecideConfig, perCallMode?: "ask" | "auto") => {
  const o = overridesOf(ctx);
  return resolvePolicy({
    config,
    host: hostKind(ctx),
    ...(o.mode && { sessionMode: o.mode }),
    ...(o.deadline !== undefined && { sessionDeadline: o.deadline }),
    ...(perCallMode && { perCallMode }),
  });
};

const paintStatus = (ctx: Ctx) => {
  const r = policyOf(ctx, effectiveConfig(ctx));
  return ctx.status(STATUS_KEY, statusBadge(r.mode, r.timeoutSeconds, overridesOf(ctx).mode !== undefined));
};

/** The generic fields of question `i`: what a host without the rich dialog (or a remote answerer) shows. */
function generic(q: Questionnaire, i: number): AskRequest {
  const question = q.questions[i] as Question;
  const parts = [question.question];
  if (question.recommended !== undefined)
    parts.push(
      `Recommended: ${question.recommended}${question.recommendedBecause ? ` — ${question.recommendedBecause}` : ""}`,
    );
  for (const o of question.options)
    if (o.preview?.trim()) parts.push(`Preview — ${o.label}:\n${o.preview.trim().slice(0, 280)}`);
  if (q.questions.length > 1) parts.push(`(${i + 1} of ${q.questions.length})`);
  return {
    question: parts.join("\n\n"),
    options: question.options.map((o) => ({
      label: o.label,
      description: question.recommended === o.label ? `${o.description} ★ recommended` : o.description,
    })),
    ...(question.multiSelect && { multi: true }),
    allowText: true,
  };
}

/**
 * Puts the questionnaire to a human: in the TUI one ask (its rich dialog shows every question), elsewhere one generic
 * ask per question. Either way this plugin's `ask` handler races it with the countdown.
 */
async function askHuman(
  ctx: Ctx,
  q: Questionnaire,
  r: ReturnType<typeof policyOf>,
  bell: boolean,
): Promise<DialogOutcome> {
  const base = {
    questionnaire: q,
    ...(r.timeoutSeconds > 0 && { timeoutSeconds: r.timeoutSeconds }),
    deadlineKind: r.deadlineKind,
    ...(r.mode === "auto" && r.timeoutSeconds > 0 && { hint: "no one has answered" }),
    bell,
  };
  const answers = new Map<number, DialogAnswer>();
  for (let i = 0; i < (hostKind(ctx) === "tui" ? 1 : q.questions.length); i++) {
    const data: AskData = { ...base, index: i };
    const { answer, value, reason } = await ctx.ask({ kind: KIND, ...generic(q, i), data }, { detailed: true });
    const result = value as DialogResult | undefined;
    if (result) return { kind: "answered", answers: new Map(result.answers), globalNote: result.globalNote };
    if (answer === undefined)
      return reason === "timeout" ? { kind: "autopilot", waitedSeconds: r.timeoutSeconds } : { kind: "cancelled" };
    answers.set(i, fromGeneric(q.questions[i] as Question, answer));
  }
  return { kind: "answered", answers };
}

/** The session's model (or `judge.model`) answers the questionnaire in the user's place. */
async function answerWithAutopilot(
  ctx: Ctx,
  q: Questionnaire,
  config: DecideConfig,
  why: string,
  source: Answer["source"],
  waited?: number,
): Promise<DecisionResult> {
  const transcript = buildTranscript(ctx.session?.getState().messages ?? [], config.judge);
  const pinned = config.judge.model;
  let usable = true;
  if (pinned)
    try {
      await ctx.resolve(pinned);
    } catch {
      usable = false;
      const message = `judge.model ${pinned.provider}/${pinned.model} is not a known model — falling back to the first option. Fix judge.model in ${configPath()}, or remove it to use the session model.`;
      if (config.notify) await ctx.notify(message, "error");
    }
  const result = await runAutopilot(q, {
    transcript,
    ...(usable && {
      complete: async (system: string, user: string) =>
        (
          await ctx.complete({
            system,
            messages: [{ role: "user", content: user }],
            ...(pinned ?? {}),
            signal: AbortSignal.timeout(config.judge.timeoutMs),
          })
        ).text,
    }),
    ...(config.debug && { log: (m: string) => void ctx.notify(m, "warn") }),
  });
  const answers = synthesizeAnswers(result.verdict, q, source, waited);
  const n = `${answers.length} question${answers.length === 1 ? "" : "s"}`;
  if (config.notify)
    await ctx.notify(
      source === "timeout" ? `No response — the autopilot answered ${n}.` : `Autopilot answered ${n} (${why}).`,
    );
  if (result.refused.length) {
    const headers = result.refused.map((x) => x.header).join(", ");
    if (config.notify)
      await ctx.notify(
        `Autopilot refused ${result.refused.length} irreversible question${result.refused.length === 1 ? "" : "s"} — blocked on you (${headers}).`,
        "warn",
      );
    return {
      answers,
      outcome: "refused",
      reason: `an irreversible decision with no cautious option needs a human (${headers})`,
      unanswered: result.refused.map((x) => x.header),
      refused: result.refused,
      ...(result.guarded.length && { guarded: result.guarded }),
    };
  }
  return {
    answers,
    outcome: source === "timeout" ? "timeout" : "autopilot",
    reason: result.judged ? result.verdict.summary : (result.fallbackReason ?? result.verdict.summary),
    unanswered: [],
    ...(result.guarded.length && { guarded: result.guarded }),
  };
}

const Option = z.object({
  label: z
    .string()
    .min(1)
    .max(80)
    .describe(
      "Display text the user picks (1-5 words). Must be unique within its question. Do NOT author `Other` or `Type something.` — those rows are appended automatically.",
    ),
  description: z.string().min(1).describe("What this choice means, or what it costs. One sentence."),
  preview: z
    .string()
    .optional()
    .describe(
      "Optional markdown rendered under the option when focused: an ASCII mockup, a code diff, a config fragment. Single-select questions only.",
    ),
});

const QuestionnaireSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z
          .string()
          .min(1)
          .describe(
            'The complete question, ending in a question mark. Example: "Which cache eviction policy should the session store use?" For multiSelect, phrase it plurally.',
          ),
        header: z
          .string()
          .min(1)
          .max(24)
          .describe('Very short tab label / category chip, 1-3 words. Examples: "Cache", "Migration", "Release".'),
        category: z
          .string()
          .max(40)
          .optional()
          .describe('Optional wider grouping used in the answer summary, e.g. "database" or "rollout".'),
        options: z.array(Option).min(2).describe("Authored choices. Mutually exclusive unless multiSelect is true."),
        multiSelect: z.boolean().optional().describe("Allow more than one choice. Use for non-exclusive options."),
        recommended: z
          .string()
          .max(80)
          .optional()
          .describe(
            "Label of the option you would pick. Must match an option label verbatim. Marked in the UI and used as the autopilot default.",
          ),
        recommendedBecause: z
          .string()
          .max(200)
          .optional()
          .describe("One clause on why that option is best. Shows next to the recommendation."),
        irreversible: z
          .boolean()
          .optional()
          .describe(
            "Set true when the choice cannot be undone (deleting data, force-pushing, spending money, publishing). The autopilot then only takes the cautious option, and refuses to answer if no option is cautious. Wording that already reads as irreversible is detected automatically — set this only when that scan would miss it.",
          ),
      }),
    )
    .min(1)
    .describe("Questions to ask, in the order they should be presented."),
  context: z
    .string()
    .max(600)
    .optional()
    .describe(
      "One or two lines on the decision being made, so an autopilot answering in your place understands the goal.",
    ),
  mode: z
    .enum(["ask", "auto"])
    .optional()
    .describe(
      'Per-call override: "auto" lets the autopilot answer without a human; "ask" always waits for the human (ignored when the session policy is "on").',
    ),
});

const DESCRIPTION = `Ask the user one or more structured questions when a decision genuinely needs a human: unclear requirements, mutually exclusive implementation choices, or a direction only the owner can pick.

The dialog offers written-out options with descriptions, a free-text row, per-question notes, and a Submit tab that reviews everything before it goes back. Up to 8 questions with 2-8 options each. Provide a \`preview\` (markdown mockup, diff, config) when the choice is easier to see than to describe.

Set \`multiSelect: true\` when the options are not mutually exclusive and the user may want several of them. The answer comes back with every checked label. Do not force a non-exclusive choice into a single one with an "all of the above" option.

Autopilot: when the session policy is \`on\`, or the host has no UI, or the user is away and the countdown expires, a model answers these questions on the user's behalf and the result is labelled as such. Mark your own best option with \`recommended\` — the autopilot uses it as the default, so a good recommendation is what keeps an unattended run on track.`;

const PROMPT = [
  "Use ask_user_question when the request is underspecified and you cannot proceed without a concrete decision. Do not use it to confirm something you can verify yourself.",
  'Every question needs 2-8 options with one-sentence descriptions. Never author an "Other" or "Type something." option — that row is appended automatically.',
  'Ask a multi-select question (`multiSelect: true`, phrased plurally) when the choices are not mutually exclusive. Inventing an "All of the above" option instead loses which items were actually chosen.',
  "Always set `recommended` to the label of the option you would pick, with a short `recommendedBecause`. The autopilot falls back to it, so this is what decides an unattended run.",
  "Do not stack several ask_user_question calls back to back. Group the questions into one invocation.",
  "Check the result envelope: answers marked `[autopilot]` were not chosen by the user. State the assumption in your final report rather than implying it was approved.",
]
  .map((l) => `- ${l}`)
  .join("\n");

const USAGE = "Usage: /decide [off|on|auto|hold|deadline|status|reset] [seconds]";

/**
 * pi-decide: `ask_user_question` puts structured questions to the user (a tabbed dialog in the TUI), and an autopilot
 * answers them when nobody does: per policy (`/decide`, `~/.hortus/decide.json`), headless, or when the countdown runs
 * out. Its answers are labelled as such, and irreversible questions only get a cautious answer or none.
 */
export default {
  tools: [
    tool({
      name: TOOL_NAME,
      description: DESCRIPTION,
      prompt: PROMPT,
      inputSchema: QuestionnaireSchema,
      execute: async (input, ctx) => {
        const config = effectiveConfig(ctx);
        const finish = (r: DecisionResult, isError = false) => {
          const { outcome, answers, unanswered, reason, globalNote } = r;
          ctx.update({ outcome, answers, unanswered, reason, globalNote });
          const text = formatResult(r);
          if (isError) throw new Error(text);
          return text;
        };
        const rejected = (reason: string, isError: boolean) =>
          finish({ answers: [], outcome: "rejected", reason, unanswered: [] }, isError);
        if (!config.enabled) return rejected("decide is disabled in the config file (enabled: false)", false);
        const v = validateQuestionnaire(input, config.limits);
        if (!v.ok) return rejected(v.message, true);
        const q = v.questionnaire;
        if (v.warnings.length && config.debug) void ctx.notify(`[decide] ${v.warnings.join("; ")}`, "warn");
        const r = policyOf(ctx, config, q.mode);
        if (!r.ask) return finish(await answerWithAutopilot(ctx, q, config, r.why, "autopilot"));
        const outcome = await askHuman(ctx, q, r, config.ui.bell);
        if (outcome.kind === "answered") return finish(fromDialog(q, outcome));
        if (outcome.kind === "cancelled")
          return finish({ answers: [], outcome: "cancelled", unanswered: q.questions.map((x) => x.header) });
        return finish(
          await answerWithAutopilot(
            ctx,
            q,
            config,
            `no answer within ${outcome.waitedSeconds}s`,
            "timeout",
            outcome.waitedSeconds,
          ),
        );
      },
    }),
  ],
  commands: [
    {
      name: "decide",
      description:
        "Autopilot policy for ask_user_question: `off` asks (capped by the deadline), `auto N` asks then self-answers after N seconds, `on` never asks, `hold` waits forever",
      args: "[off|on|auto|hold|deadline|status|reset] [seconds]",
      complete: () => ["status", "off", "on", "auto", "hold", "deadline", "reset"].map((value) => ({ value })),
      run: async (arg, ctx) => {
        const [head = "", n] = arg.trim().toLowerCase().split(/\s+/);
        const seconds = n === undefined ? Number.NaN : Number.parseInt(n, 10);
        const hasSeconds = Number.isFinite(seconds) && seconds >= 0;
        const o = overridesOf(ctx);
        const config = effectiveConfig(ctx);
        if (head === "" || head === "status") {
          const r = policyOf(ctx, config);
          return [
            `ask_user_question: ${describePolicy(r.mode, r.timeoutSeconds)}`,
            `config: mode ${config.autopilot.mode} · auto ${config.autopilot.timeoutSeconds}s · deadline ${config.autopilot.deadlineSeconds}s (0 = none)`,
            `session mode: ${o.mode ?? "none"}`,
            `session auto delay: ${o.timeout !== undefined ? `${o.timeout}s` : "none"}`,
            `session deadline: ${o.deadline === undefined ? "none" : o.deadline === 0 ? "disabled (waits forever)" : `${o.deadline}s`}`,
            r.why,
          ].join("\n");
        }
        if (head === "reset" || head === "clear") {
          delete o.mode;
          delete o.timeout;
          delete o.deadline;
          await paintStatus(ctx);
          const base = effectiveConfig(ctx);
          return `Autopilot back to the configured policy: ${describePolicy(base.autopilot.mode, base.autopilot.timeoutSeconds)}`;
        }
        if (head === "hold") {
          o.mode = "off";
          o.deadline = 0;
          await paintStatus(ctx);
          await ctx.notify(
            "Autopilot held: this session asks and waits indefinitely. No safety net — the run can block until you answer. (/decide reset to undo)",
            "warn",
          );
          return;
        }
        if (head === "deadline") {
          if (!hasSeconds) throw new Error("Usage: /decide deadline <seconds> (0 disables the safety net)");
          o.deadline = seconds;
          await paintStatus(ctx);
          const text =
            seconds === 0
              ? "Safety net disabled: an `off` dialog now waits forever."
              : `Safety net: an \`off\` dialog self-answers after ${seconds}s of no input.`;
          if (seconds === 0) return void (await ctx.notify(text, "warn"));
          return text;
        }
        if (head !== "off" && head !== "on" && head !== "auto") throw new Error(USAGE);
        o.mode = head;
        if (hasSeconds) o.timeout = seconds;
        await paintStatus(ctx);
        const r = policyOf(ctx, effectiveConfig(ctx));
        const describe =
          head === "off"
            ? `ask the human, but the autopilot answers after ${r.timeoutSeconds}s if nobody does${r.timeoutSeconds === 0 ? " (safety net disabled!)" : ""}`
            : head === "on"
              ? "never ask — the model answers every questionnaire"
              : `ask, then self-answer after ${r.timeoutSeconds}s`;
        const text = `Autopilot for this session: ${describe}.${head === "on" ? "" : " (/decide reset to undo)"}`;
        if (head === "off" && r.timeoutSeconds === 0) return void (await ctx.notify(text, "warn"));
        return text;
      },
    },
  ],
  on: {
    session_open: (_e, ctx) => paintStatus(ctx),
    /**
     * The countdown: from when the ask is shown (the dialog, or a remote client), it races whoever answers and dismisses
     * the ask ("timeout") when it runs out first; someone engaging (the dialog's first key) stops it.
     */
    ask: async (e: AskEvent, ctx: Ctx) => {
      const data = e.data as AskData | undefined;
      if (e.kind !== KIND || data?.timeoutSeconds === undefined || e.signal.aborted) return;
      // nothing shows asks on a non-interactive host: count from now
      if (ctx.host.interactive) await Promise.race([e.shown, e.answered]);
      if (e.signal.aborted) return;
      const timer = new AbortController();
      const out = await Promise.race([
        sleep(data.timeoutSeconds * 1000, "timeout", { signal: timer.signal }),
        e.engaged.then(() => "engaged"),
        e.answered.then(() => "answered"),
      ]);
      timer.abort();
      if (out === "timeout") e.resolve(undefined, { reason: "timeout" });
    },
  },
  cli: { asks: { [KIND]: DecideDialog } },
} satisfies CliPlugin;
