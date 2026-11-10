import type { Plugin, SessionState } from "@hortus/core";
import { type ComponentType, createContext, useContext } from "react";
import { useStore } from "zustand";
import type { Cli, UiState } from "./cli.ts";
import type { Command } from "./commands.ts";
import type { ToolRenderer } from "./tools.tsx";

export type { SessionState } from "@hortus/core";
export { useShallow } from "zustand/react/shallow";
export type { Cli, UiState } from "./cli.ts";
export type { Candidate, Command } from "./commands.ts";
export { theme, usageLine } from "./entry.ts";
export type { Span } from "./markdown.ts";
export { linesRenderer, type ToolBlock, type ToolRenderer, type ToolView } from "./tools.tsx";

/** UI parts a plugin can replace. */
export interface Slots {
  statusBar: ComponentType;
}

/** Default export of a plugin whose hortus.json depends on "@hortus/cli". */
export interface CliPlugin extends Plugin {
  /** each slot override gets the implementation it replaces as `Default`: the built-in one or an earlier plugin's */
  cli?: { [K in keyof Slots]?: ComponentType<{ Default: Slots[K] }> } & {
    /** added to the `/` menu; one named like an earlier command (built-in or plugin) replaces it */
    commands?: Command[];
    /**
     * tool call blocks by tool name (an MCP tool's is `mcp__<server>__<tool>`), wrapping the built-in or an earlier
     * plugin's renderer for that name, which each gets as `Default`; the generic one draws tools without any
     */
    tools?: Record<string, ToolRenderer>;
  };
}

export const CliContext = createContext<Cli | undefined>(undefined);

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
