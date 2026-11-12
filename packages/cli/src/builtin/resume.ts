import { dirname } from "node:path";
import { listSessions, openSession } from "@hortus/core";
import { type CliPiece, cliOf, stamp, version } from "../api.ts";

export default {
  name: "cli:resume",
  version,
  plugin: {
    commands: [
      {
        name: "resume",
        args: "[session]",
        description: "Resume a session",
        // the sessions next to the shown one, newest first, without it; titles on one line, like the session picker's
        complete: async (ctx) => {
          const { path } = cliOf(ctx).session;
          return (await listSessions(path && dirname(path)))
            .filter((s) => s.path !== path)
            .map((s) => ({
              value: s.id,
              label: `${stamp(s.created)}  ${s.title.replace(/\s+/g, " ") || "(no messages)"}`,
            }));
        },
        run: async (arg, ctx) => {
          const { path } = cliOf(ctx).session;
          const dir = path && dirname(path);
          // no id: the first candidate, so Enter while they're still loading picks what it would have
          const s = (await listSessions(dir)).find((s) => (arg ? s.id === arg : s.path !== path));
          if (!s) throw new Error(arg ? `Session not found: ${arg}` : "No sessions to resume");
          // at its last entry, like `hortus -r`
          if (!(await cliOf(ctx).setSession(await openSession(s.leafId, dir), "resume")))
            return "A plugin kept the current session";
        },
      },
    ],
  },
} satisfies CliPiece;
