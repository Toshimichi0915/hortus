/**
 * Session events: what context-mode remembers about a session (files touched, errors, git, decisions, intent, goal),
 * extracted from tool results and user prompts, and rendered back as `<active_memory>` each run and as a
 * `<session_resume>` snapshot after a compaction. Pure functions, ported from context-mode's `session/extract` and
 * `session/snapshot` (the Pi-relevant extractors).
 */

export interface SessionEvent {
  type: string;
  category: string;
  data: string;
  /** 1 (low) to 4 (critical): eviction drops the lowest first; `<active_memory>` shows 3 and up */
  priority: number;
}

/** What context-mode keeps per session, at most (lowest priority, then oldest, evicted first). */
export const MAX_EVENTS = 1000;
/** An event equal (type and data) to one of the last few isn't recorded again. */
const DEDUP_WINDOW = 5;

/** `events` plus `ev`, deduplicated and capped like context-mode's SessionDB. */
export function addEvent(events: readonly SessionEvent[], ev: SessionEvent): SessionEvent[] {
  if (events.slice(-DEDUP_WINDOW).some((e) => e.type === ev.type && e.data === ev.data)) return [...events];
  const next = [...events, ev];
  if (next.length > MAX_EVENTS) {
    const low = Math.min(...next.map((e) => e.priority));
    next.splice(
      next.findIndex((e) => e.priority === low),
      1,
    );
  }
  return next;
}

const RULE_FILE =
  /(?:CLAUDE|AGENTS(?:\.override)?|GEMINI|QWEN|KIRO)\.md$|\/copilot-instructions\.md$|\.claude[\\/]|[\\/]memor(?:y|ies)[\\/][^\\/]+\.md$/i;
const GIT_OPS: [RegExp, string][] = [
  [/\bgit\s+checkout\b/, "branch"],
  [/\bgit\s+commit\b/, "commit"],
  [/\bgit\s+merge\s+\S+/, "merge"],
  [/\bgit\s+rebase\b/, "rebase"],
  [/\bgit\s+stash\b/, "stash"],
  [/\bgit\s+push\b/, "push"],
  [/\bgit\s+pull\b/, "pull"],
  [/\bgit\s+log\b/, "log"],
  [/\bgit\s+diff\b/, "diff"],
  [/\bgit\s+status\b/, "status"],
  [/\bgit\s+branch\b/, "branch"],
  [/\bgit\s+reset\b/, "reset"],
  [/\bgit\s+add\b/, "add"],
  [/\bgit\s+cherry-pick\b/, "cherry-pick"],
  [/\bgit\s+tag\b/, "tag"],
  [/\bgit\s+fetch\b/, "fetch"],
  [/\bgit\s+clone\b/, "clone"],
  [/\bgit\s+worktree\b/, "worktree"],
];

/** A tool call as `tool_result` reports it. */
export interface ToolOutcome {
  name: string;
  input: Record<string, unknown>;
  output: string;
  isError?: boolean;
}

/** The events one tool call yields; a call nothing recognizes is recorded as a generic `tool_call` event. */
export function extractEvents({ name, input, output, isError }: ToolOutcome): SessionEvent[] {
  const events: SessionEvent[] = [];
  const path = String(input.path ?? "");
  const command = String(input.command ?? "");
  if (name === "read") {
    if (RULE_FILE.test(path)) {
      events.push({ type: "rule", category: "rule", data: path, priority: 1 });
      // the rule's text, so it survives a compaction
      if (output) events.push({ type: "rule_content", category: "rule", data: output, priority: 1 });
    }
    events.push({ type: "file_read", category: "file", data: path, priority: 1 });
  } else if (name === "edit") events.push({ type: "file_edit", category: "file", data: path, priority: 1 });
  else if (name === "write") events.push({ type: "file_write", category: "file", data: path, priority: 1 });
  if (name === "bash") {
    const cd = command.match(/\bcd\s+("([^"]+)"|'([^']+)'|(\S+))/);
    if (cd) events.push({ type: "cwd", category: "cwd", data: cd[2] ?? cd[3] ?? cd[4] ?? "", priority: 2 });
    const op = GIT_OPS.find(([re]) => re.test(command))?.[1];
    if (op) {
      // ponytail: regex for the commit message, not context-mode's argv tokenizer (misses `-am`, `--message=`)
      const msg = op === "commit" ? command.match(/\s-m\s+(?:"([^"]*)"|'([^']*)'|(\S+))/) : null;
      const subject = msg?.[1] ?? msg?.[2] ?? msg?.[3];
      events.push(
        subject
          ? { type: "git_commit", category: "git", data: subject, priority: 2 }
          : { type: "git", category: "git", data: op, priority: 2 },
      );
    }
  }
  const bashError = name === "bash" && /exit code [1-9]|error:|Error:|FAIL|failed/i.test(output);
  if (isError || bashError) events.push({ type: "error_tool", category: "error", data: output, priority: 2 });
  if (events.length === 0)
    events.push({
      type: "tool_call",
      category: "tool",
      data: JSON.stringify({ tool: name, params: input }),
      priority: 1,
    });
  return events;
}

const QUESTION = /[?？؟¿]/u;
const ALPHABETIC = /\p{L}/u;
const CLAUSE_SEPARATOR = /[,;，；、،]/u;
const GOAL = /^(?:\/goal\s+|(?:goal|objective)\s*:\s*)(.+)$/is;
const BLOCKER = /(?:\bError\s*:|\bException\s*:|\bTraceback\b|\bat\s+\S+\s*\([^)]*:\d+:\d+\))/u;
const RESOLVED = /[✓✔✅☑🎉]|^\s*(?:fixed|resolved)\s*:/iu;

