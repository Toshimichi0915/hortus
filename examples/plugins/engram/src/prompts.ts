/** The memory protocol pushed into every system prompt (gentle-engram's, with "Pi" read as "hortus"). */
export const MEMORY_INSTRUCTIONS = `## Engram Persistent Memory — Protocol

You have access to Engram, a persistent memory system that survives across sessions and compactions.
The agent MUST follow this protocol without waiting for activation.
These instructions are injected by gentle-engram, the hortus-native memory provider. Use the memory tools named in this section as the authoritative hortus memory contract. Do not infer alternative Engram tool names from other integrations unless the user explicitly asks you to use them.

### CANONICAL TOPIC WORKFLOW (mandatory — not optional)

A memory is an evolving topic, not a log entry. Follow this workflow for every learning worth persisting.

1. **SEARCH first.** Use \`mem_search\` on the bounded subject in the intended project and scope before writing.
2. **READ in full.** Use \`mem_get_observation\` on plausible candidates; search snippets are not enough to decide identity.
3. **SAME bounded topic?** Use \`mem_update\` by ID. Keep the existing \`topic_key\`, preserve every still-valid fact, and rewrite only what changed. Record superseded facts as history inside the content instead of leaving competing current truths.
4. **Genuinely new topic?** Use \`mem_save\` with a deliberate, distinct \`topic_key\`. If the learning is already covered, write nothing.
5. **Ambiguous identity or failed lookup?** Do not blindly overwrite and do not fall back to a duplicate save. A failed read is not evidence of absence.
6. **Never merge across projects or scopes.** A matching suggested \`topic_key\` or a similar title is a hint, not proof of identity.

Persist verified knowledge that is durable and costly to reconstruct: decisions with rationale,
non-obvious root causes, real constraints, and resumption-relevant pending work.
Group related conclusions deliberately, not every task, response, or event.
Exclude secrets, private data, speculation, raw dumps, and routine progress.
Never save credentials, private content, or personal data.

Format for \`mem_save\`:
- **title**: Verb + what — short, searchable
- **type**: bugfix | decision | architecture | discovery | pattern | config | preference
- **scope**: \`project\` (default) | \`personal\` | \`global\`
- **topic_key**: stable, deliberate key for the topic; reuse via \`mem_update\` rather than duplicating
- **content**:
  **What**: One sentence — what was done
  **Why**: What motivated it
  **Where**: Files or paths affected
  **Learned**: Gotchas, edge cases, things that surprised you

Format for \`mem_update\`:
- **id**: observation ID from \`mem_search\` / \`mem_get_observation\`
- **expected_project**: project that owns the observation
- **topic_key**: keep the existing key unless the topic itself changed
- **content**: full rewritten content including every still-valid fact, with changed or superseded facts recorded as history

### NATIVE SESSION ATTRIBUTION

Native \`mem_save\`, \`mem_save_prompt\`, \`mem_session_summary\`, and \`mem_capture_passive\`
derive attribution from the current hortus host session and confirmed Engram registration.
Do not invent or override \`session_id\`; gentle-engram owns the effective persisted
identity, including resumed continuations and explicit cross-project targets.
\`mem_session_end\` accepts only the current hortus host session ID; the extension
resolves the effective persisted ID. Ordinary task completion does not end it.

### PASSIVE CAPTURE

hortus automatically scans eligible non-Engram tool outputs after redaction; only
recognized structured learnings are persisted, not arbitrary output.
Final assistant responses are not automatically captured. For significant learnings
in a response, follow the canonical topic workflow before replying;
a final \`## Key Learnings:\` section alone is not a persistence guarantee.

### DELIVERY GUARANTEE

Honestly report unavailable memory evidence; never claim unconfirmed persistence.
Do not blindly repeat writes. Complete unrelated work even if bookkeeping fails.
Do not add per-event learning sections or ceremonial delivery blocks.

Memory operations are internal bookkeeping, never the user-facing answer. Complete required memory work before composing the completed-task reply; send the complete answer as the final message of the turn with no later tool calls. If memory work fails or needs follow-up, still send the answer.

### WHEN TO SEARCH MEMORY

Search when materially useful for recall or related work; mere project mentions do not require a search.
When the user asks to recall past work:
1. Start with \`mem_context\`, then search with 1–2 distinctive keywords.
2. Ordinary \`mem_search\` is scoped to the detected active project; its default
   \`match_mode:"all"\` means AND. For broad recall, use \`match_mode:"any"\` with
   \`all_projects:true\`. If a scoped search is empty, retry once this way before
   concluding no memory exists.
3. After hits, narrow follow-up searches by project, type, or \`match_mode:"all"\`,
   then use \`mem_get_observation\` for full content.

### SESSION CLOSE PROTOCOL

At significant explicit closure or handoff, call \`mem_session_summary\`
with Goal, Instructions, Discoveries, Accomplished, Next Steps, and Relevant Files.
Ordinary task completion or merely saying "done" does not require a session summary.
If \`mem_session_summary\` fails because Engram cannot detect a project, ask the user
which project should receive the summary, then retry with \`project: "<name>"\`.

### AFTER COMPACTION

When outcome-specific compaction recovery guidance is present, follow it. If a
compacted summary appears without that guidance, save it immediately with
\`mem_session_summary\`, then call \`mem_context\` before continuing.
`;

