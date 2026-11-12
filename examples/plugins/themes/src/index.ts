import { readdirSync, readFileSync } from "node:fs";
import type { CliPlugin, Theme } from "@hortus/cli";

/** A Pi theme file (pi.dev/schemas/theme.schema.json): colors are hex, a 256-color index, a `vars` name, or "". */
interface PiTheme {
  name: string;
  vars?: Record<string, string | number>;
  colors: Record<string, string | number>;
}

/** Resolves a Pi color to one Ink draws: hex as is, an index as `ansi256(n)`, "" (terminal default) as "". */
function resolve(pi: PiTheme, value: string | number | undefined, seen: string[] = []): string {
  if (value === undefined) throw new Error(`${pi.name}: missing color`);
  if (typeof value === "number") return `ansi256(${value})`;
  if (value === "" || value.startsWith("#")) return value;
  // ponytail: okhsl()/oklch() (Pi's built-in themes use them; this pack doesn't) are rejected, convert them if a pack needs it
  if (!pi.vars || !(value in pi.vars) || seen.includes(value)) throw new Error(`${pi.name}: bad color ${value}`);
  return resolve(pi, pi.vars[value], [...seen, value]);
}

/** hortus tokens a Pi token of another name fills; every other Pi token keeps its name (hortus's role tokens share Pi's). */
const RENAMED: Record<string, string> = {
  borderIdle: "borderMuted",
  green: "success",
  red: "error",
  yellow: "warning",
  blue: "mdLink",
  thinking: "thinkingText",
  userBackground: "userMessageBg",
  toolRunning: "toolPendingBg",
  toolDone: "toolSuccessBg",
  toolError: "toolErrorBg",
};

/**
 * Maps a Pi theme onto hortus's tokens: Pi's tokens as they are (the role tokens hortus shares, like `mdHeading` or
 * `thinkingHigh`, and the rest kept as plugin tokens, like `syntaxKeyword`), plus the generic ones Pi names otherwise.
 */
export function fromPi(pi: PiTheme): Partial<Theme> {
  const all: Record<string, string> = {};
  for (const token of Object.keys(pi.colors)) all[token] = resolve(pi, pi.colors[token]);
  for (const [token, from] of Object.entries(RENAMED)) if (from in all) all[token] = all[from] as string;
  return all;
}

const dir = new URL("../themes/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const pis = files.map((f): PiTheme => JSON.parse(readFileSync(new URL(f, dir), "utf8")));

export default {
  cli: { themes: Object.fromEntries(pis.map((pi) => [pi.name, fromPi(pi)])) },
} satisfies CliPlugin;
