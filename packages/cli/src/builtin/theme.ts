import { type CliPiece, cliOf, dark, version } from "../api.ts";

export default {
  name: "cli:theme",
  version,
  plugin: {
    commands: [
      {
        name: "theme",
        args: "[name]",
        description: "Switch the color theme",
        complete: (ctx) => Object.keys(cliOf(ctx).themes).map((value) => ({ value })),
        run: (arg, ctx) => {
          const cli = cliOf(ctx);
          if (!arg) return `Theme: ${cli.ui.getState().theme}`;
          cli.setTheme(arg);
          return `Theme set to ${arg}`;
        },
      },
    ],
    // the built-in theme; theme packs add theirs
    cli: { themes: { dark } },
  },
} satisfies CliPiece;
