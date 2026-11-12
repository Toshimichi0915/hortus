/**
 * pi-decide's host-free engine: config, policy, the safety rail, validation, the autopilot judge and the answer
 * envelope. Ported from pi-decide's `config.ts`, `policy.ts`, `safety.ts`, `tool/validate.ts`, `decide.ts`,
 * `autopilot.ts`, `transcript.ts` and `tool/envelope.ts`; nothing here touches hortus's runtime.
 */
import { readFileSync } from "node:fs";
import type { Message } from "@hortus/core";

// --- types ---------------------------------------------------------------------------------------------------------

export type AnswerSource = "user" | "autopilot" | "timeout" | "abandoned";
export type PolicyMode = "off" | "on" | "auto";

export interface Option {
  label: string;
  description: string;
  preview?: string;
}

export interface Question {
  question: string;
  header: string;
  category?: string;
  options: Option[];
  multiSelect?: boolean;
  recommended?: string;
  recommendedBecause?: string;
  irreversible?: boolean;
}

export interface Questionnaire {
  questions: Question[];
  context?: string;
  mode?: "ask" | "auto";
}

export interface Answer {
  index: number;
  header: string;
  question: string;
  selected: string[];
  text?: string;
  source: AnswerSource;
  note?: string;
  waitedSeconds?: number;
}

export interface DecisionResult {
  answers: Answer[];
  outcome: "answered" | "autopilot" | "timeout" | "cancelled" | "refused" | "rejected";
  reason?: string;
  globalNote?: string;
  unanswered: string[];
  refused?: { questionIndex: number; header: string }[];
  guarded?: { questionIndex: number; header: string; chose: string }[];
}

export interface Recommendation {
  questionIndex: number;
  selected: string[];
  text?: string;
  reason: string;
}

export interface AutopilotVerdict {
  recommendations: Recommendation[];
  summary: string;
}

/** A human's answer to one question, as the dialog (or a generic answerer) gives it. */
export interface DialogAnswer {
  selected: string[];
  text?: string;
  note?: string;
}

export type DialogOutcome =
  | { kind: "answered"; answers: Map<number, DialogAnswer>; globalNote?: string }
  | { kind: "cancelled" }
  | { kind: "autopilot"; waitedSeconds: number };

// --- config --------------------------------------------------------------------------------------------------------

export interface DecideConfig {
  enabled: boolean;
  autopilot: { mode: PolicyMode; timeoutSeconds: number; deadlineSeconds: number };
  ui: { bell: boolean };
  judge: {
    model: { provider: string; model: string } | null;
    tailMessages: number;
    maxTailChars: number;
    timeoutMs: number;
  };
  limits: { maxQuestions: number; maxOptions: number };
  notify: boolean;
  debug: boolean;
}

export const defaultConfig = (): DecideConfig => ({
  enabled: true,
  autopilot: { mode: "off", timeoutSeconds: 180, deadlineSeconds: 900 },
  ui: { bell: true },
  judge: { model: null, tailMessages: 10, maxTailChars: 8000, timeoutMs: 90_000 },
  limits: { maxQuestions: 8, maxOptions: 8 },
  notify: true,
  debug: false,
});

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const int = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;

export const parsePolicyMode = (v: unknown): PolicyMode | undefined =>
  v === "off" || v === "on" || v === "auto" ? v : undefined;

