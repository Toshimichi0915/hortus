import type { Ctx } from "@hortus/core";
import { type CliPiece, version } from "../api.ts";

/** The ctx's session (the TUI's shown one; a headless host's current one). */
export function sessionOf(ctx: Ctx) {
  if (!ctx.session) throw new Error("No session");
  return ctx.session;
}

export default {
  name: "cli:model",
  version,
  plugin: {
    commands: [
      {
        name: "model",
        args: "[provider/model]",
        description: "Switch the provider and model",
        // listed afresh each time, so a provider that failed shows up once it works; the menu shows the last list
        // meanwhile
        complete: async (ctx) =>
          (await ctx.listModels()).map(({ provider, id }) => ({
            value: `${provider}/${id}`,
            label: id,
            description: provider,
          })),
        run: async (arg, ctx) => {
          if (!arg) {
            // resolved, so the config's defaults show too
            const r = await ctx.resolve().catch(() => undefined);
            return r ? `Model: ${r.provider}/${r.model}` : "No model selected";
          }
          // the provider ends at the first "/"; model ids may have more (openrouter/anthropic/claude-sonnet-4.5)
          const [, provider, model] = arg.match(/^([^/\s]+)\/(\S+)$/) ?? [];
          if (!provider || !model) throw new Error("Usage: /model <provider>/<model>");
          // the session shown now, even if another is shown while resolving
          const session = sessionOf(ctx);
          // throws for a provider missing from secrets.json or of an unknown type
          await ctx.resolve({ provider, model });
          await session.setModel(model, provider);
          return `Model set to ${provider}/${model}`;
        },
      },
    ],
  },
} satisfies CliPiece;
