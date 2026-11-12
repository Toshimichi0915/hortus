import { type Ctx, EFFORTS, type Effort } from "@hortus/core";
import { type Cli, type CliPiece, version } from "../api.ts";
import { sessionOf } from "./model.ts";

/** The TUI behind `ctx`, if that's the host: it keeps the shown effort and saves it to config.json. */
const tui = (ctx: Ctx) => (ctx.host as { cli?: Cli }).cli;

/** The efforts the session's model takes, when its provider reports them (undefined: any, or not resolvable). */
const efforts = async (ctx: Ctx) => (await ctx.resolve().catch(() => undefined))?.info.efforts;

export default {
  name: "cli:effort",
  version,
  plugin: {
    commands: [
      {
        name: "effort",
        aliases: ["thinking"],
        args: "[level]",
        description: "Set the thinking effort (shift+tab cycles it)",
        // only the ones the model takes, when the API reports them
        complete: async (ctx) => {
          const takes = await efforts(ctx);
          return [
            { value: "auto", description: "provider default" },
            ...EFFORTS.filter((e) => takes?.includes(e) ?? true).map((value) => ({ value })),
          ];
        },
        run: async (arg, ctx) => {
          const cli = tui(ctx);
          if (!arg) return `Effort: ${(cli ? cli.ui.getState().effort : sessionOf(ctx).getState().effort) ?? "auto"}`;
          if (arg !== "auto" && !EFFORTS.includes(arg as Effort))
            throw new Error(`Usage: /effort <auto|${EFFORTS.join("|")}>`);
          const effort = arg === "auto" ? undefined : (arg as Effort);
          if (effort && !((await efforts(ctx))?.includes(effort) ?? true))
            throw new Error(`${(await ctx.resolve()).model} doesn't support effort ${arg}`);
          // the TUI's also becomes the next sessions' default; elsewhere, the session's own
          if (cli) cli.setEffort(effort);
          else await sessionOf(ctx).setEffort(effort);
          return `Effort set to ${arg}`;
        },
      },
    ],
  },
} satisfies CliPiece;
