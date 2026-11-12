# Phase 5 — MCP and codemode as plugins (the proof)

## Changes

- `builtin:mcp` (`core/src/builtin/mcp.ts`): connects in `init` (as built: `ready`, and its tools go to the host
  `ctx.tools`; see below) in the background (the first `run_start` awaits it), pushes its tools in `run_start` with `exposure: "codemode"` when `builtin:codemode` is loaded, else `"direct"`;
  closes in `close`. Connection errors go to `ctx.notify("error")`. Servers come from an
  `mcp_servers { servers }` event shaped like `skills`: `builtin:mcp` pushes `mcp.json`'s, other plugins add theirs;
  `mcp.json` wins on a name clash.
- `builtin:codemode`: in `run_start`, if any tool has `exposure: "codemode"`, adds the `codemode` tool, whose
  description declares those tools; scripts call them through `ctx.runTool` (gated, `parentId` set).
  `config.codemode: false` becomes `disabledPlugins: ["builtin:codemode"]` (migrate the old key on load).
- `agent.ts` loses all MCP/codemode code; `agent.mcpErrors()` is removed (errors arrive as `notify`).

**As built (deviations and details the plan left open).**
- Pieces: `builtin/mcp.ts` and `builtin/codemode.ts` import only `../index.ts`; the helpers stay in `mcp.ts`
  (`loadMcpConfig`, `connectMcp`, `mcpResult`, `McpServer`) and `codemode.ts` (`codemodeTool`, `codemodeDescription`,
  `runScript`, `tsType`, `declare`), exported from the index (phase 1's pattern). Load order: `…, openai, mcp, codemode`.
- `mcp_servers` is fired by builtin:mcp itself (in `ready`, before connecting), its payload seeded with mcp.json's
  servers; builtin:mcp then applies mcp.json's entries over the result, so mcp.json wins a name. A plugin replacing
  builtin:mcp fires it (or not) itself. An invalid mcp.json is one `notify` error, and plugins' servers still connect.
- The connection is per agent, in builtin:mcp's `ctx.state` (see "Gaps the ports found"; first a WeakMap keyed by
  `ctx.host`), not module state: tests (and embedders) create several agents in one process, and with one module-wide
  set a second agent's `init` orphaned the first's server processes.
- builtin:mcp connects in `ready`, a new core event fired once right after `init` (every `init` handler has finished),
  not in `init`: builtin loads first, so in `init` its `mcp_servers` fired before other plugins' async `init` was done.