/** Merges an untrusted parsed value over `base`; every invalid field keeps its default. Never throws. */
export function mergeConfig(base: DecideConfig, raw: unknown): DecideConfig {
  if (!isObject(raw)) return base;
  const autopilot = isObject(raw.autopilot) ? raw.autopilot : {};
  const ui = isObject(raw.ui) ? raw.ui : {};
  const judge = isObject(raw.judge) ? raw.judge : {};
  const limits = isObject(raw.limits) ? raw.limits : {};
  const m = isObject(judge.model) ? judge.model : null;
  const model =
    m && typeof m.provider === "string" && m.provider && typeof m.model === "string" && m.model
      ? { provider: m.provider, model: m.model }
      : null;
  return {
    enabled: bool(raw.enabled, base.enabled),
    autopilot: {
      mode: parsePolicyMode(autopilot.mode) ?? base.autopilot.mode,
      timeoutSeconds: int(autopilot.timeoutSeconds, base.autopilot.timeoutSeconds, 0, 86_400),
      deadlineSeconds: int(autopilot.deadlineSeconds, base.autopilot.deadlineSeconds, 0, 86_400),
    },
    ui: { bell: bool(ui.bell, base.ui.bell) },
    judge: {
      model,
      tailMessages: int(judge.tailMessages, base.judge.tailMessages, 1, 60),
      maxTailChars: int(judge.maxTailChars, base.judge.maxTailChars, 500, 200_000),
      timeoutMs: int(judge.timeoutMs, base.judge.timeoutMs, 1_000, 600_000),
    },
    limits: {
      maxQuestions: int(limits.maxQuestions, base.limits.maxQuestions, 1, 32),
      maxOptions: int(limits.maxOptions, base.limits.maxOptions, 2, 32),
    },
    notify: bool(raw.notify, base.notify),
    debug: bool(raw.debug, base.debug),
  };
}

/** Reads `path`: missing = defaults; unreadable or malformed = defaults plus a warning. */
export function loadConfig(path: string): { config: DecideConfig; warning?: string } {
  const base = defaultConfig();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { config: base };
    return { config: base, warning: `could not read ${path}: ${(e as Error).message}` };
  }
  try {
    return { config: mergeConfig(base, JSON.parse(text)) };
  } catch (e) {
    return { config: base, warning: `malformed JSON in ${path} (using defaults): ${(e as Error).message}` };
  }
}

// --- policy --------------------------------------------------------------------------------------------------------

/** "tui": the rich dialog; "rpc": an interactive host answering the generic fields; "none": nobody to ask. */
export type HostKind = "tui" | "rpc" | "none";

export interface Resolved {
  mode: PolicyMode;
  /** seconds before the autopilot answers; 0 = wait forever */
  timeoutSeconds: number;
  ask: boolean;
  deadlineKind: "auto" | "deadline";
  why: string;
}

/**
 * Who answers: headless forces autopilot; the model's `mode: "ask"` can't override `on`, and its `mode: "auto"` can't
 * override `off`; everything that asks counts down (`auto` its delay, `off` the safety-net deadline).
 */
export function resolvePolicy(input: {
  config: DecideConfig;
  sessionMode?: PolicyMode;
  sessionDeadline?: number;
  perCallMode?: "ask" | "auto";
  host: HostKind;
}): Resolved {
  const configured = input.sessionMode ?? input.config.autopilot.mode;
  let mode: PolicyMode = configured;
  let why = `policy: ${configured}${input.sessionMode ? " (session override)" : " (config)"}`;
  if (input.host === "none") {
    mode = "on";
    why = "no interactive UI in this mode — autopilot answers so the run cannot block";
  } else if (input.perCallMode === "auto" && configured !== "off") {
    mode = "on";
    why = "per-call mode:auto — autopilot answers";
  } else if (input.perCallMode === "auto") {
    why = "per-call mode:auto ignored — the session policy is `off` (always ask)";
  } else if (input.perCallMode === "ask" && configured === "on") {
    why = "per-call mode:ask ignored — the session policy is `on` (never ask)";
  } else if (input.perCallMode === "ask") {
    mode = "off";
    why = "per-call mode:ask — the dialog always waits for the human";
  }
  const deadline = Math.max(0, input.sessionDeadline ?? input.config.autopilot.deadlineSeconds);
  const timeoutSeconds =
    mode === "on" ? 0 : mode === "auto" ? Math.max(0, input.config.autopilot.timeoutSeconds) : deadline;
  if (mode === "off" && timeoutSeconds === 0) why += " — deadline disabled, this dialog will wait indefinitely";
  return { mode, timeoutSeconds, ask: mode !== "on", deadlineKind: mode === "auto" ? "auto" : "deadline", why };
}

