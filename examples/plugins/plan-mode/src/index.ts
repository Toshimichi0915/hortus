import { type Ctx, type Effort, EFFORTS, type Plugin, type PluginEntry, type SessionState } from "@hortus/core";

/** Tools a plan mode run doesn't get (codemode scripts reach only the run's tools, so not these either). */
const WRITING = new Set(["write", "edit", "bash"]);

/** Plan mode: off when undefined; else the model (and effort) runs use while it is on, if set. */
interface Mode {
  provider?: string;
  model?: string;
  effort?: Effort;
}
/** The session branch's mode, as its last `plan-mode:mode` entry left it. */
const modeOf = (state?: SessionState) => state?.data["plan-mode"] as Mode | undefined;
const current = (ctx: Ctx) => modeOf(ctx.session?.getState());

/**
 * `/plan` toggles plan mode: runs lose `write`/`edit`/`bash` (in codemode scripts too) and are told to plan rather than act, optionally on
 * another model and effort (`/plan <provider>/<model> [effort]`). The mode is a session entry (`plan-mode:mode`), so it
 * is per branch and resuming keeps it; runs read it in `run_start` and `prompt`.
 */
export default {
  entries: {
    mode: (entry: PluginEntry<Mode | null>, state) => {
      state.data["plan-mode"] = entry.data ?? undefined;
    },
  },
  on: {
    run_start: (p, ctx) => {
      const mode = current(ctx);
      if (!mode) return;
      p.tools = p.tools.filter((t) => !WRITING.has(t.name));
      if (mode.provider) p.provider = mode.provider;
      if (mode.model) p.model = mode.model;
      if (mode.effort) p.effort = mode.effort;
    },
    prompt: ({ system }, ctx) => {
      if (current(ctx))
        system.push(
          "Plan mode is on: you can't change files or run commands. Investigate with the tools you have, then reply with a step-by-step plan for the user to approve.",
        );
    },
  },
  commands: [
    {
      name: "plan",
      args: "[off | <provider>/<model> [effort]]",
      description: "Toggle plan mode: no writing tools, optionally another model",
      run: async (arg, ctx) => {
        const session = ctx.session;
        if (!session) throw new Error("No session to plan in");
        const [target, effort] = arg.trim().split(/\s+/).filter(Boolean);
        if (target === "off" || (!target && modeOf(session.getState()))) {
          await session.appendEntry("plan-mode:mode", null);
          return "Plan mode off";
        }
        if (effort && !EFFORTS.includes(effort as Effort))
          throw new Error(`Usage: /plan [off | <provider>/<model> [${EFFORTS.join("|")}]]`);
        const slash = target?.indexOf("/") ?? -1;
        if (target && slash < 1) throw new Error("Usage: /plan [off | <provider>/<model> [effort]]");
        const mode: Mode = {
          ...(target && { provider: target.slice(0, slash), model: target.slice(slash + 1) }),
          ...(effort && { effort: effort as Effort }),
        };
        await session.appendEntry("plan-mode:mode", mode);
        return `Plan mode on${target ? ` with ${target}${effort ? ` (${effort})` : ""}` : ""}`;
      },
    },
  ],
} satisfies Plugin;