- MCP tools are agent-level, not per run: once connected builtin:mcp pushes them into the host `ctx.tools` (the agent's
  tool set; each run's `run_start.tools` starts from a copy of it), so hosts' and commands' `ctx.tools`/`ctx.runTool`
  reach them outside runs (`deferred-context`'s `/deferred` lists and unblocks them). Its `run_start` awaits the
  connection and adds each one with no same-named tool in the run (required, not a fallback: a run that copied the set
  before they arrived, or a phase-6 child, gets them only there); exposure is re-decided there per run: when the run has
  no `codemode` tool (removed by an earlier handler, or builtin:codemode disabled), its MCP tools become `"direct"`
  copies (the host's stay as they are). Pushing to the host `ctx.tools` is public
  (documented on `Ctx.tools`), so a replacement MCP plugin can do the same.
- Each server has 30 s (`connectMcp`'s `timeout`) to connect and list its tools, else it fails like an erroring server
  (one `notify` error), so a hung server can't block every run's `run_start`.
- How builtin:mcp knows codemode is there: a codemode host in the agent's tools when it connects, i.e. a tool with
  `codemodeHost: true` (builtin:codemode's `codemode`, Fabric's `fabric_exec`; first: a tool named `codemode`, which a
  replacement under another name missed). builtin:codemode provides it as a plain `Plugin.tools` entry, so it's there
  from the start. No `ctx.plugins` was needed. When a `run_start` handler removes every codemode host from a run,
  builtin:codemode's `request` declares the run's codemode-only tools directly (only for the run's own requests and
  previews, not `ctx.complete`'s), so they stay reachable.
- builtin:codemode isn't `order: "last"`: it works in `request` (after `run_start`, so it sees the final callable set
  `ctx.tools`, whichever plugin added or removed tools, `extra` ones included): it drops `codemode` from the request when
  no callable tool has `exposure: "codemode"`, else sets the description (TypeScript declarations of every callable tool
  but itself, as before: not only the codemode-only ones). So a plugin can still `wrap` `codemode`.
- Scripts call `ctx.runTool` (core validates the input; an invalid one, a block or a failure rejects with the result's
  `output`). To keep "structured content resolves as the value", `ToolResult.value?` is new: what `execute` returned
  when it was neither text nor images (`output` is its JSON); core drops it from a model's calls' results (never saved
  or sent), so only `ctx.runTool` callers see it, and drops it when a `tool_result` handler changed `output` (a
  redaction then reaches codemode scripts too). A result's images come back as blocks (already saved; the result's
  `output` is the first one's `text`), and `image()` doesn't save them again.
- The "only reachable from codemode" hint on a model's direct call moved from core to builtin:codemode's `tool_result`;
  core's `unknownTool` is just `Unknown tool: <name>`, and core declares only `exposure: "direct"` (default) tools.
- `config.codemode: false` is mapped by `loadConfig` to `disabledPlugins: [..., "builtin:codemode"]` (the key is
  dropped, so the next `saveConfig` writes the migrated form).
- Skills left `agent.ts` too (the README's grep): `agent.skills()` is gone; `listSkills(ctx)` (`context.ts`) fires
  `skills` and keeps one per name; builtin:skills calls it in its `run_start` and sets `run_start.skills`, now optional
  (absent without builtin:skills); core builds `prompt` from `run_start`'s fields (so `prompt.skills` and
  `Preview.skills` carry what `run_start` handlers left) without naming them. The CLI calls `listSkills(agent.ctx)`.
  `deferred-context`, `powerline` and `rtk-optimizer` read `skills ?? []`. The `skills` event still fires before
  `run_start`'s later handlers (it's emitted from builtin:skills' handler).
- Earlier deferrals finished: `guard` blocks codemode's calls (doc and test); `plan-mode` no longer removes `codemode`
  (its scripts reach only the run's tools; its test checks a plan-mode script sees `read` but not `write`);
  `deferred-context`'s `tool_call` block catches a codemode script's call (test added; no code change). Nothing was
  left for `hashline-edit` (it has no codemode-specific code).

**Gaps the ports found** (`examples/plugins/postman`, `fabric` (replaces builtin:codemode), `mcp-extension` (replaces
builtin:mcp)); each fixed in core/CLI, then the port's workaround removed:
1. `findSkills(dir)` (`context.ts`): the discovery walk over one dir; `discoverSkills` uses it. `postman` lists its
   `skills/` with it (was: one `readdir` + `readSkill`). No `hortus.json` `skills` key: one call in the plugin covers it.
2. `Tool.codemodeHost`: the marker builtin:mcp (and builtin:codemode's fallback) checks instead of the name `codemode`.
   `fabric_exec` sets it, so MCP tools stay codemode-only and `fabric` no longer strips `mcp__*` from requests.
3. `ctx.runTool(call, { signal })`: that call's `ToolCtx.signal` (and its nested calls') is `signal` combined with the
   caller's. `fabric` and builtin:codemode abort their scripts' running calls on timeout, abort or end.
4. A failed builtin:bash call's last `ctx.update` is `BashDetails { exitCode, signal?, timedOut?, aborted? }`, so it is
   the error result's `details` (no new result kind). `fabric`'s `settle` reads `exitCode` from it (was: a regex on the
   text; its `output` is now the whole error text, status line included).
5. `ctx.state`: one plain object per plugin per agent (keyed by the name a ctx is bound to: a handler's plugin, a tool's
   `plugin`, a command's plugin), not a factory default export. builtin:mcp and `mcp-extension` use it (were:
   `WeakMap<Host, …>`). `powerline`/`decide` keep module state (their React components read it). A `ToolWrap` keeps
   the tool's `plugin` (was: stamped with the wrapper's, so wrapping `mcp_connect` handed it the wrapper's state; phase
   2's attribution changes with it); a wrapper keeps its own state by closure. A tool without `plugin` gets a state of
   its own per tool name, in a namespace no plugin name can reach (was: keyed by its bare name).
6. Each request declares from the run's tools as they are then (was: a snapshot taken after `run_start`), so a tool
   pushed into a run's `ctx.tools` mid-run is declared from the next request on. `mcp-extension` adds and removes a
   connecting/stopping server's tools in each running run's `ctx.tools` (captured at `turn_start`, after every
   `run_start` handler, with the ones a restriction removed kept off) and only orders tools in `request` (was: a
   `request` patch adding and dropping them).
7. Event `interactive {}`: a host's signal that a person can answer asks now. The TUI fires it as `createCli` returns
   (when `host.interactive` turns true; the App draws asks queued before it mounts); phase 8's RPC host fires it when a
   client attaches. `mcp-extension` asks about a project's `.hortus/mcp.json` then (at `ready` when the host is already
   interactive, as headless tests are) (was: retrying at the first `run_start`).
8. `Tool.meta` (never sent; spreads carry it through `mergePlugins`/`run_start`): builtin:mcp and `mcp-extension` set
   `meta.mcp = { server, tool, annotations? }`. `mcp-extension` still appends hint words to the description, as Pi does.
9. `Tool.jsonSchema`: declared as is in place of `inputSchema`'s (`toolSchema(t)`, used by the providers and codemode's
   declarations); `inputSchema` stays required and still validates. builtin:mcp and `mcp-extension` send the server's
   schema as is with `inputSchema: z.looseObject({})` (the server validates), so nothing is lost to
   `z.fromJSONSchema`.
   Also: `ctx.runTool(call, { signal })`'s signal reaches the nested tool's `ctx.complete` and `ctx.ask` (both use the
   scope's combined signal; were: the run's only). `mcp-extension`'s progress can be lost when it arrives in the same
   chunk as the result (the SDK drops the handler before the notification runs); its test server waits 20 ms after one.
   10–12 (OAuth for MCP, a project-trust API, renderers keyed by name pattern or plugin) are in the README's "Possible
   later".

Final round (M2): mcp.json's schema keeps unknown fields (`z.looseObject` for the file and each server; `McpServer`
has an index signature), so plugins sharing the file (a server's `lifecycle`, top-level `settings`) and `mcp_servers`
pushers keep theirs. (mcp-adapter still reads its own layered files: switch-only overrides like `{ disabled: true }`
aren't valid core entries.) Item 11's project-trust API is in (phase 2's final round, `ctx.trust`).

## Verification

- [x] **T** `grep -niE "mcp|codemode" packages/core/src/agent.ts` is empty (`agent.test.ts` checks the README's full pattern).
- [x] **T** `mcp.test.ts` (moved): a stdio test server's tools appear as `mcp__<server>__<tool>` with
  `exposure: "codemode"`; with `builtin:codemode` disabled they are declared directly.
- [x] **T** a plugin pushing a server in `mcp_servers` gets it connected; a same-named `mcp.json` entry wins.
- [x] **T** a failing server → one `notify` error; other servers still work.
- [x] **T** a codemode script calling a tool → `tool_call` fires with `parentId` = the codemode call; `guard` blocks it.
- [x] **T** a codemode script can't reach a tool removed in `run_start`.
- [x] **T** `config.codemode: false` still disables codemode (migration).
- [x] **T** a plugin with `replaces: ["builtin:mcp"]` providing tools with `exposure: "codemode"` gets them listed by
  `builtin:codemode` (codemode doesn't depend on which plugin made them).
- [x] **T** `close` stops the server processes (no child process left).
- [x] **R** `guard` (codemode half): `tools.bash({ command: "rm -rf /" })` inside a codemode script is blocked.
- [x] **T** `findSkills(dir)` walks one dir like discovery (`context.test.ts`); `postman`'s tests still pass using it.
- [x] **T** a codemode host under another name (`codemodeHost`) keeps MCP tools codemode-only (`mcp.test.ts`); `fabric`
  runs MCP tools from programs without stripping them.
- [x] **T** `ctx.runTool`'s `signal` aborts that call and its nested ones, not the run (`events.test.ts`); a `fabric`
  program's timeout kills its running `pi.bash` (`fabric` test).
- [x] **T** a failed bash call's details are `{ exitCode, … }` (`tools.test.ts`); `fabric`'s `settle` reads them.
- [x] **T** `ctx.state` is one object per plugin and agent across handlers, tools and commands (`events.test.ts`).
- [x] **T** a tool pushed into a run's `ctx.tools` mid-run is declared from the next request (`events.test.ts`);
  `mcp-extension`'s mid-run `mcp_connect` without a `request` patch.
- [x] **T** the TUI fires `interactive`, and an ask from it reaches the dialog (`hooks.test.tsx`); `mcp-extension` asks
  about the project's servers then.
- [x] **T** MCP tools carry `meta.mcp` and declare the server's schema as `jsonSchema` (`mcp.test.ts`, `mcp-extension`);
  every provider sends `jsonSchema` as is and never `meta` (`openai.test.ts`).
- [x] **M** `pnpm dev` with a real MCP server in `mcp.json`: tools work through codemode; exit leaves no process.
  (Verified in a pty: `node packages/cli/dist/index.js` (the `pnpm dev` binary) under a temp `HOME` with a scripted provider plugin in `~/.hortus/plugins`, no real keys; `mcp.json` ran a local stdio `@modelcontextprotocol/sdk` server with an `echo`
  tool; the model's `codemode` call `tools.mcp__t__echo(...)` returned `"echoed from codemode"` (the request declared
  `codemode`, not the MCP tool); the server process was running during the session (`pgrep`) and gone after Ctrl+D.)