export function describePolicy(mode: PolicyMode, timeoutSeconds: number): string {
  const t = (s: number) => (s >= 120 && s % 60 === 0 ? `${s / 60}m` : `${s}s`);
  if (mode === "off") return timeoutSeconds > 0 ? `ask (autopilot after ${t(timeoutSeconds)})` : "ask (waits forever)";
  if (mode === "on") return "auto (never ask)";
  return timeoutSeconds > 0 ? `auto after ${t(timeoutSeconds)}` : "auto (no countdown → waits)";
}

/** The status bar badge, or undefined for the default (`off` with a deadline). */
export function statusBadge(mode: PolicyMode, seconds: number, override: boolean): string | undefined {
  const star = override ? "*" : "";
  if (mode === "on") return `🤖 auto${star}`;
  if (mode === "auto") return `🤖 auto:${seconds > 0 ? `${seconds}s` : "∞"}${star}`;
  return seconds === 0 ? `🤖 hold${star}` : undefined;
}

// --- safety rail ---------------------------------------------------------------------------------------------------

const IRREVERSIBLE = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bdelet(e|ing|ion)\b/i,
  /\bdrop(ping)?\b/i,
  /\btruncat(e|ing)\b/i,
  /\bforce[- ]?push/i,
  /\bpush\s+(--force|-f)\b/i,
  /\breset\s+--hard\b/i,
  /\boverwrit(e|ing)\b/i,
  /\bdestroy(s|ed|ing)?\b/i,
  /\bwipe\b/i,
  /\bpurge\b/i,
  /\brevoke\b/i,
  /\brotat(e|ing)\s+(the\s+)?(\w+\s+){0,2}(key|secret|credentials?|password|token)s?\b/i,
  /\bpublish\b/i,
  /\bdeploy\s+to\s+prod/i,
  /\breleas(e|ing)\s+to\s+prod/i,
  /\bspend(s|ing)?\b/i,
  /\bcharg(e|ing)\b/i,
  /\bbill(ing)?\b/i,
  /\bcost(s|ing)?\s+money/i,
  /\btransfer\s+funds/i,
  /\brm\s+i\b/i,
];

const CONSERVATIVE = [
  /\babort\b/i,
  /\bcancel\b/i,
  /\bskip\b/i,
  /\bkeep\b/i,
  /\bpreserve\b/i,
  /\bback\s?up\b/i,
  /\bno[- ]?op\b/i,
  /\bdo\s+nothing\b/i,
  /\bdo\s+not\b/i,
  /\bdon't\b/i,
  /\bwithout\b/i,
  /\bwait\b/i,
  /\bask\b/i,
  /\breview\s+first\b/i,
  /\bdry[- ]?run\b/i,
  /\bnot\s+(yet|now)\b/i,
];

