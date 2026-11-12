import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import * as z from "zod";
import { hortusDir } from "./config.ts";
import type { Ctx, Host, Plugin, ProviderDef, ProviderWrap, RunEnd, RunOptions, Tool, ToolWrap } from "./llm.ts";
import type { Session } from "./session.ts";

/** @hortus/core's version, which its built-in pieces carry. */
export const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** plugin name -> npm-style version range, e.g. `{ "foo": "^1.2.0" }` */
const Dependencies = z.record(
  z.string(),
  z.string().refine((r) => semver.validRange(r) !== null, "invalid version range"),
);

/** `<plugin dir>/hortus.json`. Dependencies load before (so are wrapped by) this plugin. */
export const ManifestSchema = z.object({
  name: z.string(),
  version: z.string().refine((v) => semver.valid(v) !== null, "invalid semver version"),
  /** module path, relative to the plugin's directory */
  entrypoint: z.string(),
  dependencies: Dependencies.optional(),
  optionalDependencies: Dependencies.optional(),
  /** plugins this one stands in for: they aren't loaded, and dependencies on them are satisfied by this one */
  replaces: z.array(z.string()).optional(),
  /**
   * "last": load after every plugin without it (before `extra`), e.g. to see the final `request.tools`; its own
   * dependencies, and plugins depending on it, still load in dependency order
   */
  order: z.enum(["last"]).optional(),
  /**
   * a policy plugin (a gate): subrun filters (`plugins.only`/`disable`) and `LoadOptions.only` (`--only`) can't leave it
   * out; only the user's `disabledPlugins` / `LoadOptions.disabled` (`--disable`) remove it
   */
  required: z.boolean().optional(),
});
export interface Manifest extends z.infer<typeof ManifestSchema> {
  dir: string;
}

/** A plugin defined in code, with a manifest like a directory plugin's: the built-in pieces, or a host's (`pieces`). */
export interface Piece extends Omit<z.infer<typeof ManifestSchema>, "entrypoint"> {
  plugin: Plugin;
}

/** A loaded plugin and its name. */
export interface Named {
  name: string;
  plugin: Plugin;
  /** the plugins it stands in for: its `replaces`, plus theirs when it replaces a replacer */
  replaces?: string[];
  /** its manifest's `required`: filters can't leave it out */
  required?: boolean;
  /** a piece (defined in code), not a directory plugin or `extra` */
  builtin?: boolean;
}

/** Whether `name` is one of `names`; a name ending in `*` matches by prefix (`builtin:*`). */
const matches = (name: string, names: readonly string[]) =>
  names.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));

/** Whether `n` is one of `names` (`prefix*` patterns too), by its name or one it `replaces`. */
export const isNamed = (n: Pick<Named, "name" | "replaces">, names: readonly string[]) =>
  [n.name, ...(n.replaces ?? [])].some((x) => matches(x, names));

/** filtered-out plugins' stand-ins: providers only, no handlers or tools */
const providersOnlySet = new WeakSet<Named>();
/** `n` filtered out: its providers (and provider wraps) only, which are never filtered; none if it has no providers. */
export function providersOnly(n: Named): Named[] {
  if (!n.plugin.providers) return [];
  const kept = { ...n, plugin: { providers: n.plugin.providers } };
  providersOnlySet.add(kept);
  return [kept];
}
/** Whether `n` takes part (handlers and tools), rather than standing in with its providers only. */
export const takesPart = (n: Named) => !providersOnlySet.has(n);

/** Options shared by everything that loads plugins (`loadPlugins`, `createAgent`). */
export interface LoadOptions {
  /** names the host provides itself, e.g. `{ "@hortus/cli": "0.1.0" }`; plugins depend on them like on any plugin */
  provided?: Record<string, string>;
  /** the host's own pieces (the CLI's commands), loaded like built-ins: before directory plugins, disableable */
  pieces?: Piece[];
  /** loaded after every plugin, e.g. a caller observing a run */
  extra?: Named[];
  /** plugins not to load (`prefix*` matches by prefix, as in `config.disabledPlugins`), on top of `config.disabledPlugins` */
  disabled?: string[];
  /**
   * the only plugins taking part (by name, or a name one `replaces`; `prefix*` matches by prefix), as a subrun's
   * `plugins.only`: the others keep only their providers; `extra` and `required` ones all take part
   */
  only?: string[];
  /**
   * a plugin's tool or provider that was skipped (a plain one named like an earlier one, or a wrap of nothing), or a
   * handler that threw (reported and skipped; a `tool_call` one also blocks the call). Default: throw
   */
  onError?: (plugin: string, error: Error) => void;
  /** every request the agent makes or hands out (provider `create`/`auth`, `ctx.fetch`); default the global one */
  fetch?: typeof globalThis.fetch;
  /**
   * how the host starts a run a `send` asks for on `session`: it calls `start` (with its own options, e.g. a signal;
   * the send's model/provider/effort win) when it is ready, e.g. after its running turn. Default: started at once
   */
  onWake?: (start: (opts?: RunOptions) => Promise<RunEnd | undefined>, session: Session) => void;
  /** `ctx.host` (default `{ kind: "headless", interactive: false }`) */
  host?: Host;
  /**
   * a session id this agent runs under (`hortus --parent`): its top-level runs are that session's children
   * (`ctx.run.depth` one more than its, `parent.session` it, `root` its tree's root; see `sessionLineage`)
   */
  parent?: string;
  /** how the host shuts down on `ctx.exit()` (it should end with `agent.close()`); default: `agent.close()` */
  onExit?: () => void;
}

