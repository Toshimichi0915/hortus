import { type Piece, version } from "../index.ts";

/** `/name <title>` titles the current session (a `name` entry: `listSessions`' title); no title: shows it. */
export default {
  name: "builtin:name",
  version,
  plugin: {
    commands: [
      {
        name: "name",
        args: "[title]",
        description: "Name the session",
        run: async (arg, ctx) => {
          const session = ctx.session;
          if (!session) throw new Error("No session to name");
          const title = arg.trim();
          if (!title) return session.getState().name ?? "The session has no name";
          await session.setName(title);
          return `Session named ${title}`;
        },
      },
    ],
  },
} satisfies Piece;
