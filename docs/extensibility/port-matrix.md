# Port matrix

Every Pi package reviewed, what it needs from these plans, and what deliberately stays unported. Round 1 = top 50 by
monthly downloads; round 2 = 50 more chosen for categories round 1 missed (providers, compaction, autonomy, remote
frontends, media). Sources were read from the npm tarballs; nothing was run.

**Done means:** for every row, each capability listed is covered by a ticked checklist item in its phase. "Not
ported" items are design decisions, listed in the README's non-goals; revisit them only with a new requirement.

## Not applicable (not Pi extensions)

`@agimon-ai/po-core`, `po-config`, `po-ui`, `po-minor-mode`, `po-web-components`, `po-web-security`, `po-hashline`,
`po-voice`, `po-notification` (internals of Po, a separate distribution embedding Pi), `@explyt/ai-agent` (standalone
distribution). Ideas from them that do apply (leader-key menus, minor modes as entries) are covered by commands,
entries and status.

## Round 1

| Package                            | Phases    | Needs                                                                                                                         | Not ported                            |
| ---------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| billion-context                    | 1 2 3 7 8 | `*` provider wrap + headers, `tool_call`/`tool_result`, `send`, `compact` cancel, headless children                           | shortcut                              |
| pi-mcp-adapter                     | 1 2 3 4 5 | `replaces: builtin:mcp`, `exposure`, `request.tools`, entries, `send`, `ask`/`notify`/`status`, `mcp_servers`, `ctx.complete` | overlays, native windows              |
| pi-web-access                      | 1 2 3     | tool ctx (signal, `complete`, `secrets.get`), gated nested `runTool`, entries, `send`                                         | widgets (→ status)                    |
| pi-mcp-extension                   | 1 2 4     | `replaces: builtin:mcp`, `run_start.tools`, `request.tools` ordering, signal, `ask`/`notify`/`status`                         | —                                     |
| pi-subagents                       | 2 3 4 6 8 | `subrun` handle + plugin filter, `send`, bus, `ask`, headless background runner                                               | —                                     |
| @postman/postman-plugin            | 2 5       | skills event, `prompt`, `mcp_servers`                                                                                         | —                                     |
| openwiki                           | 2 3       | `sequential`, signal, `close`                                                                                                 | —                                     |
| @juicesharp/rpiv-ask-user-question | 4         | `ask` kinds + `cli.asks`, `ctx.host`                                                                                          | —                                     |
| context-mode                       | 2 3 7     | `run_start`/`request`/`tool_call`/`tool_result`/`turn_end`, session id, `compact` event                                       | —                                     |
| @onkernel/browser-loop             | 1 2 3     | provider wrap (beta headers), `tool_call` block, entries, `close`                                                             | native computer-use tool declarations |
| pi-deltabox                        | 1 3 4     | `replaces` read/write/edit/bash, session lifecycle, `ask`/`notify`/`status`                                                   | —                                     |
| @dietrichgebert/ponytail           | 2 3 4     | skills, `prompt`, entries, status                                                                                             | —                                     |
| cc-safety-net                      | 2 4 5     | `tool_call` (incl. codemode calls), core commands                                                                             | —                                     |
| @langchain/langsmith-pi-extension  | 2 3       | `request`/`response` pairing, `run_end` always, `close` flush                                                                 | —                                     |
| @juicesharp/rpiv-todo              | 2 3 4     | tool ctx `appendEntry`, entries, `aboveInput`                                                                                 | —                                     |
| @plannotator/pi-extension          | 2 3 4     | `tool_call`, `run_start` tools/model/effort, `turn_end.stop`, entries, `send` + `meta`, status                                | CLI flag (→ command), shortcut        |
| pi-lens                            | 2 3 4     | `tool_call`/`tool_result`/`request`, session lifecycle, status, `request.tools` activation                                    | flags (→ config)                      |
| glimpseui                          | 3 4       | skill; companion: status, `close`                                                                                             | —                                     |
| pi-web-search                      | 1 2       | `ctx.run`, `secrets.get`, `run_start.tools`                                                                                   | —                                     |
| pi-claude-bridge                   | 1 2       | provider without key, provider ctx, `tool_call` with `ctx.run`, `run_end`                                                     | —                                     |
| @juicesharp/rpiv-i18n              | —         | works today                                                                                                                   | locale flag (→ config)                |
| pi-harness-runtime                 | 2 3 4 5   | `turn_end`, `response` usage, `send`, `mcp_servers`, entries push (header)                                                    | —                                     |
| pi-memory                          | 2 3 7     | `prompt`, `ctx.complete` with model, `session_close`, `compact` event                                                         | —                                     |
| pi-simplify                        | 3 4       | core command + `send`                                                                                                         | —                                     |
| @opengsd/gsd-core                  | 2 4 7     | skills, core command, `request.model`, `compact` event                                                                        | —                                     |
| @tintinweb/pi-subagents            | 2 3 4 6   | `subrun` handle, `send`, `input`, bus, `transcript` slot (fleet view)                                                         | —                                     |
| @agimon-ai/po-logsink              | 2 3       | run/turn/tool events, lifecycle                                                                                               | —                                     |
| pi-advisor-flow                    | 2 3 4     | `tool_call`, `ctx.complete` other model, `run_start`, `send` + `meta`, `ask`                                                  | —                                     |
| @quintinshaw/pi-dynamic-workflows  | 3 4 6     | `subrun` with cwd + plugin filter, `send`, `input`, `transcript` slot                                                         | —                                     |
| pi-fabric                          | 1 2 6     | `replaces: builtin:codemode`, gated `runTool`, `request.tools`, `exposure`, `subrun`                                          | —                                     |
| gentle-pi                          | 2 4 6 8   | `tool_call` gates, children via `subrun`/headless, entries/themes for its look                                                | whole-distribution UI replacement     |
| @getpipher/vision                  | 1 2 3     | `info.images`, `ctx.complete` other model, user-message images                                                                | compose preview UI                    |
| @datadog/pi-plugin                 | 2 3 4     | tools, entries, `ask`, `setInput`                                                                                             | native viz window                     |
| @gotgenes/pi-permission-system     | 2 3 4     | fail-closed `tool_call`, `run_start` tools/skills, `input`, `ask`, status, bus                                                | —                                     |
| pi-powerline-footer                | 3 4 6     | slots (`statusBar`/`aboveInput`/`prompt`), `setInput`, statuses, commands while busy, `send` steer, session cwd (`/cd`)       | bash-mode `!` shell                   |
| confluence-cli                     | 4         | skill, `ask` before writes                                                                                                    | —                                     |
| pi-btw                             | 3 4 6     | `subrun` in memory, commands while busy, `transcript`/`aboveInput`, `send`                                                    | —                                     |
| @narumitw/pi-usage                 | 1 4       | core command, status, `secrets.get`, provider wrap (`service_tier`)                                                           | —                                     |
| @gotgenes/pi-anthropic-auth        | 1         | provider wrap + `fetch`, `auth`, `secrets.update`                                                                             | —                                     |
| pi-intercom                        | 2 3 4     | `send`, session lifecycle + name, bus, commands                                                                               | —                                     |
| @braintrust/pi-extension           | 2 3       | `request`/`response`, nested tool parents, `close`                                                                            | response headers                      |
| @heyhuynhgiabuu/pi-pretty          | 1 4       | tool wrap, `entries` `tool:*`, `expanded`                                                                                     | inline terminal images                |

