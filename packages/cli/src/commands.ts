import { type AgentCommand, expandSkill, type Skill } from "@hortus/core";
import type { Cli } from "./cli.ts";

export type { AgentCommand, Candidate, Command } from "@hortus/core";

/**
 * `/name arg` split up; `arg` is undefined while the name is still being typed (no space after it yet). One line only,
 * and a name has no "/", so a message starting with a path (`/etc/hosts is ...`) isn't a command.
 */
export function parseCommand(input: string) {
  const m = input.match(/^\/([^\s/]*)(?: +(.*))?$/);
  return m && { name: m[1] ?? "", arg: m[2] };
}

/** The command `name` runs: the one called that, else one with it as an alias. */
export const findCommand = <C extends { name: string; aliases?: string[] }>(commands: C[], name: string) =>
  commands.find((c) => c.name === name) ?? commands.find((c) => c.aliases?.includes(name));

/**
 * `/skills:<name> [request]`, also run as `/<name>` unless a command is called that: a turn starting with the skill's
 * instructions. Commands are matched by name before aliases, so a skill never shadows one.
 */
export const skillCommand = (skill: Skill, cli: Cli): AgentCommand => ({
  name: `skills:${skill.name}`,
  aliases: [skill.name],
  args: "[request]",
  description: skill.description.replace(/\s+/g, " ").trim(),
  plugin: "builtin:skills",
  run: async (arg) => {
    if (!cli.submit(await expandSkill(skill, arg))) throw new Error("A turn is running: send it once it's done");
    return undefined;
  },
});