// ─── Compaction recovery (gentle-engram's compaction-recovery.js) ───

export type ArchiveOutcome = "confirmed" | "failed" | "unknown" | "unavailable";

const recoveryInstruction = (project: string) =>
  `CRITICAL INSTRUCTION FOR COMPACTED SUMMARY:\n` +
  `The agent has access to Engram persistent memory via MCP tools when gentle-engram and the Engram MCP tools are installed and active.\n` +
  `FIRST ACTION REQUIRED: Call mem_session_summary with the content of this compacted summary. ` +
  `Use project: '${project}'. This preserves what was accomplished before compaction. Do this BEFORE any other work.\n` +
  `If mem_session_summary is unavailable, manually save this compacted summary once Engram tools are available.`;

const INSTRUCTIONS: Record<Exclude<ArchiveOutcome, "failed">, (project: string) => string> = {
  confirmed: (project) =>
    `Compaction recovery summary was already saved to Engram (${project}) by gentle-engram. ` +
    `No manual mem_session_summary call is needed for this compaction. ` +
    `Call mem_context if you need additional recent project memory.`,
  unknown: (project) =>
    `Compaction recovery could not confirm whether the summary was saved to Engram (${project}). ` +
    `Do NOT retry or call mem_session_summary yet, because that could duplicate the summary. ` +
    `First verify with mem_search or mem_doctor; save the summary once only if it is absent.`,
  unavailable: () =>
    "CRITICAL INSTRUCTION FOR COMPACTED SUMMARY:\n" +
    "gentle-engram could not safely confirm the runtime session and project, so it did not archive the summary. " +
    "Before saving manually, verify the active Engram session and project with mem_current_project or mem_doctor. " +
    "Save the summary once only after that verification.",
};

/** The hidden message the next run starts with after a compaction: recent project context, then what to do. */
export function buildRecoveryNotice(project: string, context: string | undefined, outcome: ArchiveOutcome): string {
  const instruction = outcome === "failed" ? recoveryInstruction(project) : INSTRUCTIONS[outcome](project);
  const trimmed = context?.trim();
  return trimmed ? `${trimmed}\n\n${instruction}` : instruction;
}

// ─── Compact tool chrome (gentle-engram's memory-tool-chrome.js) ───

const TOOL_LABELS: Record<string, string> = {
  mem_search: "search",
  mem_save: "save",
  mem_update: "update",
  mem_consolidate: "consolidate",
  mem_suggest_topic_key: "suggest topic",
  mem_save_prompt: "save prompt",
  mem_session_summary: "session summary",
  mem_session_finalize: "finalize session",
  mem_context: "context",
  mem_get_observation: "get observation",
  mem_session_start: "start session",
  mem_session_end: "end session",
  mem_current_project: "current project",
  mem_doctor: "doctor",
  mem_capture_passive: "capture passive",
  mem_judge: "judge",
  mem_judge_many: "judge many",
  mem_compare: "compare",
  mem_review: "review",
  mem_list_projects: "list projects",
  mem_pin: "pin",
  mem_unpin: "unpin",
};

const ARG_KEYS: Record<string, string[]> = {
  mem_search: ["query"],
  mem_save: ["title", "type"],
  mem_update: ["id", "title"],
  mem_consolidate: ["new_title"],
  mem_suggest_topic_key: ["title", "type"],
  mem_save_prompt: ["content"],
  mem_session_summary: ["content"],
  mem_session_finalize: ["project"],
  mem_context: ["project", "scope"],
  mem_get_observation: ["id"],
  mem_session_start: ["id"],
  mem_session_end: ["id"],
  mem_current_project: ["cwd"],
  mem_doctor: ["check", "project"],
  mem_capture_passive: ["source", "content"],
  mem_judge: ["judgment_id", "relation"],
  mem_compare: ["memory_id_a", "memory_id_b"],
  mem_list_projects: ["org"],
  mem_pin: ["id"],
  mem_unpin: ["id"],
};