## Round 2

| Package                       | Phases  | Needs                                                                                | Not ported                              |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------ | --------------------------------------- |
| pi-coralbricks-provider       | 1 2     | `info`, `Usage.cost`, provider ctx (session header, cache key)                       | —                                       |
| pi-fireworks                  | —       | works today (`openai` entry with `endpoint`)                                         | —                                       |
| pi-provider-litellm           | 1 2     | `secrets.update`, provider ctx, built-in provider factories                          | —                                       |
| pi-cursor-sdk                 | 2 3     | provider ctx (agent per session), provider-executed tool calls, entries              | —                                       |
| @caph42/pi-cursor-provider    | 1 2 4   | provider ctx (conversation id), `secrets.update`, command, status                    | —                                       |
| pi-claude-pro                 | 1 2 4   | provider wrap + `headers`/`fetch`, provider ctx, status                              | —                                       |
| pi-cache-optimizer            | 1 2 4   | `*` provider wrap, provider ctx, `prompt`/`request`/`response`, status               | —                                       |
| @howaboua/pi-codex-conversion | 1 2     | own provider, provider ctx, `providerOptions`, `run_start`/`prompt` per model family | voice                                   |
| pi-prompt-template-model      | 3 4     | `send` with model/effort returning `run_end`, core commands                          | —                                       |
| pi-fireworks-quota            | 4       | command, `aboveInput`/`ask`                                                          | —                                       |
| @sting8k/pi-vcc               | 2 3 7   | `compact` summary + `firstKeptId`, overflow `retry`, `entryId`                       | —                                       |
| pi-context-view               | 2 4     | `response.request`/`payload`, `ctx.preview`, tool attribution, `transcript` slot     | —                                       |
| pi-deferred-context-engine    | 2       | `request.tools` + `exposure`, `run_start.skills`, `prompt`                           | —                                       |
| pi-hermes-memory              | 2 3 6   | `subrun` with plugin filter, lifecycle, `compact` event                              | —                                       |
| gentle-engram                 | 2 3 7   | `send` before first request, `compacted { entry }`, bus                              | —                                       |
| pi-rtk-optimizer              | 2       | `tool_call` input copy (execution-only), `tool_result`, `tool_update`                | —                                       |
| @remnic/plugin-pi             | 2 5 7   | `run_start`, `mcp_servers`, `compact` summary, `compact_request`                     | —                                       |
| @ff-labs/pi-fff               | 1 4     | tools (or `replaces`), `cli.complete`                                                | —                                       |
| pi-hashline-edit-pro          | 1 2 3   | tool wrap/replace, `withToolLock`, `sequential`, `send` before first request         | —                                       |
| keyshroud                     | 1 2 4   | `${VAR}` in secrets, `tool_result` redaction, `ask { secret }`                       | —                                       |
| @narumitw/pi-plan-mode        | 2 3 4 6 | host ctx in commands, `abort`, `send`, session cwd                                   | shortcuts (→ commands)                  |
| pi-goal-x                     | 2 3 6   | host ctx (timers), `send` steer/after, `abort`, `subrun` auditor                     | —                                       |
| @narumitw/pi-goal             | 2 3     | host ctx, `send` → `run_end` Promise, `abort`, bus RPC                               | —                                       |
| pi-background-tasks           | 2 3 6 8 | host ctx, `abort`, headless child flags                                              | —                                       |
| @gotgenes/pi-subagents        | 3 6     | `subrun` handle (steer, resume, abort, id), host ctx                                 | —                                       |
| pi-straw-boss                 | 3 4 8   | `send` modes, racing `ask`, `--name`/`--session`, `exit`                             | depends on porting Herdr + pi-intercom  |
| @kontextmind/kxm              | 3 4 8   | host ctx, `send` → Promise, `exit`, `-p --session` workers                           | —                                       |
| pi-implement                  | 3 4 7   | core commands with ctx, `send` → Promise, `compact_request`                          | —                                       |
| @maxiaochao/pi-toolkit        | 3 6 8   | host ctx (scheduler), `send` modes, session cwd (worktree), headless flags           | —                                       |
| @awebai/pi                    | 2 3     | host ctx, `send` context/steer, `tool_call`                                          | —                                       |
| pi-cc-extensions              | 4       | `entries` for every kind, themes, `cli.complete`, `transcript` slot                  | mouse hover, sticky prompt              |
| pi-fast-tui                   | 4       | `entries` `tool:*`, `partial`, header entry                                          | popup menus                             |
| pi-markdown-preview           | 3 4     | commands, events                                                                     | terminal page rendering (image escapes) |
| pi-interview                  | 3 4     | `ctx.host`, `send` after detach, `ctx.complete`                                      | —                                       |
| pi-ask-user                   | 4       | rich `ask` (`multi`, `allowText`, kinds)                                             | —                                       |
| pi-decide                     | 4       | racing `ask` (autopilot on timeout), kinds, `ctx.host`                               | —                                       |
| @llblab/pi-telegram           | 4       | `cli.init`, `ask.answered`, `agent.commands()`                                       | —                                       |
| pi-wechat-session-hub         | 3 8     | `--rpc`, `session_close.cancel`, session name                                        | —                                       |
| pi-web-ui                     | 3 4 8   | `run({ session })` for many conversations, `ask` relay, RPC                          | Claude Code / Codex engines             |
| @edgehero/pi-dispatch-admin   | 4       | core commands with `ask`, `transcript` slot, `cli.suspend`                           | —                                       |
| awesome-pi-themes             | 4       | theme registry, `/theme`, tokens for all colors                                      | —                                       |
| pi-otel                       | 1 2     | handler ctx `callId`, `response.meta`, `bash` wrap (env)                             | —                                       |
| @raindrop-ai/pi-agent         | 2       | works with phase 2 events                                                            | —                                       |
| pi-agent-browser-native       | 2 3     | `images[]`, entries, `tool_result`, bus                                              | —                                       |
| @injaneity/pi-computer-use    | 2 4     | tool `details`, `ask`, `notify`                                                      | —                                       |
| @amaster.ai/pi-image-gen      | 4       | renderer showing paths                                                               | inline images                           |
| @agntn/web                    | 1       | `secrets.get({ refresh })`                                                           | —                                       |
| betterwright                  | 2 3 4   | `images[]`, `ask`, `request.tools`, `send` hidden context                            | —                                       |
| latchkey                      | —       | works today (skills)                                                                 | —                                       |
