# Phase 1 — named pieces, `replaces`, wrapping, credentials

## Changes

**Pieces.** `builtin.ts` becomes `packages/core/src/builtin/*.ts`, one in-code manifest each
(`{ name, version: <hortus version>, dependencies?, plugin }`), loaded through the same `sortManifests` as directory
plugins:

| Piece                                                           | Contents                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `builtin:prompt`                                                | base system prompt (cwd, role) + AGENTS.md                                                |
| `builtin:skills`                                                | skill discovery (`skills` event) + `<available_skills>` prompt; depends on `builtin:read` |
| `builtin:read`, `builtin:write`, `builtin:edit`, `builtin:bash` | one tool each, plus any prompt text about it                                              |
| `builtin:anthropic`                                             | the `anthropic` provider                                                                  |
| `builtin:openai`                                                | `openai` and `openai-responses`                                                           |

Each piece contributes its own prompt text, so removing it removes every mention of it. (Until phase 2 adds the
`prompt` event, pieces push into `session_start.system`.)

**Names everywhere.** `LoadOptions.extra` becomes `{ name, plugin }[]`; `loadPlugins` returns `plugins` as
`{ name, plugin }[]`.

**`replaces`.** `hortus.json` gains `replaces?: string[]`. Replaced plugins aren't loaded; dependencies on them are
satisfied by the replacer without a version check. Two loaded plugins replacing one name → load error whose message
names both and suggests `disabledPlugins`. Replacing an absent name is ignored.

**`disabledPlugins`.** `config.json` gains `disabledPlugins?: string[]` (built-in and directory names). Disabled
plugins aren't loaded; a required dependency on one → load error naming both; optional → skipped.

**Wrapping.** A tool or provider def may carry `wrap(Default)` instead of being a plain def: it receives the
same-named def from earlier plugins (load order) and returns the new one. A plain same-named def is a conflict:
reported through `LoadOptions.onError(plugin, error)` and the later one skipped. hortus no longer starts with a silent
override. A provider wrap with `name: "*"` wraps every provider type (including types loaded later), outermost —
for plugins that adjust any provider's traffic (prompt-cache optimizers).

**Provider plumbing.** `ProviderDef.create(entry, { name, headers?, fetch? })`; the built-in factories pass `headers`
and `fetch` to the SDKs (`defaultHeaders`, `fetch`). Per-call values (session headers, cache keys) come from the `ctx`
that `complete` receives from phase 2 on. `Provider.contextWindow`/`efforts` fold into
`Provider.info?(model) → { contextWindow?, maxOutput?, efforts?, images? }`; the built-in providers use `maxOutput`
instead of a hardcoded `max_tokens`. `Usage.cost?` is filled by providers (or wrappers) that know their prices.
Anthropic `raw` is keyed by endpoint and model like `openai-responses`, so proxied and direct Anthropic never replay
each other's thinking blocks.

**Credentials.** `secrets.json` entries become loose objects: `type` required, `apiKey`/`endpoint` optional, unknown
fields kept by `loadSecrets`/`saveSecrets`. `create` gets the whole entry. `ProviderDef.auth?(entry, { refresh })`
returns a fresh entry (OAuth refresh) and is the one refresh path: provider calls use it, and so does
`ctx.secrets.get(name, { refresh? })` for non-provider plugins that reuse a login (web search over a Codex login).
`ctx.secrets.update(name, fn)` re-reads, applies `fn` and writes atomically under a file lock (mode 0600), so parallel
hortus processes (headless children) never lose a rotated refresh token; login commands and `auth` both use it. (`ctx` arrives in phase 2; until then these are
`agent.secrets`, which tools get as `ToolContext.secrets`.) String fields expand `${VAR}` like `mcp.json` (vault tools
feed keys through the environment).

**CLI.** Built-in commands become CLI pieces (`cli:new`, `cli:model`, `cli:effort`, `cli:resume`), disableable the same
way. Load conflicts reported through `onError` show as error lines. Tool renderers stay keyed by tool name.