/** The events a user prompt yields (role detection is left out: context-mode never re-injects roles). */
export function extractUserEvents(message: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  const text = message.trim();
  if (!text) return events;
  const plan = text.match(/^\/plan(?:\s+([\s\S]*))?$/);
  if (plan)
    events.push({
      type: "plan_enter",
      category: "plan",
      data: plan[1] ? `plan via /plan slash: ${plan[1].trim().slice(0, 120)}` : "plan via /plan slash",
      priority: 2,
    });
  const len = [...text].length;
  const question = QUESTION.test(text);
  if (!question && ALPHABETIC.test(text) && CLAUSE_SEPARATOR.test(text) && len >= 15 && len <= 500)
    events.push({ type: "decision", category: "decision", data: message, priority: 2 });
  const mode = question ? "investigate" : ALPHABETIC.test(text) && len < 60 ? "implement" : undefined;
  if (mode) events.push({ type: "intent", category: "intent", data: mode, priority: 4 });
  const goal = text.match(GOAL)?.[1]?.trim();
  if (goal) events.push({ type: "goal", category: "goal", data: goal, priority: 4 });
  if (RESOLVED.test(message))
    events.push({ type: "blocker_resolved", category: "blocked-on", data: message, priority: 2 });
  else if (BLOCKER.test(message)) events.push({ type: "blocker", category: "blocked-on", data: message, priority: 2 });
  if (message.length > 1024) events.push({ type: "data", category: "data", data: message, priority: 4 });
  return events;
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** The `<active_memory>` block injected each run: events of priority 3+, the first 50, within ~500 tokens. */
export function activeMemory(events: readonly SessionEvent[]): string {
  const lines = ["<active_memory>"];
  let budget = 2000;
  for (const ev of events.filter((e) => e.priority >= 3 && e.category !== "role").slice(0, 50)) {
    const line = `  <event type="${ev.type}" category="${ev.category}">${ev.data}</event>`;
    if (line.length > budget) break;
    lines.push(line);
    budget -= line.length;
  }
  lines.push("</active_memory>");
  return lines.length > 2 ? lines.join("\n") : "";
}

/** A section's "for full details" call: up to 4 of `items`, each cut at 80 chars, searched in `session-events`. */
function searchCall(items: string[]): string {
  const queries = [...new Set(items.filter(Boolean))].slice(0, 4).map((s) => `"${xml(s.slice(0, 80))}"`);
  if (queries.length === 0) return "";
  return `\n    For full details:\n    ctx_search(\n      queries: [${queries.join(", ")}],\n      source: "session-events"\n    )`;
}

function section(tag: string, lines: string[], queries: string[], count = lines.length): string {
  return [`  <${tag} count="${count}">`, ...lines.map((l) => `    ${xml(l)}`), searchCall(queries), `  </${tag}>`].join(
    "\n",
  );
}

/**
 * The `<session_resume>` snapshot built before a compaction and injected after it: a table of contents of the session
 * (goal, files, errors, decisions, rules, git, environment, intent), each section with the `ctx_search` call that
 * retrieves its details.
 */
export function buildResumeSnapshot(events: readonly SessionEvent[], compactCount: number): string {
  const by = (category: string) => events.filter((e) => e.category === category);
  const sections = [
    `  <how_to_search>
  Each section below contains a summary of prior work.
  For FULL DETAILS, run the exact tool call shown under each section.
  Do NOT ask the user to re-explain prior work. Search first.
  Do NOT invent your own queries — use the ones provided.
  </how_to_search>`,
  ];
  const goal = by("goal").at(-1);
  if (goal)
    sections.push(
      `  <session_goal>\n  The active objective for this session. Keep working toward it until it is met; do not ask the user to restate it.\n    ${xml(goal.data)}\n  </session_goal>`,
    );
  const files = new Map<string, Map<string, number>>();
  for (const ev of by("file")) {
    const op = { file_write: "write", file_read: "read", file_edit: "edit" }[ev.type] ?? ev.type;
    const ops = files.get(ev.data) ?? new Map<string, number>();
    ops.set(op, (ops.get(op) ?? 0) + 1);
    files.set(ev.data, ops);
  }
  if (files.size > 0) {
    const recent = [...files].slice(-10).map(([path, ops]) => ({ name: path.split("/").pop() ?? path, ops }));
    sections.push(
      section(
        "files",
        recent.map((f) => `${f.name} (${[...f.ops].map(([k, v]) => `${k}×${v}`).join(", ")})`),
        recent.map((f) => `${f.name} ${[...f.ops.keys()].join(" ")}`),
        files.size,
      ),
    );
  }
  const errors = by("error").map((e) => e.data);
  if (errors.length > 0) sections.push(section("errors", errors, errors));
  const decisions = [...new Set(by("decision").map((e) => e.data))];
  if (decisions.length > 0) sections.push(section("decisions", decisions, decisions));
  const rules = [
    ...new Set(
      by("rule")
        .filter((e) => e.type === "rule")
        .map((e) => e.data),
    ),
  ];
  if (rules.length > 0) sections.push(section("rules", rules, rules));
  const git = by("git").map((e) => e.data);
  if (git.length > 0) sections.push(section("git", git, git));
  const env = [...by("cwd").map((e) => `cwd: ${e.data}`), ...by("env").map((e) => e.data)];
  if (env.length > 0) sections.push(section("environment", env, env));
  const intent = by("intent").at(-1);
  if (intent) sections.push(`  <intent mode="${xml(intent.data)}"/>`);
  return `<session_resume events="${events.length}" compact_count="${compactCount}" generated_at="${new Date().toISOString()}">\n\n${sections.join("\n\n")}\n\n</session_resume>`;
}
