import { discoverSkills, listSkills, type Piece, skillsPrompt, version } from "../index.ts";

/**
 * Skills found on disk (re-read every run) and the `<available_skills>` prompt; the model reads them with `read`. It
 * sets `run_start.skills` (from the `skills` event, which it fires), so later `run_start` handlers can change them.
 */
export default {
  name: "builtin:skills",
  version,
  dependencies: { "builtin:read": "*" },
  plugin: {
    on: {
      skills: async (p, ctx) => {
        p.skills.push(...(await discoverSkills(ctx.cwd)));
      },
      run_start: async (p, ctx) => {
        p.skills = await listSkills(ctx);
      },
      prompt: ({ system, skills = [] }) => {
        const prompt = skillsPrompt(skills);
        if (prompt) system.push(prompt);
      },
    },
  },
} satisfies Piece;