**As built (deviations and details the plan left open).**
- Phase 8 added the piece `builtin:name` (`/name <title>`, see phase 8's As built), loaded last of the built-ins.
- Pieces import only `../index.ts`, which (through `plugins.ts`) would import them back; so `loadPlugins` imports
  `builtin/index.ts` dynamically, once the index has loaded. The tools stay in `tools.ts`, now exported from the index
  (`readTool`, …, `truncate`, `applyEdits`), so `builtin/read.ts` etc. are one line each. Load order of the pieces:
  `prompt, read, skills, write, edit, bash, anthropic, openai` (`skills` after its dependency). The tool pieces carry no
  prompt text: there was none to move.
- `LoadOptions` also gained `pieces` (a host's own in-code pieces, sorted with the built-ins before directory plugins;
  how the CLI's `cli:*` load, passed by `index.tsx`) and `disabled` (added to `config.disabledPlugins`; for hosts and
  later `--disable`). `Piece` is the in-code manifest type (`CliPiece` in `@hortus/cli` narrows its plugin to
  `CliPlugin`); both packages export `version`, which their pieces carry. `onError` defaults to throwing, so a host
  that doesn't pass one still never gets a silent override. A wrap with nothing to wrap is reported the same way.
- `createCli(session, makeAgent)`: `makeAgent` now gets `LoadOptions` (`extra: [{ name: "@hortus/cli", plugin:
  observer }]`, `onError`) instead of the bare observer.
- Credentials: `agent.secrets.get` passes the entry _as stored_ to `auth` (so what it returns is saved without expanded
  `${VAR}`s) and expands the result; `create` gets the expanded entry. `updateSecret(name, fn)` and `withFileLock(path,
  fn)` are exported module functions (`agent.secrets.update` is the former). The lock is a `<path>.lock` file created
  with `O_EXCL`, holding `<pid> <uuid>`: stale only once that pid has exited (a slow holder keeps it however long), or
  when it is this process's pid with a token no call in this process holds or waits with (a reused pid, e.g. 1 in each
  container); broken by one waiter at a time (under `<path>.lock.break`), and each holder removes only its own. A
  waiter gives up after `timeout` (option, default 60s) with an error naming the lock and holder pid, leaving the lock. It also serializes
  callers within one process, re-entrantly: a call from inside `fn`'s async context while the lock is still held
  (an `update` fn or `auth` reaching `agent.secrets`) runs at once instead of waiting on itself, and `updateSecret`
  re-reads the file before saving so such nested changes survive. It is for files under `~/.hortus` only: phase 2's tool lock for `write`/`edit` is a
  separate in-process per-path lock (a lockfile next to project files would pollute the project and outlive a crash).
  `saveSecrets` writes a temp file and renames it.
- The built-in provider defs pass every option their SDK would read from the environment: the key, `baseURL`
  (`endpoint ?? null`, null being the SDK default) and, for OpenAI, `organization`/`project`/`adminAPIKey: null`. A
  keyless entry (Ollama, LM Studio, a keyless LiteLLM proxy) gets a placeholder key with `authorization: null` in the
  headers (a key in `create`'s `headers` still wins), which also keeps Anthropic off its credential chain. Not
  closable: `ANTHROPIC_CUSTOM_HEADERS`/`OPENAI_CUSTOM_HEADERS` and the log-level vars.
- `auth` runs once per run, when `resolve` reads the entry through `agent.secrets.get`, not before every provider
  call; a token that can expire mid-run is the provider's to refresh, in its `fetch`, through `CreateOptions.auth`
  (`oauth-wrap` and `anthropic-auth` do).
- `info`: Anthropic retrieves the model once per provider instance (one per run; a failed lookup is kept as `{}`, not
  retried every turn), using it when the request has no `maxTokens` and falling back to `max_tokens: 64000` where the
  endpoint doesn't report it; `openai`/`openai-responses` report only `contextWindow` (OpenRouter's
  `context_length`) and still send no output limit (they never had a hardcoded one). Old sessions' Anthropic `raw`
  (keyed just `"anthropic"`) is no longer replayed; those turns are rebuilt from text and tool calls.
- `Usage.cost` totals show in the CLI's usage line (`$0.123`) when any reply has one.
- `@hortus/cli/testing` exports `composeSlots`/`composeTools`, so a plugin's renderer test can compose it over the
  built-ins (`restyle-read` uses it). `examples/plugins` now also depends on `ink` and `react` (same versions as the CLI,
  so the same module instances).
- `replaces` chains: a replacer that is itself replaced passes what it replaces on, so with `my-read` replacing
  `builtin:read` and `better-read` replacing `my-read`, only `better-read` loads and dependencies on either reach it;
  replacers that are themselves replaced don't count as a second replacer; a replacement cycle throws. `Named` (and
  `loadPlugins`' `plugins`) carries `replaces`: every name the plugin stands in for, chains included (phase 3's entry
  prefixes). The merge of tools, providers and `emit` is `mergePlugins(named[], onError?)`, exported, so phase 6 can
  merge a filtered plugin list anew (dropping a wrapper peels its wrap) instead of reusing the load-time defs.
