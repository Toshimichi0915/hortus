# Phase 0 — test harness

Today nothing runs `createAgent().run()` end to end: `agent.test.ts` calls `runTool` only. Every later phase needs
whole-run tests, so this comes first.

## Changes

- `packages/core/src/testing.ts` (exported as `@hortus/core/testing`, so reference plugins and plugin authors can use
  it):
  - `scripted(turns)`: a `ProviderDef` whose `complete` returns the scripted turns in order (a turn is a
    `Partial<AssistantMessage>`, defaulting to no text and no tool calls, or a function of the request returning one),
    streams their text through `onText` (one delta per turn), throws once they run out, and records every request in
    `.requests` (`messages` copied as they were then). Register it from `extra`:
    `createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] })` (named since phase 1).
  - `tempHome(files?)`: points `HOME` at a fresh temp dir and writes `~/.hortus` from
    `{ config?, secrets?, mcp?, plugins? }`; returns an async cleanup (restores `HOME`, deletes the dir), meant for
    `t.after(await tempHome(…))`. `config`/`secrets` default to selecting the `scripted` provider type (provider
    `scripted`, model `scripted`), so a test only passes them to test something else. `plugins` maps a dir name to its
    files (`{ "hortus.json": …, "index.js": … }`) or to a directory to symlink there (a plugin on disk; linked, not
    copied, so its imports resolve from its real path to the same `@hortus/core` the test uses).
  - `record()`: an `extra` plugin that logs every event as `{ name, payload }` (a `structuredClone` of the payload,
    or the payload itself if it can't be cloned) in `.events`. Its `on` is a `Proxy`, so events added by later phases
    are recorded without changing it.
- **Deviation (production change):** `~/.hortus` was resolved once, at import (`HORTUS_DIR`, `PLUGINS_DIR`,
  `sessionsDir` constants), so pointing `HOME` elsewhere after importing core did nothing. It is now `hortusDir()`
  (and `sessionsDir()`), read from `HOME` on every call; `loadPlugins` defaults to `join(hortusDir(), "plugins")`.
- The actual event order of a tool-calling turn is `text… message tool_call… [tool_update…] message`: the assistant
  message is emitted before its tool calls (the plan had `tool_call` first).
- `biome.json` skips `pnpm-lock.yaml` (`pnpm format` used to rewrite it).

## Reference plugins (convention for every later phase)

Each reference plugin is a real directory plugin, built and tested by `pnpm build` / `pnpm test`:

```
examples/plugins/
  package.json          one private workspace package (@hortus/example-plugins) holding every plugin's deps:
                        @hortus/core, @hortus/cli, zod (add others here, then `pnpm install`)
  tsconfig.base.json    shared options; rootDir/outDir/include use ${configDir}, so they apply per plugin
  <name>/
    hortus.json         { "name": "<name>", "version": "0.1.0", "entrypoint": "dist/index.js", ... }
    tsconfig.json       { "extends": "../tsconfig.base.json", "references": [{ "path": "../../../packages/cli" }] }
    src/index.ts(x)     default export: the Plugin (imports `@hortus/core`, `@hortus/cli`, … by package name)
    src/*.test.ts(x)    loads the plugin through createAgent/loadPlugins with the harness
```

To try one in `pnpm dev`, build, then `ln -s` its directory into `~/.hortus/plugins/`; a copy breaks its dependency
resolution (deps resolve from `examples/plugins/node_modules`).

The root scripts build `packages/cli` and every `examples/plugins/*/tsconfig.json`, and test
`packages/*/dist/**/*.test.js` and `examples/plugins/*/dist/**/*.test.js`, so a new plugin needs no script or
workspace change. Its test loads it as hortus would load `~/.hortus/plugins/<name>`:

```ts
t.after(await tempHome({ plugins: { hello: fileURLToPath(new URL("..", import.meta.url)) } }));
const provider = scripted([...]);
const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
```

`examples/plugins/hello` is the template (a tool and a line of system prompt).

## Verification

- [x] **T** `core/src/agent.test.ts`: with `scripted`, a run where the model calls `read`, gets the result, then
  answers — asserts the messages, that the second request contains the tool result, and the `record()` event
  order (`skills session_start text message tool_call message text message`).
- [x] **T** `tempHome` leaves the real `~/.hortus` untouched (assert its mtime before/after).
- [x] **T** a test loads a plugin dir written by `tempHome` through `createAgent` (the path later reference plugins use).
- [x] **R** `examples/plugins/hello`: loaded from its own dir (linked by `tempHome`) through `createAgent`; its prompt
  line reaches the request and its `hello` tool runs.
