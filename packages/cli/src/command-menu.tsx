import { Box, type Key, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import stringWidth from "string-width";
import type { Cli } from "./cli.ts";
import { type Candidate, type Command, findCommand, parseCommand } from "./commands.ts";
import { theme } from "./entry.ts";

/** One row of the `/` menu, and the input once it's chosen. */
export interface Suggestion {
  label: string;
  /** dim text after the label */
  description?: string;
  value: string;
}

/** 0 exact, 1 prefix, 2 substring, 3 no match; ignoring case. */
function rank(text: string, query: string) {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  return t === q ? 0 : t.startsWith(q) ? 1 : t.includes(q) ? 2 : 3;
}

/** The matching rows, exact first, then prefix, then substring; sort is stable, so each rank keeps its order. */
const byRank = (matches: { rank: number; row: Suggestion }[]) =>
  matches
    .filter((m) => m.rank < 3)
    .sort((a, b) => a.rank - b.rank)
    .map((m) => m.row);

/**
 * The `/` menu's rows for `input`: commands while the name is typed, then the command's candidates from `loaded` for
 * its argument; undefined while those are still loading.
 */
export function suggest(commands: Command[], input: string, loaded: Map<Command, Candidate[]>) {
  const parsed = parseCommand(input);
  if (!parsed) return [];
  const { name, arg } = parsed;
  if (arg === undefined)
    return byRank(
      commands
        .map((c) => {
          // shown by the name that matches best, the canonical one on a tie; not by an alias that runs another command
          const [shown, r] = [c.name, ...(c.aliases ?? []).filter((a) => findCommand(commands, a) === c)]
            .map((n) => [n, rank(n, name)] as const)
            .reduce((a, b) => (b[1] < a[1] ? b : a));
          const row = {
            label: `/${shown}${c.args ? ` ${c.args}` : ""}`,
            description: c.description,
            // a command that takes an argument leaves room to type it
            value: `/${shown}${c.args || c.complete ? " " : ""}`,
          };
          return { shown, rank: r, row };
        })
        .sort((a, b) => a.shown.localeCompare(b.shown)),
    );
  const cmd = findCommand(commands, name);
  const candidates = cmd?.complete ? loaded.get(cmd) : [];
  return (
    candidates &&
    byRank(
      candidates.map((c) => ({
        // by the label too, just below the same kind of value match: `m` puts model m0 above every model of a provider
        // whose name has an m, while an exact value still beats a label equal to it (openai/gpt-5 on openrouter)
        rank: Math.min(rank(c.value, arg), rank(c.label ?? c.value, arg) + 0.5),
        row: { label: c.label ?? c.value, description: c.description, value: `/${name} ${c.value}` },
      })),
    )
  );
}

/**
 * The `/` menu for the prompt's `input`. `onKey` takes the prompt's ↑/↓ (select), Tab (put the selected row into the
 * input) and Enter (the same, unless the input already is it or nothing has loaded yet: then it submits) while the menu
 * shows; `hide` is Esc.
 */
export function useCommandMenu(cli: Cli, input: string, setInput: (value: string) => void) {
  // each command's last candidates, so coming back to its argument doesn't show Loading… again
  const [loaded, setLoaded] = useState(() => new Map<Command, Candidate[]>());
  const parsed = parseCommand(input);
  const cmd = parsed?.arg === undefined ? undefined : findCommand(cli.commands, parsed.name);
  // the latest call per command, so an older, slower one can't overwrite its list (one still running when the argument
  // is left keeps its list for next time)
  const calls = useRef(new Map<Command, number>());
  // once each time the argument starts being typed, not per keystroke
  useEffect(() => {
    const complete = cmd?.complete;
    if (!cmd || !complete) return;
    const n = (calls.current.get(cmd) ?? 0) + 1;
    calls.current.set(cmd, n);
    const latest = () => calls.current.get(cmd) === n;
    const keep = (list: unknown) => {
      // plugin code: candidates that aren't all strings are left out, and so are repeats (rows are told apart by value)
      const next = [
        ...new Map(
          (Array.isArray(list) ? list : [])
            .filter((c) => [c?.value, c?.label ?? "", c?.description ?? ""].every((s) => typeof s === "string"))
            .map((c) => [c.value, c] as const),
        ).values(),
      ];
      // an unchanged list leaves the rows, and so the selection, as they are
      if (latest())
        setLoaded((m) => (JSON.stringify(m.get(cmd)) === JSON.stringify(next) ? m : new Map(m).set(cmd, next)));
    };
    // the promise turns a sync throw into a rejection too
    new Promise<Candidate[]>((resolve) => resolve(complete(cli))).then(keep, (e) => {
      if (latest()) cli.report(`Completing /${cmd.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      keep([]);
    });
  }, [cli, cmd]);
  const rows = suggest(cli.commands, input, loaded);

  // the selected row's value, so a refreshed list keeps that row selected; none, or one that's gone, is the first row
  const [sel, setSel] = useState<string>();
  const [hidden, setHidden] = useState(false);
  // any edit selects the first row again and brings back a menu hidden by Esc
  const [seen, setSeen] = useState(input);
  if (seen !== input) {
    setSeen(input);
    setSel(undefined);
    setHidden(false);
  }
  const indexOf = (value: string | undefined) => Math.max(0, rows?.findIndex((r) => r.value === value) ?? 0);
  const at = indexOf(sel);
  const shown = !hidden && (!rows || rows.length > 0);

  const onKey = (_: string, key: Key) => {
    const row = rows?.[at];
    const dir = key.upArrow ? -1 : key.downArrow ? 1 : 0;
    const enter = key.return && !key.shift && !key.meta;
    if (!shown || !(dir || (key.tab && !key.shift) || enter) || (enter && (!row || row.value === input))) return false;
    // from the latest selection: keys can come faster than renders (a held ↓)
    if (dir) setSel((v) => rows?.[Math.max(0, Math.min(indexOf(v) + dir, (rows?.length ?? 0) - 1))]?.value);
    // nothing to fill while loading
    else if (row) setInput(row.value);
    return true;
  };
  return { rows, at, shown, hide: () => setHidden(true), onKey };
}

const MENU_ROWS = 5;

/** `rows` under the prompt, at most five, scrolled to keep the selected (accent) one in view; undefined = loading. */
export function CommandMenu({ rows, at }: { rows: Suggestion[] | undefined; at: number }) {
  // the session picker's window: the selection stays mid-way where it can
  const start = Math.max(0, Math.min(at - Math.floor(MENU_ROWS / 2), (rows?.length ?? 0) - MENU_ROWS));
  const shown = rows?.slice(start, start + MENU_ROWS) ?? [];
  // descriptions line up in one column, which stays put while scrolling
  const width = Math.max(0, ...(rows ?? []).map((r) => stringWidth(r.label)));
  return (
    // under the typed text
    <Box flexShrink={0} flexDirection="column" paddingLeft={4}>
      {!rows && <Text color={theme.dim}>Loading…</Text>}
      {shown.map((r, i) => {
        const color = start + i === at ? theme.accent : undefined;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional (values can repeat)
          <Text key={i} wrap="truncate-end" color={color}>
            {r.label}
            {r.description && (
              <Text color={color ?? theme.dim}>
                {" ".repeat(width - stringWidth(r.label) + 2)}
                {r.description}
              </Text>
            )}
          </Text>
        );
      })}
    </Box>
  );
}
