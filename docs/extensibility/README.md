# Full extensibility

Rule: **built-ins use nothing a plugin can't.** Every built-in feature is a plugin piece written against the public
API. Whole plugins are the unit of replacement and removal (`replaces`, `disabledPlugins`); wrapping (receiving the
previous implementation as `Default`) is the unit of layering, as the CLI already does for slots and tool renderers.

The design was checked against Pi (pi.dev) extensions: the top 50 packages by monthly downloads (round 1), then 50
more chosen for categories round 1 missed (round 2). [`port-matrix.md`](port-matrix.md) records what each needs.

## Phases

| #   | Plan                                                               | Depends on | Proves it with                                 |
| --- | ------------------------------------------------------------------ | ---------- | ---------------------------------------------- |
| 0   | [Test harness](phase-0-harness.md)                                 | —          | an end-to-end run against a scripted provider  |
| 1   | [Pieces, `replaces`, wrapping, credentials](phase-1-pieces.md)     | 0          | `oauth-wrap`, `restyle-read`                   |
| 2   | [One `ctx`, loop events, gated tool calls](phase-2-events.md)      | 1          | `guard`, `tracer`, `plan-mode`                 |
| 3   | [Core-owned session, entries, plugin messages](phase-3-session.md) | 2          | `todo`, `remote`                               |
| 4   | [Talking to the user (core + CLI)](phase-4-ui.md)                  | 3          | `ask-user`, `guard`, `todo` panel              |
| 5   | [MCP and codemode as plugins](phase-5-mcp-codemode.md)             | 2, 4       | `builtin:mcp`, `builtin:codemode`              |
| 6   | [Nested runs](phase-6-subrun.md)                                   | 3          | `subagent`                                     |
| 7   | [Compaction as a plugin](phase-7-compaction.md)                    | 3, 6       | `compaction`                                   |
| 8   | [Headless and RPC modes](phase-8-headless.md)                      | 3, 4       | `subagent --background`, `remote` over `--rpc` |

Phases 1–3 unblock most packages; 4 is the UI surface (the biggest phase after round 2); 5 moves MCP/codemode;
6–8 serve subagents, compaction and other frontends.

## Non-goals

Revisit only with a concrete package that needs it (see the "Not ported" column of the port matrix):
- Core events that rewrite serialized provider payloads (provider `wrap`, incl. `"*"`, plus `headers`/`fetch` cover it:
  a wrapper that must rewrite the payload parses and re-serializes the JSON body inside its wrapped `fetch`, which is
  the intended path, as the `anthropic-auth` port found).
