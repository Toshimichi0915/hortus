import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AskEvent, Ctx, Piece, Plugin, SessionState } from "@hortus/core";
import type { Key } from "ink";
import { type ComponentType, createContext, type ReactNode, useContext } from "react";
import { useStore } from "zustand";
import type { Cli, UiState } from "./cli.ts";
import type { Suggestion } from "./command-menu.tsx";
import { type Theme, theme } from "./themes.ts";
import type { EntryRenderer, ToolRenderer } from "./tools.tsx";

export type { AgentCommand, Answer, Answered, AskEvent, Candidate, Command, SessionState } from "@hortus/core";
export { useStore } from "zustand";
export { useShallow } from "zustand/react/shallow";
export { createStore, type StoreApi } from "zustand/vanilla";
export { type Cli, runEffort, type Status, supports, type Terminal, type UiState } from "./cli.ts";
export type { Suggestion } from "./command-menu.tsx";
export {
  type Entry,
  stamp,
  type TextEntry,
  type TextKind,
  type ToolEntry,
  type ToolSibling,
  usageLine,
} from "./entry.ts";
export type { Span } from "./markdown.ts";
export { PromptInput } from "./prompt-input.tsx";
export { dark, full, type Theme, theme } from "./themes.ts";
export {
  type EntryRenderer,
  type EntryView,
  linesRenderer,
  type ToolBlock,
  type ToolChrome,
  type ToolRenderer,
  type ToolView,
} from "./tools.tsx";