- After porting three Pi packages (`anthropic-auth`, `litellm`, `web` under `examples/plugins/`), the API gained what
  their workarounds stood in for (items A–H below):
  - A. `LoadOptions.fetch` (default the global `fetch`) is what the agent passes to `create` (`CreateOptions.fetch`),
    to `auth` (`auth(entry, { refresh, fetch })`), to tools (`ToolContext.fetch`) and exposes as `agent.fetch` (for
    commands), so a whole-run test stubs every request without touching the global.
  - B. `CreateOptions.auth(opts?)` is `agent.secrets.get(name, opts)`: a provider refreshing mid-run (in its `fetch`)
    re-reads the entry under the lock through the same `auth`, instead of calling `updateSecret` with its own refresh.
  - C. `CompletionRequest.maxTokens`: the agent sets it once per run from the provider's `info(model).maxOutput` (a
    throwing `info` counts as none; cached per `<provider>/<model>` for the agent's life, as the OpenAI providers'
    `info` pages the whole model list, hundreds of KB on OpenRouter), so a routing wrapper's limit reaches the provider it delegates to; Anthropic uses
    it before its own model lookup. `openai`/`openai-responses` ignore it (they send no output limit).
  - D. `CreateOptions.providers`: the merged defs _without_ `"*"` wraps (`mergePlugins` returns them as
    `innerProviders`), so a routing provider delegates with `providers.anthropic.create(...)`, other plugins' named
    wraps apply, and a `"*"` wrap (already around the router) isn't applied a second time.
  - E. `expandSecret` expands `${VAR}` in nested strings (objects, arrays) too.
  - F. Tools get `ToolContext.secrets` (= `agent.secrets`) and `fetch`; `runTool(tools, call, ctx, codemodeOnly?)`
    takes the whole context (codemode passes its own to the tools a script calls). Phase 2 folds both into `ctx`.
  - G. `secrets.find(type)` → `{ name, entry }[]`, expanded but not through `auth` (`get` the name for a fresh one).
    The store's type is `SecretStore`.
  - H. An entry whose `type` no provider has (`brave`, `exa`, ...) is a credential for plugins: model listing and
    resolution ignore it.
  - Recorded for later phases instead: testing a command without a `Cli` (phase 4), response headers in
    `response.meta` (phase 2), payload rewriting stays in a wrapped `fetch` (README non-goals).
- **Final round (S1/N1, A1):** manifest (and `Piece`/`Named`) `required: true` marks a policy plugin: subrun filters
  (`plugins.only`/`disable`) and `LoadOptions.only` (`--only`) keep it whole (handlers and tools); only the user's
  `disabledPlugins`/`LoadOptions.disabled` (`--disable`) remove it. guard, safety-net and permission-system are
  required; permission-system's `"*"` provider wrap refusing runs it wasn't part of (and its module `gated` set) is
  gone. `only`/`disable` names ending in `*` match by prefix (`builtin:*`, `cli:*`; `isNamed`), and `ctx.plugins()`
  lists the plugins taking part where the ctx is (`{ name, builtin, required, replaces? }`; `builtin`: a piece);
  pi-subagents' hard-coded built-in list is `builtin:*` now. A filtered-out plugin's providers-only stand-in comes from
  `providersOnly(n)` (and `takesPart(n)` tells it apart). `loadNamed` loads without merging (see phase 2's final round:
  provider wraps get their plugin's ctx).
- Done beyond the checklist: the README's "every built-in can be removed" check for core pieces (`plugins.test.ts`
  disables each in turn), and the `grep` check of `packages/*/src/builtin/` holds.

## Verification

- [x] **T** (final) `required`: a directory plugin's `tool_gate` blocks a probe in `only` and `disable` subruns and
  under `LoadOptions.only`, and doesn't without the flag; `disabled` removes it (`gates.test.ts`); guard's (a probe
  write), safety-net's (`shred --version` behind a recorder) and permission-system's (a probe write) own tests fail
  with `required` removed from their manifests. `ctx.plugins()` and `only: ["builtin:*"]` (`gates.test.ts`).

- [x] **T** `plugins.test.ts`: the default load has exactly the pieces in the table, in dependency order.
- [x] **T** `disabledPlugins: ["builtin:edit"]` → no `edit` tool, no prompt text mentioning `edit` (assert the system
  prompt), agent runs.
