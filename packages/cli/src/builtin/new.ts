import { dirname } from "node:path";
import { openSession } from "@hortus/core";
import { type CliPiece, cliOf, version } from "../api.ts";

export default {
  name: "cli:new",
  version,
  plugin: {
    commands: [
      {
        name: "new",
        aliases: ["clear"],
        description: "Start a new session",
        // next to the current one; model and provider start from the config again
        run: async (_, ctx) => {
          const { path } = cliOf(ctx).session;
          const kept = !(await cliOf(ctx).setSession(await openSession(null, path && dirname(path)), "new"));
          return kept ? "A plugin kept the current session" : undefined;
        },
      },
    ],
  },
} satisfies CliPiece;
