/**
 * The TUI's color tokens; every color it draws comes from the current theme. The first group is required of a full
 * theme; each role token (the rest) falls back to the generic token named in `ROLES` unless the theme sets it. A
 * plugin may add tokens of its own (any other name), read as `theme["<name>"]`. "" is the terminal's default color.
 */
export interface Theme {
  text: string;
  muted: string;
  dim: string;
  accent: string;
  border: string;
  borderIdle: string;
  green: string;
  red: string;
  yellow: string;
  blue: string;
  thinking: string;
  /** behind user messages */
  userBackground: string;
  /** behind a tool block: running, done, failed */
  toolRunning: string;
  toolDone: string;
  toolError: string;
  /** behind selected text (the transcript's mouse selection); "" or the background under it = drawn inverted instead */
  selectedBg: string;
  /** behind plugin messages drawn by the built-in renderer ("" = none) */
  customMessageBg: string;
  userMessageText: string;
  assistantText: string;
  customMessageText: string;
  toolTitle: string;
  toolOutput: string;
  toolDiffAdded: string;
  toolDiffRemoved: string;
  toolDiffContext: string;
  mdHeading: string;
  mdLink: string;
  mdLinkUrl: string;
  mdCode: string;
  mdCodeBlock: string;
  mdCodeBlockBorder: string;
  mdQuote: string;
  mdQuoteBorder: string;
  mdHr: string;
  mdListBullet: string;
  mdTableBorder: string;
  mdTableHeader: string;
  /** the prompt's border per effort (when set; auto uses `border`) */
  thinkingOff: string;
  thinkingLow: string;
  thinkingMedium: string;
  thinkingHigh: string;
  thinkingXhigh: string;
  thinkingMax: string;
  /** plugins' own tokens */
  [token: string]: string;
}

/** Each role token's fallback: the generic token it copies when a theme leaves it out. */
const ROLES = {
  userMessageText: "text",
  assistantText: "text",
  customMessageText: "text",
  toolTitle: "text",
  toolOutput: "muted",
  toolDiffAdded: "green",
  toolDiffRemoved: "red",
  toolDiffContext: "muted",
  mdHeading: "yellow",
  mdLink: "blue",
  mdLinkUrl: "muted",
  mdCode: "accent",
  mdCodeBlock: "green",
  mdCodeBlockBorder: "muted",
  mdQuote: "muted",
  mdQuoteBorder: "muted",
  mdHr: "muted",
  mdListBullet: "accent",
  mdTableBorder: "dim",
  mdTableHeader: "text",
  thinkingOff: "border",
  thinkingLow: "border",
  thinkingMedium: "border",
  thinkingHigh: "border",
  thinkingXhigh: "border",
  thinkingMax: "border",
} as const;

/** pi's dark theme's generic tokens: the okhsl() colors of its dark.json, as hex. */
const darkTokens = {
  text: "#dee0e1",
  muted: "#9da5a9",
  dim: "#7e888e",
  accent: "#a798d7",
  border: "#5fa8cc",
  borderIdle: "#6c767b",
  green: "#68b78d",
  red: "#ea7f81",
  yellow: "#cd9a22",
  blue: "#69add0",
  thinking: "#96a0a4",
  userBackground: "#213b49",
  toolRunning: "#34383a",
  toolDone: "#254131",
  toolError: "#5b282a",
  selectedBg: "#3e5f73",
  customMessageBg: "",
};

/** pi's dark theme; the built-in default. */
export const dark: Theme = full({});

/** `t` made whole: the generic tokens it leaves out from `dark`'s, then each role it leaves out from its generic token. */
export function full(t: Partial<Theme>): Theme {
  const out = { ...darkTokens, ...t } as Theme;
  for (const [role, from] of Object.entries(ROLES)) out[role] = t[role] ?? out[from];
  return out;
}

/**
 * The current theme's tokens. One object, changed in place by `cli.setTheme`, so code reading `theme.red` while it
 * draws gets the current color; components re-render on a switch through `useTheme()` (or any `useUi` read).
 */
export const theme: Theme = { ...dark };

/** bumped by every `applyTheme`, so caches of drawn rows know their colors are stale */
export let themeVersion = 0;

/** Makes `t` (merged over `dark`, see `full`) the current theme (see `theme`). */
export function applyTheme(t: Partial<Theme>) {
  for (const k of Object.keys(theme)) delete theme[k];
  Object.assign(theme, full(t));
  themeVersion++;
}
