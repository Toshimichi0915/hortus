import type { Message, Plugin } from "@hortus/core";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Paths the calls in `messages` named (`path` inputs: read, write, edit and the like), first seen first. */
const files = (messages: readonly Message[]) => [
  ...new Set(
    messages.flatMap((m) =>
      m.role === "assistant"
        ? m.toolCalls.flatMap((c) => {
            const path = (c.input as { path?: unknown } | undefined)?.path;
            return typeof path === "string" ? [path] : [];
          })
        : [],
    ),
  ),
];

const TITLES = ["Earlier", "User requests", "Files touched", "Last reply"];
/** the body of section `## title` in `summary` (one of ours: the sections split at `TITLES` only) */
const section = (summary: string | undefined, title: string) =>
  summary
    ?.split(new RegExp(`^## (?=(?:${TITLES.join("|")})\n)`, "m"))
    .find((s) => s.startsWith(`${title}\n`))
    ?.slice(title.length + 1)
    .trim();
/** the `- ` items of section `## title` in `summary` */
const items = (summary: string | undefined, title: string) =>
  section(summary, title)
    ?.split("\n")
    .flatMap((l) => (l.startsWith("- ") ? [l.slice(2)] : [])) ?? [];
/** `older` then `newer`, each once (its latest), the last `max` */
const merge = (older: string[], newer: string[], max: number) =>
  [...new Set([...older, ...newer].reverse())].reverse().slice(-max);

/**
 * The summary of `messages` without a model: the user's requests, files touched (each merged with `previous`'s, the
 * newest kept, so repeated compactions don't grow it), and the last reply (else `previous`'s). A `previous` not ours
 * (a model's) is kept once as `## Earlier`, carried over as it is.
 */
export function summarize(messages: readonly Message[], previous?: string): { summary: string; files: string[] } {
  const asks = merge(
    items(previous, "User requests"),
    messages.flatMap((m) => (m.role === "user" && !m.meta ? [clip(m.content.trim().replace(/\s+/g, " "), 200)] : [])),
    20,
  );
  const touched = merge(items(previous, "Files touched"), files(messages), 50);
  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.text);
  const reply = last?.role === "assistant" ? clip(last.text.trim(), 500) : section(previous, "Last reply");
  const ours = TITLES.some((t) => section(previous, t) !== undefined);
  const earlier = ours ? section(previous, "Earlier") : previous?.trim();
  const sections = [
    earlier && `## Earlier\n${earlier}`,
    asks.length && `## User requests\n${asks.map((a) => `- ${a}`).join("\n")}`,
    touched.length && `## Files touched\n${touched.map((f) => `- ${f}`).join("\n")}`,
    reply && `## Last reply\n${reply}`,
  ];
  return { summary: sections.filter(Boolean).join("\n\n") || "(nothing to summarize)", files: touched };
}

/**
 * An algorithmic compactor: builtin:compaction still decides when and where to cut and saves the entry, but this
 * plugin's `compact` handler writes the summary from the messages, so no model call is made. Sessions it compacted
 * replay without it (the entry is builtin:compaction's).
 */
export default {
  on: {
    compact: (p) => {
      if (p.summary !== undefined) return;
      const { summary, files } = summarize(p.messages, p.previousSummary);
      p.summary = summary;
      p.details = { files };
    },
  },
} satisfies Plugin;