/** Every `<dir>/<name>/hortus.json`; directories without one are skipped. */
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
      const path = join(dir, name, "hortus.json");
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

const where = (m: Manifest | Piece) => ("dir" in m ? m.dir : "hortus");

/**
 * The plugins to load, dependencies first, `order: "last"` ones after the others. `disabled` ones and those another `replaces` are left out; a dependency on a
 * replaced one is satisfied by its replacer, unchecked. A replacer that is replaced itself passes what it replaces on to
 * its replacer, so each returned manifest's `replaces` lists every name it stands in for. `provided` names satisfy
 * dependencies (version-checked) without being loaded. Missing optional dependencies are ignored; missing (or disabled)
 * required ones, version mismatches (optional included), two loaded replacers of one name and cycles throw.
 */
export function sortManifests<M extends Manifest | Piece>(
  manifests: M[],
  provided: Record<string, string> = {},
  disabled: string[] = [],
): M[] {
  const byName = new Map<string, M>();
  for (const m of manifests) {
    const dup = byName.get(m.name);
    if (dup) throw new Error(`Duplicate plugin ${m.name} in ${where(dup)} and ${where(m)}`);
    if (Object.hasOwn(provided, m.name))
      throw new Error(`Duplicate plugin ${m.name} in ${where(m)}: hortus provides it`);
    if (!matches(m.name, disabled)) byName.set(m.name, m);
  }
  // name -> the plugins replacing it directly; one replaced itself passes it on to its own replacer
  const replacers = new Map<string, M[]>();
  for (const m of byName.values())
    for (const name of m.replaces ?? []) replacers.set(name, [...(replacers.get(name) ?? []), m]);
  /** The loaded plugin standing in for `name`, following replacers of replacers; undefined if nothing replaces it. */
  const standIn = (name: string, chain: string[] = []): M | undefined => {
    if (chain.includes(name)) throw new Error(`Plugin replacement cycle: ${[...chain, name].join(" -> ")}`);
    const found = [...new Set((replacers.get(name) ?? []).map((r) => standIn(r.name, [...chain, name]) ?? r))];
    const [a, b] = found;
    if (a && b)
      throw new Error(`Plugins ${a.name} and ${b.name} both replace ${name}; disable one of them with disabledPlugins`);
    return a;
  };
  const replacedBy = new Map<string, M>();
  for (const name of replacers.keys()) replacedBy.set(name, standIn(name) as M);
  // a replacer of a required plugin is required too: it can't drop out of subruns the one it stands in for wouldn't
  const required = new Set([...replacedBy.keys()].filter((name) => byName.get(name)?.required));
  for (const name of replacedBy.keys()) byName.delete(name);
  const sorted: M[] = [];
  const done = new Set<string>();
  const visit = (m: M, chain: string[]) => {
    if (done.has(m.name)) return;
    if (chain.includes(m.name)) throw new Error(`Plugin dependency cycle: ${[...chain, m.name].join(" -> ")}`);
    const deps = [
      ...Object.entries(m.dependencies ?? {}).map(([name, range]) => ({ name, range, optional: false })),
      ...Object.entries(m.optionalDependencies ?? {}).map(([name, range]) => ({ name, range, optional: true })),
    ];
    for (const { name, range, optional } of deps) {
      const replacer = replacedBy.get(name);
      if (replacer) {
        visit(replacer, [...chain, m.name]);
        continue;
      }
      const d = byName.get(name);
      // hasOwn, so a dependency named like an Object.prototype key isn't "provided"
      const version = d?.version ?? (Object.hasOwn(provided, name) ? provided[name] : undefined);
      if (version === undefined) {
        if (optional) continue;
        if (matches(name, disabled))
          throw new Error(`Plugin ${m.name} requires ${name}, which disabledPlugins disables; disable ${m.name} too`);
        throw new Error(`Plugin ${m.name} requires missing plugin ${name}@${range}`);
      }
      if (!semver.satisfies(version, range)) {
        throw new Error(`Plugin ${m.name} requires ${name}@${range}, found ${version}`);
      }
      if (d) visit(d, [...chain, m.name]);
    }
    done.add(m.name);
    sorted.push(m);
  };
  // the "last" ones after the rest, unless a dependency pulled them earlier
  for (const m of byName.values()) if (m.order !== "last") visit(m, []);
  for (const m of byName.values()) visit(m, []);
  return sorted.map((m) => {
    const replaces = [...replacedBy].filter(([, r]) => r === m).map(([name]) => name);
    if (!replaces.length) return m;
    return { ...m, replaces, ...(replaces.some((name) => required.has(name)) && { required: true }) };
  });
}

