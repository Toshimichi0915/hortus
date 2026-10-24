import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import * as z from "zod";
import { builtin } from "./builtin.ts";
import { PHI_DIR } from "./config.ts";
import type { Events, Plugin, ProviderDef, Tool } from "./llm.ts";

export const PLUGINS_DIR = join(PHI_DIR, "plugins");

/** plugin name -> npm-style version range, e.g. `{ "foo": "^1.2.0" }` */
const Dependencies = z.record(
  z.string(),
  z.string().refine((r) => semver.validRange(r) !== null, "invalid version range"),
);

/** `<plugin dir>/phi.json`. Dependencies load before (so are overridden by) this plugin. */
export const ManifestSchema = z.object({
  name: z.string(),
  version: z.string().refine((v) => semver.valid(v) !== null, "invalid semver version"),
  /** module path, relative to the plugin's directory */
  entrypoint: z.string(),
  dependencies: Dependencies.optional(),
  optionalDependencies: Dependencies.optional(),
});
export interface Manifest extends z.infer<typeof ManifestSchema> {
  dir: string;
}

/** Every `<dir>/<name>/phi.json`; directories without one are skipped. */
async function readManifests(dir: string): Promise<Manifest[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const manifests = await Promise.all(
    names.sort().map(async (name): Promise<Manifest | undefined> => {
      const path = join(dir, name, "phi.json");
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (e) {
        if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) return undefined;
        throw e;
      }
      try {
        return { ...ManifestSchema.parse(JSON.parse(text)), dir: join(dir, name) };
      } catch (e) {
        throw new Error(`Invalid ${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
  return manifests.filter((m) => m !== undefined);
}

/**
 * Dependencies first. Missing optional dependencies are ignored; missing required ones, version mismatches (optional
 * included) and cycles throw.
 */
export function sortManifests(manifests: Manifest[]): Manifest[] {
  const byName = new Map<string, Manifest>();
  for (const m of manifests) {
    const dup = byName.get(m.name);
    if (dup) throw new Error(`Duplicate plugin ${m.name} in ${dup.dir} and ${m.dir}`);
    byName.set(m.name, m);
  }
  const sorted: Manifest[] = [];
  const done = new Set<string>();
  const visit = (m: Manifest, chain: string[]) => {
    if (done.has(m.name)) return;
    if (chain.includes(m.name)) throw new Error(`Plugin dependency cycle: ${[...chain, m.name].join(" -> ")}`);
    const deps = [
      ...Object.entries(m.dependencies ?? {}).map(([name, range]) => ({ name, range, optional: false })),
      ...Object.entries(m.optionalDependencies ?? {}).map(([name, range]) => ({ name, range, optional: true })),
    ];
    for (const { name, range, optional } of deps) {
      const d = byName.get(name);
      if (!d) {
        if (optional) continue;
        throw new Error(`Plugin ${m.name} requires missing plugin ${name}@${range}`);
      }
      if (!semver.satisfies(d.version, range)) {
        throw new Error(`Plugin ${m.name} requires ${name}@${range}, found ${d.version}`);
      }
      visit(d, [...chain, m.name]);
    }
    done.add(m.name);
    sorted.push(m);
  };
  for (const m of manifests) visit(m, []);
  return sorted;
}

/**
 * Built-ins, every plugin in `dir` (dependencies first), then `extra`. Later plugins override same-named providers
 * and tools; `emit` runs every plugin's handler in that order.
 */
export async function loadPlugins(dir = PLUGINS_DIR, extra: Plugin[] = []) {
  const manifests = sortManifests(await readManifests(dir));
  const loaded = await Promise.all(
    manifests.map(async (m): Promise<Plugin> => {
      try {
        return (await import(pathToFileURL(resolve(m.dir, m.entrypoint)).href)).default;
      } catch (e) {
        throw new Error(`Failed to load plugin ${m.name}: ${e instanceof Error ? e.message : String(e)}`);
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