- Virtual models / cross-provider routing; tool namespaces; exposure tiers beyond `direct | codemode`.
- Overlays and popups over the transcript (the `prompt`, `aboveInput` and `transcript` slots cover takeovers:
  `powerline`'s welcome screen replaces the `transcript` slot while it shows), raw terminal-input interception, a
  keybinding registry (the prompt's `cli.keys` hook covers editor keys), mouse hover, CLI flags declared by plugins
  (commands and config cover them).
- A built-in "working" indicator: the host draws none; a plugin draws its own in `aboveInput` or `statusBar` (or on the
  prompt's edge through the `prompt` slot), reading `useUi(s => s.busy)`, as `powerline`'s working vibes do.
- Inline terminal images (Ink's layout can't measure kitty/iTerm escapes).

Possible later (found by the phase 4 and 5 ports; each has a workaround today):
- A real isolate for the example plugins' script runners (Fabric's `fabric_exec`, workflows, pi-subagents still use
  `node:vm`, which is no sandbox, so they declare `effects.code`): builtin codemode's QuickJS runner (`runScript`)
  shows the way. (Builtin codemode itself moved to QuickJS after the build: see phase 2's final-review fix 1.)
- `ModelInfo.subscription` (whether a model is billed by subscription, so a footer shows no cost): `powerline` shows
  the cost when a provider reports it.
- Message timestamps: messages carry none (session entries are ordered, not dated); a plugin wanting them keeps its own
  (`ctx.session.appendEntry`).
- Per-agent plugin state exists now (`ctx.state`, phase 5), and TUI components reach it (`usePluginCtx`, phase 6
  ports): builtin:mcp, `mcp-extension`, `btw` and `workflows` use it; `powerline` and `decide` still keep module state
  (their React components read it), one set per process, until they are moved onto `usePluginCtx`.
- Plugins extending the exit wait: `agent.close`'s timeout is a fixed 3 s per wait (runs, then the exit handlers), where
  Pi gives shutdown flushes 10 s; `hermes-memory`'s exit flush subrun is cut off (and aborted) at 3 s. Possible later:
  a `close` payload field a handler raises (`extend(ms)`, capped), or a configurable timeout.
- OAuth for MCP servers (`postman`, `mcp-extension`): servers take static `headers` (`${VAR}` expanded) only; an
  `auth`/`oauth` entry is a config error. Possible later: the MCP SDK's OAuth client provider, tokens kept in
  secrets.json through `ctx.secrets.update`.
- Per-agent tool definitions (final round, `web-access`): a tool's schema, name and exposure are fixed when its plugin
  loads; per-agent config (enable/disable, rename, drop params) is applied by rewriting `run_start.tools` every run,
  and the host `ctx.tools` still lists disabled ones. Possible later: `Plugin.setup?(hostCtx) => { tools?, commands? }`
  before the merge; needs a decision on how it relates to `ToolWrap` and `replaces`.
- Stubbing DNS (final round, `web-access`): `LoadOptions.fetch` stubs HTTP, but a plugin resolving hosts itself (SSRF
  checks) can't be stubbed by the host; left to plugins (take a resolver option).
- Per-handler bus results (final round, `permission-system`): `ctx.emit` returns nothing, so asking several
  authorizers for verdicts means each writes into the payload (keyed by its `ctx.plugin` by convention). Possible
  later: `emit` returning `{ plugin, result }[]`. Low priority.
- Tool renderers keyed by a name pattern or by the providing plugin (`cli.tools["mcp_*"]`, or every tool of one
  plugin): `mcp-extension` wraps the generic block for every tool (`tool:*`) and checks its own `details` in it.

## How completeness is verified

Each phase file ends with a **Verification** checklist. Three kinds of items:
- **T** — an automated test (`node:test`, colocated `*.test.ts(x)`), named by file and what it asserts.
- **R** — a reference plugin under `examples/plugins/<name>/` (a real `hortus.json` plugin, kept minimal) plus a
  test that loads it through `loadPlugins`/`createAgent` with the phase 0 harness and asserts its behaviour. Reference
  plugins are the proof that a capability is reachable _from a plugin_, not just from core. Layout, build and test
  setup: [phase 0](phase-0-harness.md#reference-plugins-convention-for-every-later-phase).
- **M** — a manual check in the real CLI (`pnpm dev`), for terminal behaviour tests can't see.

A phase is done when every box is ticked, `pnpm test` and `pnpm lint` pass, and `AGENTS.md` describes the new API.

## Definition of done (all phases)

- [x] Every phase checklist is ticked.
- [x] **No privileged built-ins.** Built-in pieces live in `packages/core/src/builtin/*.ts` and
  `packages/cli/src/builtin/*.ts` and import only the package's public module (`index.ts` / `api.ts`) plus their
  own helpers. Check: `grep -rn "from \"\.\./" packages/*/src/builtin/` lists only `../index.ts` / `../api.ts`.
- [x] **The loop knows no features.** `agent.ts` mentions none of `mcp`, `codemode`, `skill`, `AGENTS`, `compact`.
  Check: `grep -niE "mcp|codemode|skill|agents\.md|compact" packages/core/src/agent.ts` is empty.
- [x] **Everything built-in can be removed.** For each built-in piece, a test disables it via `disabledPlugins`
  and the agent still loads (or fails with a load error naming the dependent piece, if one requires it).
  (`plugins.test.ts` disables each of the core pieces in turn, its list checked equal to the default load;
  `cli.test.ts` each `cli:*` piece.)
- [x] **Every reference plugin passes** (`examples/plugins/*`, listed below).
- [x] **Port matrix holds.** Every row of [`port-matrix.md`](port-matrix.md) marked portable lists only capabilities
  whose checklist items are ticked. (Every phase checklist is ticked; the backticked needs not named in any item
  were checked against the items covering them; `Tool.providerOptions` had none, so phase 2 gained one.)

## Reference plugins

| Plugin         | Exercises                                                                                                                  | Phases  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- | ------- |
| `oauth-wrap`   | wraps `anthropic` via `wrap(Default)`, injects a header through `fetch`, refreshes a token stored in a loose secrets field | 1       |
| `restyle-read` | wraps the `read` tool (adds `details`) and its renderer                                                                    | 1       |
| `guard`        | blocks `rm -rf` in `tool_gate` by tool `effects` (bash's, codemode scripts' calls too), asks before writes (`write`/`edit`) and before code runs (`effects.code`: e.g. `fabric_exec`) | 2, 4, 5 |
| `tracer`       | builds a span tree from `run_*`/`request`/`response`/`tool_*` ids and parents; flushes in `close`                          | 2, 6    |
| `plan-mode`    | `/plan` removes `write`/`edit`/`bash` in `run_start`, swaps model/effort, persists its mode as an entry                    | 2, 3    |
| `todo`         | `todo` tool writing entries; state rebuilt on replay/branch; panel in the `aboveInput` slot                                | 3, 4    |
| `remote`       | observes events, injects prompts with `ctx.send({ deliver: "steer" })`, answers `ask` before the CLI does                  | 3, 4    |
| `ask-user`     | a tool whose `execute` awaits `ctx.ask`; the CLI shows it in the `prompt` slot                                             | 4       |
| `subagent`     | a `subagent` tool running `ctx.subrun` with a plugin filter and its own cwd; `background` spawns `hortus --rpc --parent <session>`, relaying its asks | 6, 8    |
| `compaction`   | an algorithmic compactor: a `compact` handler writing builtin:compaction's summary with no model call                      | 7       |
