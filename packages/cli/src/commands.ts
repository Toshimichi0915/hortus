import { dirname } from "node:path";
import { listSessions, openSession } from "@phi/core";
import type { Cli } from "./cli.ts";
import { stamp } from "./entry.ts";

/** One choice for a command's argument. */
export interface Candidate {
  /** the argument once chosen; the typed argument is matched against it and the label */
  value: string;
  /** shown in the menu instead of `value` */
  label?: string;
  /** dim text after the label */
  description?: string;
}

/** A `/name arg` command. The built-in ones use nothing a plugin's `cli.commands` can't. */
export interface Command {
  name: string;
  /** other names that run it, e.g. "clear" for "new" */
  aliases?: string[];
  description: string;
  /** argument hint shown in the menu, e.g. "[provider/model]" */
  args?: string;
  /** every candidate for the argument; called when the argument starts being typed, then narrowed by what's typed */
  complete?: (cli: Cli) => Candidate[] | Promise<Candidate[]>;
  /** returned text is shown as an info line, a thrown error as an error line */
  run: (arg: string, cli: Cli) => string | void | Promise<string | undefined> | Promise<void>;
}

/**
 * `/name arg` split up; `arg` is undefined while the name is still being typed (no space after it yet). One line only,
 * and a name has no "/", so a message starting with a path (`/etc/hosts is ...`) isn't a command.
 */
export function parseCommand(input: string) {
  const m = input.match(/^\/([^\s/]*)(?: +(.*))?$/);
  return m && { name: m[1] ?? "", arg: m[2] };
}

/** The command `name` runs: the one called that, else one with it as an alias. */
export const findCommand = (commands: Command[], name: string) =>
  commands.find((c) => c.name === name) ?? commands.find((c) => c.aliases?.includes(name));

/** /new, /model and /resume. */
export const builtinCommands: Command[] = [
  {
    name: "new",
    aliases: ["clear"],
    description: "Start a new session",
    // next to the current one; model and provider start from the config again
    run: async (_, cli) => cli.setSession(await openSession(null, dirname(cli.session.path))),
  },
  {
    name: "model",
    args: "[provider/model]",
    description: "Switch the provider and model",
    // listed afresh each time, so a provider that failed shows up once it works; the menu shows the last list meanwhile
    complete: async (cli) =>
      (await cli.agent.listModels()).map(({ provider, id }) => ({
        value: `${provider}/${id}`,
        label: id,
        description: provider,
      })),
    run: async (arg, cli) => {
      if (!arg) {
        // resolved, so the config's defaults show too
        const { status } = cli.ui.getState();
        return status ? `Model: ${status.name}/${status.model}` : "No model selected";
      }
      // the provider ends at the first "/"; model ids may have more (openrouter/anthropic/claude-sonnet-4.5)
      const [, provider, model] = arg.match(/^([^/\s]+)\/(\S+)$/) ?? [];
      if (!provider || !model) throw new Error("Usage: /model <provider>/<model>");
      // the session shown now, even if another is shown while resolving
      const { session } = cli;
      // throws for a provider missing from secrets.json or of an unknown type
      await cli.agent.resolve({ provider, model });
      await session.setModel(model, provider);
      return `Model set to ${provider}/${model}`;
    },
  },
  {
    name: "resume",
    args: "[session]",
    description: "Resume a session",
    // the sessions next to the shown one, newest first, without it; titles on one line, like the session picker's
    complete: async (cli) =>
      (await listSessions(dirname(cli.session.path)))
        .filter((s) => s.path !== cli.session.path)
        .map((s) => ({
          value: s.id,
          label: `${stamp(s.created)}  ${s.title.replace(/\s+/g, " ") || "(no messages)"}`,
        })),
    run: async (arg, cli) => {
      const { path } = cli.session;
      // no id: the first candidate, so Enter while they're still loading picks what it would have
      const s = (await listSessions(dirname(path))).find((s) => (arg ? s.id === arg : s.path !== path));
      if (!s) throw new Error(arg ? `Session not found: ${arg}` : "No sessions to resume");
      // at its last entry, like `phi -r`
      cli.setSession(await openSession(s.leafId, dirname(path)));
    },
  },
];
