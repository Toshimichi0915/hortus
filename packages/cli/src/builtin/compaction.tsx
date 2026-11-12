import { Text } from "ink";
import { type CliPiece, cliOf, type EntryRenderer, theme, version } from "../api.ts";

const KIND = "builtin:compaction:summary";
/** the summary's first line of prose (its headings skipped) */
const gist = (meta: unknown) =>
  ((meta as { details?: { summary?: string } } | undefined)?.details?.summary ?? "")
    .split("\n")
    .find((l) => l.trim() && !l.startsWith("#"))
    ?.trim() ?? "";

const line: EntryRenderer = {
  Render: ({ entry }) => (
    <Text wrap="truncate-end">
      <Text color={theme.accent}>{"◆ compacted "}</Text>
      <Text color={theme.dim}>{gist(entry.meta)}</Text>
    </Text>
  ),
  text: ({ entry, width }) => `◆ compacted ${gist(entry.meta)}`.slice(0, width),
};

/**
 * builtin:compaction's summary message as one line in the transcript: shown live when a compaction of the shown session
 * is saved (`compacted`), and on resume (the session then starts with it).
 */
export default {
  name: "cli:compaction",
  version,
  plugin: {
    on: {
      compacted: ({ entry }, ctx) => {
        const cli = cliOf(ctx);
        if ((ctx.run?.depth ?? 0) > 0 || ctx.session !== cli.ui.getState().session) return;
        const m = ctx.session.getState().messages.find((x) => x.entryId === entry.id);
        if (m?.role === "user") cli.push({ kind: KIND, text: m.content, ...(m.meta && { meta: m.meta }) });
      },
    },
    cli: {
      entries: {
        [KIND]: line,
      },
    },
  },
} satisfies CliPiece;