/**
 * Built-in pieces and `pieces`, every plugin in `dir` (dependencies first), then `extra`, merged by `mergePlugins`.
 * `plugins` lists them in that order, for hosts that read keys of their own (the CLI's `cli`).
 */
export async function loadPlugins(dir = join(hortusDir(), "plugins"), opts: LoadOptions = {}) {
  const plugins = await loadNamed(dir, opts);
  return { ...mergePlugins(plugins, opts.onError), plugins };
}

/** `loadPlugins` without the merge: the plugins taking part, in load order (`createAgent` merges them itself). */
export async function loadNamed(dir = join(hortusDir(), "plugins"), opts: LoadOptions = {}): Promise<Named[]> {
  const { provided, pieces = [], extra = [], disabled } = opts;
  // imported here, not at the top: the pieces import this package's index, which imports this module
  const { builtins } = await import("./builtin/index.ts");
  const manifests = sortManifests<Manifest | Piece>(
    [...builtins, ...pieces, ...(await readManifests(dir))],
    provided,
    disabled,
  );
  const loaded = await Promise.all(
    manifests.map(async (m): Promise<Named> => {
      const replaces = { ...(m.replaces && { replaces: m.replaces }), ...(m.required && { required: true }) };
      if ("plugin" in m) return { name: m.name, plugin: m.plugin, builtin: true, ...replaces };
      try {
        const plugin = (await import(pathToFileURL(resolve(m.dir, m.entrypoint)).href)).default;
        return { name: m.name, plugin, ...replaces };
      } catch (e) {
        throw new Error(`Failed to load plugin ${m.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
  const only = opts.only;
  const kept = only ? loaded.flatMap((n) => (n.required || isNamed(n, only) ? [n] : providersOnly(n))) : loaded;
  return [...kept, ...extra];
}

/**
 * Tools and providers of `plugins`, merged in order: a wrap layers over the same-named one so far, a plain duplicate is
 * reported to `onError` (default: throw) and skipped; `"*"` provider wraps then wrap every type, outermost
 * (`innerProviders` are the defs without them, what a routing provider delegates to). Each tool gets `plugin`: the one
 * that provided or last wrapped it. Callable again on a subset (each wrap is applied anew). A provider wrap gets
 * `ctxOf(<its plugin>)` (the agent passes each plugin's host ctx; default none).
 */
export function mergePlugins(
  plugins: Named[],
  onError: (plugin: string, error: Error) => void = (_, e) => {
    throw e;
  },
  ctxOf: (plugin: string) => Ctx = () => undefined as unknown as Ctx,
) {
  const providers = new Map<string, { def: ProviderDef; by: string }>();
  const everyProvider: { wrap: ProviderWrap; by: string }[] = [];
  const tools = new Map<string, { def: Tool; by: string }>();
  // the same rules for both: a wrap needs an earlier def, a plain def must be the first; `stamp` marks what was added
  const add = <D>(
    map: Map<string, { def: D; by: string }>,
    kind: string,
    key: string,
    def: D | { wrap(d: D, ctx: Ctx): D; optional?: boolean },
    by: string,
    stamp: (d: D, by: string) => D = (d) => d,
  ) => {
    const prev = map.get(key);
    if (def && typeof def === "object" && "wrap" in def) {
      // `by` (and a tool's `plugin`) stay the provider's: a conflict names the plugin to replace, and the wrapped
      // original keeps its own ctx.state; a wrapper keeps its own by closure
      if (prev) map.set(key, { def: stamp(def.wrap(prev.def, ctxOf(by)), prev.by), by: prev.by });
      else if (!def.optional)
        onError(by, new Error(`Plugin ${by} wraps ${kind} ${key}, which no earlier plugin provides`));
    } else if (prev)
      onError(
        by,
        new Error(
          `Plugin ${by} provides ${kind} ${key}, which ${prev.by} already does; wrap it, or replace ${prev.by}`,
        ),
      );
    else map.set(key, { def: stamp(def as D, by), by });
  };
  for (const { name, plugin } of plugins) {
    for (const [type, def] of Object.entries(plugin.providers ?? {})) {
      if (type !== "*") add(providers, "provider", type, def, name);
      else if ("wrap" in def) everyProvider.push({ wrap: def, by: name });
      else onError(name, new Error(`Plugin ${name}'s "*" provider must be a wrap`));
    }
    for (const t of plugin.tools ?? [])
      add<Tool>(tools, "tool", t.name, t as Tool | ToolWrap, name, (d, by) => ({ ...d, plugin: by }));
  }
  const innerProviders = Object.fromEntries([...providers].map(([type, { def }]) => [type, def]));
  const providerDefs = Object.fromEntries(
    Object.entries(innerProviders).map(([type, def]) => [
      type,
      everyProvider.reduce((d, w) => w.wrap.wrap(d, ctxOf(w.by)), def),
    ]),
  );
  return { providers: providerDefs, innerProviders, tools: [...tools.values()].map((t) => t.def) };
}