- [x] **T** `disabledPlugins: ["builtin:read"]` → load error naming `builtin:skills`; adding `builtin:skills` too loads.
- [x] **T** a plugin with `replaces: ["builtin:read"]` and its own `read` → its tool is used; `builtin:skills` still
  loads (dependency satisfied by the replacer).
- [x] **T** two plugins replacing `builtin:read` → load error mentioning both names and `disabledPlugins`.
- [x] **T** a plain duplicate tool name and a plain duplicate provider name → `onError` called once each, the earlier
  def kept, the agent loads.
- [x] **T** two plugins each `wrap` `anthropic` → `create` of the outer calls the inner, which calls the built-in
  (order asserted); same for a wrapped tool.
- [x] **T** `providers/*.test.ts`: `headers` and `fetch` given to `create` reach the SDK (a fake `fetch` sees the
  header on a request).
- [x] **T** `secrets` round-trip keeps unknown fields and accepts an entry without `apiKey`.
- [x] **T** `secrets.get(name, { refresh: true })` calls the owning provider's `auth` and saves the result (mode 0600);
  a run with an expired entry goes through the same `auth` (once, when it resolves the provider).
- [x] **T** two processes calling `secrets.update` on different entries concurrently → both changes survive.
- [x] **T** a `"*"` provider wrap applies to a provider type registered by a later plugin, outermost.
- [x] **T** `info(model).maxOutput` sets the built-in providers' `max_tokens`; `Usage.cost` from a wrapper reaches the
  totals.
- [x] **T** Anthropic `raw` from one endpoint isn't replayed to another endpoint.
- [x] **T** `Provider.info` replaces `contextWindow`/`efforts`; the CLI status line still shows the window (existing
  `cli.test.ts` updated).
- [x] **T** CLI: `disabledPlugins: ["cli:effort"]` removes `/effort` from the `/` menu.
- [x] **R** `oauth-wrap`: refreshes an expired token from a loose secrets field inside `fetch`, saves it, and the
  wrapped (real) `anthropic` provider, given a stub `fetch`, sends the injected header (`scripted` has no HTTP).
- [x] **R** `restyle-read`: wraps `read` to add `details`; its `cli.tools.read` renderer gets the built-in one as
  `Default`.
- [x] **T** (A) `agent.test.ts`: `LoadOptions.fetch` reaches `create`, `auth`, a tool's `ctx.fetch` and `agent.fetch`;
  `anthropic-auth`, `litellm` and `web` tests stub requests through it and no longer patch `globalThis.fetch`.
- [x] **T** (B) `CreateOptions.auth()` re-reads an expired entry through the provider's `auth` and saves it;
  `oauth-wrap` and `anthropic-auth` refresh in `fetch` through it (no `updateSecret` of their own).
- [x] **T** (C) a run sends the provider's `info(model).maxOutput` as `maxTokens` (to the delegate of a routing
  provider); Anthropic's `max_tokens` takes `req.maxTokens` first. `litellm` no longer fakes `GET /v1/models/<id>`.
- [x] **T** (D) a routing provider delegating through `CreateOptions.providers` gets named wraps but not `"*"` ones again;
  `litellm` routes through the registered defs, and another plugin's `anthropic` wrap reaches its Claude requests.
- [x] **T** (E) nested `${VAR}`s (`headers: { ... }`, arrays) expand; `litellm` stops expanding its `headers` itself.
- [x] **T** (F) a tool refreshes a login through its owner's `auth` via `ctx.secrets`; `web` drops its `loadPlugins`
  re-implementation of `agent.secrets.get`.
- [x] **T** (G) `secrets.find(type)` lists a type's entries, expanded; `web` and `anthropic-auth` use it instead of
  scanning `loadSecrets()`.
- [x] **T** (H) an entry of a type no provider has doesn't break `listModels` (documented in `secrets.ts` and AGENTS.md).
- [x] **M** `pnpm dev` with `disabledPlugins: ["builtin:bash"]`: the model has no bash tool; `/model` still works.
  (Verified in a pty: `node packages/cli/dist/index.js` (the `pnpm dev` binary) under a temp `HOME` with a scripted provider plugin in `~/.hortus/plugins`, no real keys; the provider answered with its request's tools and model: `read,write,edit` (no
  `bash`) before and after `/model scripted/other`, whose next request had model `other`.)