/** @hortus/cli's version, which its pieces (`cli:*`) carry and plugins depend on as "@hortus/cli". */
export const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * The `hortus` executable (this package's `dist/index.js`), for plugins spawning `hortus -p`/`--rpc` children:
 * `spawn(process.execPath, [hortusBin, ...args])`. Through the host's resolve hook it is the running host's own.
 */
export const hortusBin = fileURLToPath(new URL("./index.js", import.meta.url));

/** UI parts a plugin can replace; each gets the one it replaces as `Default`. */
export interface Slots {
  /** the bottom line */
  statusBar: ComponentType;
  /**
   * the input with its `/` menu; owns Esc (abort), Ctrl+C (clear), Shift+Tab, so a takeover owns them (it may call
   * `cli.abort`). While an `ask` is pending its dialog (`asks`) takes the slot's place, takeover or not: a
   * takeover is unmounted meanwhile, so keep drafts outside it (a store, or `cli.setInput`). `prefix` replaces the
   * built-in input's `> ` (a wrapper passes it to `Default`; `useBorderColor()` is the box's color)
   */
  prompt: ComponentType<{ prefix?: ReactNode }>;
  /** between the transcript and the prompt; empty by default (panels, todo lists) */
  aboveInput: ComponentType;
  /** the conversation; a fullscreen view (a browser, an inspector) replaces it */
  transcript: ComponentType;
}

/** A rich dialog for an `ask` kind; `Default` is the generic one (or an earlier plugin's for the kind). */
export type AskDialog = ComponentType<{ ask: AskEvent; Default: ComponentType<{ ask: AskEvent }> }>;

/** Default export of a plugin whose hortus.json depends on "@hortus/cli". */
export interface CliPlugin extends Plugin {
  /** each slot override gets the implementation it replaces as `Default`: the built-in one or an earlier plugin's */
  cli?: { [K in keyof Slots]?: ComponentType<{ Default: Slots[K] }> } & {
    /**
     * Renderers by entry kind, each wrapping the built-in or an earlier plugin's for that kind (its `Default`): `user`,
     * `assistant`, `thinking`, `info`, `warn`, `error`, a plugin message's `<plugin>:<type>`, a session plugin entry's
     * type (`session.appendEntry`: shown live and on resume, after the message written before it; `entry.data`), a
     * `cli.push`ed kind, `header` (the transcript's first row, on every session) (an `EntryRenderer`), and
     * `tool:<name>` / `tool:*` (the generic one, for tools without their own) / `tool:**` (over every tool's composed
     * renderer, the generic one's included) (a `ToolRenderer`). A plugin message or entry without a renderer isn't
     * shown.
     */
    entries?: Record<string, EntryRenderer | ToolRenderer>;
    /** `entries["tool:<name>"]`, by tool name (an MCP tool's is `mcp__<server>__<tool>`) */
    tools?: Record<string, ToolRenderer>;
    /** dialogs by `ask` kind; an ask without one (or with an unknown kind) gets the generic dialog */
    asks?: Record<string, AskDialog>;
    /**
     * themes by name, for `/theme` and config.json's `theme`; a later plugin's replaces one of the same name. Tokens
     * left out come from `dark` (roles: from their generic token, see `Theme`)
     */
    themes?: Record<string, Partial<Theme>>;
    /**
     * sees each key the built-in prompt gets before it does (later plugins first); returning true takes the key, so the
     * prompt (Enter, Esc's abort, Ctrl+C's clear, the `/` menu...) and plugins before it never see it. `ctx` is the
     * plugin's host ctx (its `ctx.state`)
     */
    keys?: (input: string, key: Key, cli: Cli, ctx: Ctx) => boolean | undefined;
    /**
     * wraps `cli.submit` (`Default`: the built-in one or an earlier plugin's), e.g. to send while a turn runs, which the
     * built-in refuses; returns whether the input was taken (the prompt then clears it). `ctx` is the plugin's host ctx
     */
    submit?: (value: string, Default: (value: string) => boolean, cli: Cli, ctx: Ctx) => boolean;
    /**
     * wraps the prompt menu's rows for `input` (`Default`: the `/` commands' rows), e.g. to add `@file` rows; `ctx` is
     * the plugin's host ctx
     */
    complete?: (
      input: string,
      Default: (input: string) => Suggestion[] | undefined,
      cli: Cli,
      ctx: Ctx,
    ) => Suggestion[] | undefined;
    /** once the TUI has started, with the plugin's host ctx */
    init?: (cli: Cli, ctx: Ctx) => void | Promise<void>;
  };
}

/** A piece (in-code plugin) of the CLI, like its `cli:*` commands. */
export interface CliPiece extends Omit<Piece, "plugin"> {
  plugin: CliPlugin;
}

/** The TUI behind `ctx` (a command's or handler's), for TUI-only commands; throws under other hosts. */
export function cliOf(ctx: Ctx): Cli {
  const cli = (ctx.host as { cli?: Cli }).cli;
  if (!cli) throw new Error("This only works in hortus's TUI");
  return cli;
}

export const CliContext = createContext<Cli | undefined>(undefined);
/** the host ctx of the plugin whose component is rendering (see `usePluginCtx`) */
export const PluginCtx = createContext<Ctx | undefined>(undefined);

/**
 * In a plugin's slot, entry/tool renderer or ask dialog: that plugin's host ctx, so it reads its per-agent `ctx.state`.
 * Re-rendering on a change is the plugin's: keep a store there (`createStore`, read with `useStore`).
 */
export function usePluginCtx(): Ctx {
  const ctx = useContext(PluginCtx);
  if (!ctx) throw new Error("usePluginCtx only works in a plugin's TUI component");
  return ctx;
}

function useCli() {
  const cli = useContext(CliContext);
  if (!cli) throw new Error("hortus's hooks only work inside its TUI");
  return cli;
}

/** Selectors must return primitives or existing references, or go through useShallow (zustand loops on a fresh object). */
export const useSession = <T>(selector: (s: SessionState) => T): T =>
  useStore(
    useUi((s) => s.session),
    selector,
  );
export const useUi = <T>(selector: (s: UiState) => T): T => useStore(useCli().ui, selector);
/** The prompt box's border color: the set effort's `thinking<Level>` token (auto: `border`), `borderIdle` while busy. */
export const useBorderColor = (): string => {
  const busy = useUi((s) => s.busy);
  const effort = useUi((s) => s.effort);
  useTheme();
  return borderColor(busy, effort);
};

/** See `useBorderColor`. */
export const borderColor = (busy: boolean, effort: string | undefined): string =>
  busy
    ? theme.borderIdle
    : effort
      ? (theme[`thinking${effort[0]?.toUpperCase()}${effort.slice(1)}`] ?? theme.border)
      : theme.border;

/** The current theme's tokens; the component re-renders when `/theme` switches it. */
export const useTheme = (): Theme => {
  useUi((s) => s.theme);
  return theme;
};
