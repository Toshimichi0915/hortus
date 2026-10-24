import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { builtin } from "./builtin.ts";
import { loadConfig, PHI_DIR } from "./config.ts";
import type { Events, Plugin, ProviderDef, Tool } from "./llm.ts";

/**
 * Built-ins, every plugin in `specs` (default: config.plugins), then `extra`. Later plugins override same-named
 * providers and tools; `emit` runs every plugin's handler in that order.
 */
export async function loadPlugins(specs?: string[], extra: Plugin[] = []) {
  specs ??= (await loadConfig()).plugins ?? [];
  // ponytail: paths only (relative to ~/.phi); npm package names need resolving from ~/.phi/node_modules
  const loaded = await Promise.all(
    specs.map(async (spec): Promise<Plugin> => {
      try {
        return (await import(pathToFileURL(resolve(PHI_DIR, spec)).href)).default;
      } catch (e) {
        throw new Error(`Failed to load plugin ${spec}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
  const plugins = [builtin, ...loaded, ...extra];
  const providers: Record<string, ProviderDef> = Object.assign({}, ...plugins.map((p) => p.providers));
  // later plugins win, so a tool can be replaced by name
  const tools = new Map<string, Tool>(plugins.flatMap((p) => (p.tools ?? []).map((t) => [t.name, t])));
  const emit = async <E extends keyof Events>(event: E, payload: Events[E]) => {
    for (const p of plugins) await p.on?.[event]?.(payload);
  };
  return { providers, tools: [...tools.values()], emit };
}