const NEGATED_CONSERVATIVE =
  /\b(no|not|without|n't|never|lack\s+of)\b[^.!?]{0,24}?\b(back\s?up|keep|preserve|wait|review|dry[- ]?run|dump)\b/i;

export const looksIrreversible = (text: string) => IRREVERSIBLE.some((p) => p.test(text));

/** Cautious wording; "no backup" / "without a dump" is not ("do not delete" is). */
export function looksConservative(text: string): boolean {
  if (/\b(do\s+not|don't|without)\b[^.!?]{0,24}?\b(delete|drop|force|publish|overwrite|wipe|purge|remove)/i.test(text))
    return true;
  if (NEGATED_CONSERVATIVE.test(text)) return false;
  return CONSERVATIVE.some((p) => p.test(text));
}

/** Whether a question needs a human whatever the policy says: declared irreversible, or reads like it. */
export function needsHuman(q: Question): boolean {
  if (q.irreversible) return true;
  const parts = [q.question, q.header, q.category ?? ""];
  for (const o of q.options) parts.push(o.label, o.description);
  return looksIrreversible(parts.join("\n"));
}

/** The cautious label to use instead of `chosen`; undefined when `chosen` is fine; null when there is none (refuse). */
export function guardChoice(q: Question, chosen: readonly string[]): string | undefined | null {
  if (!needsHuman(q)) return undefined;
  const safe = q.options.filter((o) => looksConservative(`${o.label}\n${o.description}`)).map((o) => o.label);
  if (!safe.length) return null;
  return chosen.every((l) => safe.includes(l)) ? undefined : safe[0];
}

// --- validation ----------------------------------------------------------------------------------------------------

export const RESERVED_LABELS = ["other", "type something", "type something."];
const normalize = (s: string) => s.trim().replace(/[\s ]+/g, " ");

/** Normalizes the model's questionnaire, or explains what's wrong with it (limits from the config). */
export function validateQuestionnaire(
  raw: Questionnaire,
  limits: DecideConfig["limits"],
): { ok: true; questionnaire: Questionnaire; warnings: string[] } | { ok: false; message: string } {
  const fail = (message: string) => ({ ok: false as const, message: `Error: ${message}` });
  const questions = raw.questions ?? [];
  if (!questions.length) return fail("At least one question is required.");
  if (questions.length > limits.maxQuestions)
    return fail(
      `At most ${limits.maxQuestions} questions are allowed per invocation (got ${questions.length}). Split them across calls.`,
    );
  const warnings: string[] = [];
  const out: Question[] = [];
  for (const [i, q] of questions.entries()) {
    const at = `question ${i + 1}`;
    const header = normalize(q.header);
    if (!header) return fail(`${at}: header must not be empty.`);
    if (q.options.length < 2) return fail(`${at}: needs at least 2 options (got ${q.options.length}).`);
    if (q.options.length > limits.maxOptions)
      return fail(`${at}: at most ${limits.maxOptions} options are allowed (got ${q.options.length}).`);
    const seen = new Set<string>();
    const options: Option[] = [];
    for (const o of q.options) {
      const label = normalize(o.label);
      if (!label) return fail(`${at}: every option needs a non-empty label.`);
      const folded = label.toLowerCase();
      if (RESERVED_LABELS.includes(folded))
        return fail(`${at}: "${label}" is reserved — the "Type something." row is appended automatically.`);
      if (seen.has(folded)) return fail(`${at}: duplicate option label "${label}".`);
      seen.add(folded);
      const description = o.description.trim();
      if (!description) return fail(`${at}: option "${label}" needs a description.`);
      options.push({ label, description, ...(o.preview && { preview: o.preview }) });
    }
    let recommended = q.recommended === undefined ? undefined : normalize(q.recommended);
    if (recommended !== undefined) {
      const match = options.find((o) => o.label.toLowerCase() === recommended?.toLowerCase());
      if (!match) warnings.push(`${at}: recommended "${recommended}" matches no option — ignored`);
      recommended = match?.label;
    }
    out.push({
      question: q.question.trim(),
      header,
      ...(q.category?.trim() && { category: q.category.trim() }),
      options,
      ...(q.multiSelect && { multiSelect: true }),
      ...(recommended !== undefined && { recommended }),
      ...(recommended !== undefined &&
        q.recommendedBecause !== undefined && {
          recommendedBecause: q.recommendedBecause.trim(),
        }),
      ...(q.irreversible && { irreversible: true }),
    });
  }
  return {
    ok: true,
    warnings,
    questionnaire: {
      questions: out,
      ...(raw.context?.trim() && { context: raw.context.trim() }),
      ...(raw.mode && { mode: raw.mode }),
    },
  };
}

// --- transcript ----------------------------------------------------------------------------------------------------

export const compact = (text: string, max: number) => {
  const t = text.replace(/\s+$/g, "");
  return t.length <= max ? t : `${t.slice(0, max)}…(${t.length - max} chars omitted)`;
};

function formatMessage(m: Message): string {
  if (m.role === "user") return m.content ? `[user] ${compact(m.content, 1500)}` : "";
  if (m.role === "assistant") {
    const parts = [
      m.text,
      ...m.toolCalls.map((c) => `[tool call ${c.name}(${compact(JSON.stringify(c.input ?? {}), 200)})]`),
    ];
    const text = parts.filter(Boolean).join("\n");
    return text ? `[assistant] ${compact(text, 1500)}` : "";
  }
  return m.results
    .map((r) => compact(r.output, 300))
    .filter(Boolean)
    .map((t) => `[tool result] ${t}`)
    .join("\n\n");
}

/** The judge's excerpt: the last `tailMessages` messages, newest kept first, capped at `maxTailChars`. */
export function buildTranscript(messages: readonly Message[], opts: { tailMessages: number; maxTailChars: number }) {
  const newestFirst: string[] = [];
  for (let i = messages.length - 1; i >= 0 && newestFirst.length < opts.tailMessages; i--) {
    const m = messages[i];
    const text = m ? formatMessage(m) : "";
    if (text) newestFirst.push(text);
  }
  return compact(newestFirst.reverse().join("\n\n"), opts.maxTailChars);
}

// --- the judge -----------------------------------------------------------------------------------------------------

export const JUDGE_PROMPT = `You are the autopilot for "hortus", a terminal coding agent that is running unattended.

The agent stopped to ask the human a set of structured questions. Nobody is
available — the user is asleep, away, or simply not watching. Your job is to
answer exactly as a competent, conservative senior engineer who owns this
codebase would: pick the option that most helps the stated task succeed, then
say why in one short line.

Judge by meaning. The conversation and the questions may be in any language.

Hard rules:
1. Answer EVERY question, in the order given. Never leave one out.
2. Prefer an authored option. Its label must be copied VERBATIM (character for
   character) into "selected".
3. When the question says the model recommended an option, that recommendation
   is your default. Override it only when the conversation clearly shows the
   recommendation is wrong, and say so in "reason".
4. If no authored option is defensible, put your answer in "text" and leave
   "selected" empty. Say why.
5. For multi-select questions, return every option that genuinely applies, in
   the authored order. Do not pad the list.
6. Prefer the choice that is reversible, cheap, and does not destroy data,
   spend money, publish anything, or delete work without a backup. When two
   options are otherwise equal, prefer the smaller blast radius.
7. Never invent options. Never answer with a question. Never ask for
   clarification — there is nobody to clarify with.

Reply with ONE JSON object and nothing else: no markdown fence, no prose.

{"summary":"one line on the shape of this decision",
 "recommendations":[
   {"question":1,"selected":["verbatim option label"],"text":"","reason":"under 25 words"}
 ]}

Use the question's 1-based number in "question".`;

export function renderQuestionnaire(q: Questionnaire): string {
  const lines: string[] = [];
  if (q.context) lines.push(`What the agent is trying to decide: ${q.context}`, "");
  q.questions.forEach((question, i) => {
    lines.push(
      `Q${i + 1} [${question.header}]${question.multiSelect ? " (multi-select: list every option that applies)" : ""}`,
    );
    lines.push(question.question);
    question.options.forEach((o, n) => {
      const rec = question.recommended === o.label ? "  <-- model recommends this" : "";
      lines.push(`  ${n + 1}. ${o.label} — ${o.description}${rec}`);
    });
    if (question.recommendedBecause) lines.push(`  why the model recommends it: ${question.recommendedBecause}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

export const judgeMessage = (transcript: string, q: Questionnaire) =>
  [
    "## Recent conversation",
    transcript.trim() || "(no conversation captured)",
    "",
    "## The questions that stopped the run",
    renderQuestionnaire(q),
  ].join("\n");

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s ]+/g, " ")
    .replace(/[.,;:!?。、；：！？"'`’“”()（）[\]]/g, "")
    .trim();

/** An authored label for `raw`: exact (folded), else the longest prefix match either way; no substring tier. */
export function matchOption(q: Question, raw: string): string | undefined {
  const wanted = fold(raw);
  if (!wanted) return undefined;
  const exact = q.options.find((o) => fold(o.label) === wanted);
  if (exact) return exact.label;
  let best: { label: string; length: number } | undefined;
  for (const o of q.options) {
    const label = fold(o.label);
    if (!(label.startsWith(wanted) || wanted.startsWith(label))) continue;
    if (!best || label.length > best.length) best = { label: o.label, length: label.length };
  }
  return best?.label;
}

const hasRecommendation = (q: Question) =>
  q.recommended !== undefined && q.options.some((o) => o.label === q.recommended);

/** The model's own recommendation, else the first option: every question always gets an answer. */
export function fallbackRecommendation(q: Question, index: number, reason: string): Recommendation {
  if (q.recommended !== undefined)
    return {
      questionIndex: index,
      selected: [q.recommended],
      reason: q.recommendedBecause !== undefined ? `${q.recommendedBecause} (${reason})` : reason,
    };
  return { questionIndex: index, selected: q.options[0] ? [q.options[0].label] : [], reason };
}

/** Stated recommendations win outright; `judged` (indexed against `needed`) fills the rest, else the fallback. */
export function composeVerdict(
  q: Questionnaire,
  judged: AutopilotVerdict | undefined,
  needed: number[],
): AutopilotVerdict {
  const recommendations = q.questions.map((question, index) => {
    if (hasRecommendation(question)) return fallbackRecommendation(question, index, "stated with the question");
    const at = needed.indexOf(index);
    const r = at === -1 ? undefined : judged?.recommendations.find((x) => x.questionIndex === at);
    return r
      ? { ...r, questionIndex: index }
      : fallbackRecommendation(question, index, "no recommendation and no judge verdict");
  });
  const judgedCount = q.questions.filter((x) => !hasRecommendation(x)).length;
  return {
    recommendations,
    summary:
      judged?.summary ??
      (judgedCount === 0
        ? "answered from the recommendations stated with the questions"
        : "answered without a stated recommendation"),
  };
}

function pickNumber(raw: Record<string, unknown>): number | undefined {
  const v = raw.question ?? raw.index ?? raw.q;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number.parseInt(v.replace(/[^0-9-]/g, ""), 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** The judge's reply as a verdict over `q`, degrading per question; null when there's no usable JSON at all. */
export function parseVerdict(raw: string, q: Questionnaire): AutopilotVerdict | { error: string } {
  const json = raw.trim().match(/\{[\s\S]*\}/);
  if (!raw.trim()) return { error: "empty" };
  if (!json) return { error: "unparsable" };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json[0]);
  } catch {
    return { error: "unparsable" };
  }
  const list = (Array.isArray(parsed.recommendations) ? parsed.recommendations : []).filter(isObject);
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const e of list) {
    const n = pickNumber(e);
    if (n !== undefined) byIndex.set(n - 1, e);
  }
  const unnumbered = list.filter((e) => pickNumber(e) === undefined);
  const recommendations = q.questions.map((question, index): Recommendation => {
    const e =
      byIndex.get(index) ??
      unnumbered.find((x) => typeof x.header === "string" && fold(x.header) === fold(question.header)) ??
      unnumbered[index];
    if (!e) return fallbackRecommendation(question, index, "the judge skipped this question");
    const rawSelected = Array.isArray(e.selected)
      ? e.selected.filter((l): l is string => typeof l === "string")
      : typeof e.selected === "string"
        ? [e.selected]
        : [];
    const matched = new Set(rawSelected.map((l) => matchOption(question, l)).filter((l) => l !== undefined));
    const ordered = question.options.map((o) => o.label).filter((l) => matched.has(l));
    const text = typeof e.text === "string" && e.text.trim() ? e.text.trim() : undefined;
    const reason = typeof e.reason === "string" && e.reason.trim() ? e.reason.trim() : "(no reason given)";
    if (!ordered.length && text === undefined)
      return fallbackRecommendation(question, index, `unmatched answer "${compact(rawSelected.join(", "), 80)}"`);
    return {
      questionIndex: index,
      selected: question.multiSelect ? ordered : ordered.slice(0, 1),
      ...(text !== undefined && { text }),
      reason,
    };
  });
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : "autopilot answered on the user's behalf";
  return { recommendations, summary };
}

export interface AutopilotResult {
  verdict: AutopilotVerdict;
  judged: boolean;
  from: "recommendation" | "judge" | "fallback";
  fallbackReason?: string;
  refused: { questionIndex: number; header: string }[];
  guarded: { questionIndex: number; header: string; chose: string }[];
}

/** Steers irreversible questions onto their cautious option, or refuses them when there is none. */
function applySafetyRail(q: Questionnaire, base: Omit<AutopilotResult, "refused" | "guarded">): AutopilotResult {
  const refused: AutopilotResult["refused"] = [];
  const guarded: AutopilotResult["guarded"] = [];
  const recommendations = base.verdict.recommendations.map((r) => {
    const question = q.questions[r.questionIndex];
    if (!question) return r;
    const override = guardChoice(question, r.selected);
    if (override === undefined) return r;
    if (override === null) {
      refused.push({ questionIndex: r.questionIndex, header: question.header });
      return r;
    }
    guarded.push({ questionIndex: r.questionIndex, header: question.header, chose: override });
    return {
      ...r,
      selected: [override],
      reason: `${r.reason} — steered to the cautious option (this decision cannot be undone)`,
    };
  });
  return { ...base, verdict: { ...base.verdict, recommendations }, refused, guarded };
}

/**
 * Decides every question without a human; never rejects. Only questions without a stated recommendation reach the
 * judge (`complete`: system + user text in, reply text out; it may throw); any failure falls back per question.
 */
export async function runAutopilot(
  q: Questionnaire,
  deps: { complete?: (system: string, user: string) => Promise<string>; transcript: string; log?: (m: string) => void },
): Promise<AutopilotResult> {
  const needed = q.questions.flatMap((x, i) => (hasRecommendation(x) ? [] : [i]));
  const fallback = (reason: string) =>
    applySafetyRail(q, {
      verdict: composeVerdict(q, undefined, needed),
      judged: false,
      from: "fallback",
      fallbackReason: reason,
    });
  if (!needed.length)
    return applySafetyRail(q, { verdict: composeVerdict(q, undefined, needed), judged: true, from: "recommendation" });
  if (!deps.complete) return fallback("no model available");
  const subset: Questionnaire = {
    ...(q.context !== undefined && { context: q.context }),
    questions: needed.flatMap((i) => q.questions[i] ?? []),
  };
  let raw: string;
  try {
    raw = await deps.complete(JUDGE_PROMPT, judgeMessage(deps.transcript, subset));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    deps.log?.(`[decide] autopilot judge call failed: ${message}`);
    return fallback(message);
  }
  const parsed = parseVerdict(raw, subset);
  if ("error" in parsed) {
    deps.log?.(`[decide] autopilot judge output ${parsed.error}: ${raw.slice(0, 400)}`);
    return fallback(parsed.error);
  }
  return applySafetyRail(q, { verdict: composeVerdict(q, parsed, needed), judged: true, from: "judge" });
}

export function synthesizeAnswers(
  v: AutopilotVerdict,
  q: Questionnaire,
  source: AnswerSource,
  waited?: number,
): Answer[] {
  return q.questions.map((question, index) => {
    const r =
      v.recommendations.find((x) => x.questionIndex === index) ??
      fallbackRecommendation(question, index, "no recommendation");
    return {
      index,
      header: question.header,
      question: question.question,
      selected: r.selected,
      ...(r.text !== undefined && { text: r.text }),
      source,
      ...(waited !== undefined && { waitedSeconds: waited }),
    };
  });
}

// --- the envelope --------------------------------------------------------------------------------------------------

function answerLine(a: Answer): string {
  const parts: string[] = [];
  if (a.selected.length) parts.push(a.selected.map((l) => `"${l}"`).join(", "));
  if (a.text) {
    const quoted = a.text.replace(/\n/g, "\n      ");
    parts.push(a.selected.length ? `plus: ${quoted}` : quoted);
  }
  if (!parts.length) parts.push("(no answer)");
  const tags: string[] = [];
  if (a.source !== "user") tags.push(a.source);
  if (a.source === "timeout" && a.waitedSeconds !== undefined) tags.push(`after ${a.waitedSeconds}s`);
  const note = a.note ? `\n      user note: ${a.note}` : "";
  return `- ${a.header}: ${parts.join(" ")}${tags.length ? ` [${tags.join(", ")}]` : ""}${note}`;
}

/** What the model reads back: an unattended answer can't be mistaken for consent. */
export function formatResult(r: DecisionResult): string {
  const lines: string[] = [];
  switch (r.outcome) {
    case "autopilot":
      lines.push(
        `These answers were chosen by the autopilot, not by the user: ${r.reason ?? "nobody was available"}.`,
        "The user did not see these questions and did not confirm these choices. Proceed on your own judgement; if the choice turns out to be unrecoverable, say so plainly in your final report instead of silently assuming it was approved.",
      );
      break;
    case "timeout":
      lines.push(
        `Nobody answered the dialog (${r.reason ?? "the countdown expired"}), so the autopilot answered.`,
        "The user did not see these questions and did not confirm these choices. Continue, but say in your final report which decisions were assumed rather than approved.",
      );
      break;
    case "cancelled":
      lines.push(
        "The user cancelled the questionnaire. These questions were NOT answered — do not treat the cancellation as agreement, and do not re-ask the same questions immediately. Either proceed with a reasonable default (say which) or stop and explain what you need.",
      );
      break;
    case "refused":
      lines.push(
        `The autopilot REFUSED to answer: ${r.reason ?? "an irreversible decision needs a human"}.`,
        "These questions involve something that cannot be undone and offer no cautious option, so nobody was willing to decide on the user's behalf. Do NOT pick one yourself and do NOT proceed as if it were answered. Stop this line of work, finish whatever is safe to finish, and report clearly that this decision is blocked on the user.",
      );
      break;
    case "rejected":
      lines.push(
        `The questionnaire was rejected before it was shown: ${r.reason ?? "no reason given"}. Nothing was asked, so do not treat this as an answer.`,
      );
      break;
  }
  const refused = new Set(r.refused?.map((x) => x.header));
  const answered = r.answers.filter((a) => a.source !== "abandoned" && !refused.has(a.header));
  if (lines.length) lines.push("");
  if (answered.length) lines.push("Answers:", ...answered.map(answerLine));
  if (r.unanswered.length) lines.push("", `Unanswered: ${r.unanswered.join(", ")}`);
  if (r.guarded?.length)
    lines.push(
      "",
      `Safety rail: ${r.guarded.map((g) => `${g.header} was steered to the cautious option "${g.chose}"`).join("; ")} (these decisions cannot be undone).`,
    );
  if (r.globalNote) lines.push("", `Global note: ${r.globalNote}`);
  return lines.length ? lines.join("\n") : "No answers were produced by the questionnaire.";
}

/** The decision from a human's answers: unanswered questions listed by header. */
export function fromDialog(q: Questionnaire, outcome: Extract<DialogOutcome, { kind: "answered" }>): DecisionResult {
  const answers: Answer[] = [];
  q.questions.forEach((question, index) => {
    const a = outcome.answers.get(index);
    if (!a || (!a.selected.length && !a.text)) return;
    answers.push({
      index,
      header: question.header,
      question: question.question,
      selected: a.selected,
      ...(a.text !== undefined && { text: a.text }),
      source: "user",
      ...(a.note !== undefined && { note: a.note }),
    });
  });
  const done = new Set(answers.map((a) => a.index));
  return {
    answers,
    outcome: "answered",
    unanswered: q.questions.filter((_, i) => !done.has(i)).map((x) => x.header),
    ...(outcome.globalNote !== undefined && { globalNote: outcome.globalNote }),
  };
}

/** A generic answer (a label, typed text, or labels) to question `q`: labels matched, anything else is text. */
export function fromGeneric(q: Question, answer: string | string[]): DialogAnswer {
  const given = Array.isArray(answer) ? answer : [answer];
  const selected = q.options.map((o) => o.label).filter((l) => given.includes(l));
  const text = given.filter((g) => !selected.includes(g)).join("\n");
  return { selected: q.multiSelect ? selected : selected.slice(0, 1), ...(text && { text }) };
}