export const humanToolName = (name: string) => TOOL_LABELS[name] ?? name.replace(/^mem_/, "").replace(/_/g, " ");

export function truncateText(value: unknown, max = 48): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

const present = (v: unknown) => v !== undefined && v !== null && v !== "";
const quote = (v: unknown) => (truncateText(v) ? `“${truncateText(v)}”` : "");

function compactToolArg(name: string, args: Record<string, unknown>): string {
  if (name === "mem_review") {
    const id = args.observation_id ?? args.id;
    return [
      present(args.action) ? String(args.action) : "",
      present(id) ? `#${id}` : "",
      present(args.project) ? quote(args.project) : "",
      present(args.limit) ? `limit ${args.limit}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  for (const key of ARG_KEYS[name] ?? []) {
    const value = args[key];
    if (!present(value)) continue;
    return ["id", "observation_id", "memory_id_a", "memory_id_b"].includes(key) ? `#${value}` : quote(value);
  }
  return "";
}

type Data = Record<string, unknown> & { relation?: { sync_id?: string }; observation?: { id?: unknown } };
function countItems(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  const v = value as Record<string, unknown> | null | undefined;
  for (const key of ["results", "observations", "sessions", "prompts"]) {
    const list = v?.[key];
    if (Array.isArray(list)) return list.length;
  }
  return typeof v?.count === "number" ? v.count : undefined;
}

/** The one-line status of a finished (or running: `partial`) memory call; `text` is its output. */
export function compactResultStatus(
  name: string,
  data: unknown,
  opts: { text?: string; isError?: boolean; partial?: boolean } = {},
): string {
  if (opts.partial) return `${humanToolName(name)}…`;
  if (opts.isError) return `✗ ${truncateText(opts.text || "error", 64)}`;
  const d = (data ?? {}) as Data;
  const count = countItems(data);
  const id = (prefix: string, fallback: string) => (d.id ? `✓ ${prefix} #${d.id}` : `✓ ${fallback}`);
  switch (name) {
    case "mem_search":
      return `✓ ${count ?? 0} result${count === 1 ? "" : "s"}`;
    case "mem_context":
      return `✓ ${opts.text || d.context ? "loaded" : "empty"}`;
    case "mem_get_observation":
      return d.id ? `✓ observation #${d.id}` : "✓ loaded";
    case "mem_save":
    case "mem_session_summary":
      return id("saved", "saved");
    case "mem_update":
      return id("updated", "updated");
    case "mem_suggest_topic_key":
      return d.topic_key ? `✓ ${d.topic_key}` : "✓ suggested";
    case "mem_save_prompt":
      return d.prompt_id ? `✓ prompt #${d.prompt_id}` : "✓ prompt saved";
    case "mem_session_start":
      return "✓ started";
    case "mem_session_end":
      return "✓ ended";
    case "mem_current_project":
      return d.project ? `✓ ${d.project}` : "✓ detected";
    case "mem_doctor":
      return d.status ? `✓ ${d.status}` : "✓ checked";
    case "mem_capture_passive":
      return `✓ captured ${d.saved ?? count ?? 0}`;
    case "mem_judge":
      return d.relation?.sync_id ? `✓ judged ${d.relation.sync_id}` : "✓ judged";
    case "mem_compare":
      return d.sync_id ? `✓ ${d.sync_id}` : "✓ compared";
    case "mem_review": {
      if (count !== undefined) return `✓ ${count} need${count === 1 ? "s" : ""} review`;
      const reviewed = d.id ?? d.observation_id ?? d.observation?.id;
      return reviewed ? `✓ reviewed #${reviewed}` : "✓ reviewed";
    }
    default:
      return "✓ done";
  }
}

export const renderCallText = (name: string, args: Record<string, unknown>) => {
  const arg = compactToolArg(name, args);
  return `🧠 ${humanToolName(name)}${arg ? ` ${arg}` : ""} …`;
};

/** `↳ <status>`, then (expanded) the output, else the data as JSON */
export function renderResultText(
  name: string,
  data: unknown,
  opts: { text?: string; isError?: boolean; partial?: boolean; expanded?: boolean },
): string {
  const status = compactResultStatus(name, data, opts);
  if (!opts.expanded || opts.partial) return `↳ ${status}`;
  return `↳ ${status}\n\n${opts.text || truncateText(JSON.stringify(data, null, 2), 2000)}`;
}
