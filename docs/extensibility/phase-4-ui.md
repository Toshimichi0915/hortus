# Phase 4 — talking to the user

## Changes

### Core

**Ask.** Event `ask` with payload
`{ kind?, question, options?: { label, description? }[], multi?, allowText?, secret?, data?, signal, resolve(answer),
answered: Promise<Answer | undefined> }` and helper `ctx.ask(...) → Promise<Answer | undefined>`.
- **Answers race.** Handlers are called without awaiting each other; any of them (a remote approver, an autopilot on a
  timeout, the CLI dialog) may call `resolve`. The first answer wins; `signal` then aborts the others, and `answered`
  settles for observers.
- The CLI is one handler among them: it shows its dialog immediately unless an earlier handler resolved synchronously
  (policy plugins answer without a dialog). When it actually shows one it emits `attention { reason: "ask" }`
  (desktop notifiers hook that). The CLI shows one dialog at a time and queues the rest.
- No handler resolves (no UI) → `undefined`; callers fail closed. Abort resolves pending asks with `undefined`.
- `secret: true`: masked input; the answer is never logged, saved or shown.
- `kind` + `data` let a plugin ship a rich dialog (`cli.asks[kind]`, below) while remote hosts and autopilots answer
  from the generic fields.

**Notify, status, host.** Events `notify { text, level: "info" | "warn" | "error" }` and `status { key, text? }`, with
helpers `ctx.notify`, `ctx.status`. `ctx.host: { kind: "tui" | "headless" | "rpc" | string; interactive: boolean }`.
`ctx.exit()` asks the host to shut down (normal exit path: `session_close("exit")`, `close`).

**Commands move to core.** `Plugin.commands?: Command[]` with `run(arg, ctx)` (host ctx: `ask`, `send`, `notify`,
...) and `complete(ctx)`; `agent.commands()` lists them, so remote hosts can list and run them. The CLI's `/` menu
lists them; the CLI-only commands (`/model`, `/effort`, `/new`, `/resume`) become `cli:*` pieces using the same type.
Commands run while a turn runs; only new turns are refused.

### CLI

- Slots: `prompt` (input + `/` menu; app keys Esc / Ctrl+C / Shift+Tab move from `app.tsx` `Layout` into the default
  prompt so a takeover owns the keyboard; Ctrl+D stays global), `aboveInput` (default empty), `transcript` (swap the
  transcript for a fullscreen view: browsers, inspectors, panels), all composed like `statusBar`.
- `UiState.input` + `cli.setInput`; `UiState.statuses` (from `status` events) drawn by the default bar and readable by
  replacements; `cli.init?(cli, ctx)` once at start; `cli.suspend(fn)` leaves the alternate screen and raw mode while
  `fn` runs a child process in the terminal.
- **Renderers for every entry.** `cli.entries[kind]` for `user`, `assistant`, `thinking`, `info`, `error`, plugin
  messages (`"<meta.plugin>:<meta.type>"`, e.g. `goal:prompt`, so two plugins' types never collide) and `tool:<name>` / `tool:*` (the generic fallback, so unknown and MCP tools get cards);
  each gets `Default`. This replaces `cli.tools` (kept as an alias). Plugins can push UI-only entries (a header, a turn
  summary) with `cli.push(entry)`.
- **ToolView** gains `expanded` (toggled globally by Ctrl+O), `partial` (streamed input from `tool_input`), and
  `siblings` (the other calls of the same assistant message; a renderer may draw nothing, so cards can be grouped).
  `builtin:codemode` documents its `details` shape for card renderers.
- **Themes.** `cli.themes: Record<name, Theme>` (a registry; packs ship many), `config.json` `theme`, a `/theme`
  command, and reactive `useTheme()`. Every hard-coded color (`entry.ts` styles, tool backgrounds, markdown, diff,
  syntax) moves onto theme tokens.
- `cli.asks[kind]`: rich dialog components for `ask` kinds (get `Default`, the generic select/input, and call
  `resolve`). The generic dialog renders in the `prompt` slot: options as a list (reusing the `/` menu rows), `multi`,
  free text when `allowText`.
- `cli.complete`: wraps the prompt menu's `suggest` (gets `Default`), so plugins add completions such as `@file` or
  `@session` without taking over the `prompt` slot.

**As built (deviations and details the plan left open).**
- `Answer` is `string | string[]` (a picked option's label, typed text, or `multi`'s labels); `resolve(undefined)`
  dismisses. "No handler resolves" = every `ask` handler's returned promise has settled without an answer, so a handler
  that may answer later (the TUI's dialog, `remote` while a client listens) keeps its promise pending until it answers
  or `signal` aborts. `remote` lets go of its pending asks when its last client leaves; the TUI holds none until
  `createCli` has returned (asks raised by a plugin's `init`, the first `session_open` or `cli.init` have no App to show
  them, so they fail closed unless another handler answers, instead of deadlocking startup). Handlers are started in load order without awaiting each other, so a policy that resolves
  synchronously is seen by every later handler (`signal.aborted`), which is how the TUI skips its dialog. Handler
  errors go to `onError`. Core never logs or saves asks; the TUI keeps a secret's typed text only in the dialog.
- `ctx.notify(text, level = "info")` / `ctx.status(key, text?)` return the emit's promise. `ctx.host` is
  `LoadOptions.host` (default `{ kind: "headless", interactive: false }`); a host may add fields: the TUI's is
  `{ kind: "tui", interactive: true, cli }`, and `cliOf(ctx)` (from `@hortus/cli`) returns that `cli` or throws, which
  is how TUI-only commands (`/new`, `/resume`, `/theme`) reach it. `/model` and `/effort` work on any host: they use
  `ctx.session` and a new `ctx.resolve(opts?)` (the provider, model and `info` a run on the ctx's session would use),
  and the TUI only when it's the host (its shown effort, saved to `config.json`). `ctx.exit()` calls `LoadOptions.onExit` (default `agent.close()`); the TUI's sets
  `UiState.exiting`, the App exits, and `index.tsx` closes the agent (`session_close("exit")`, `close`).
- Commands: core's `Command` takes `run(arg, ctx)` / `complete(ctx)`; `agent.commands()` returns `AgentCommand`s with
  `plugin` stamped and `run(arg)` / `complete()` already bound to `agent.ctxOf(plugin)` (the host ctx bound as that
  plugin: its sends' source, its aborts' `by`). `CliPlugin.cli.commands` is gone (every example plugin moved its
  commands to `Plugin.commands`; those needing nothing of the TUI dropped their `@hortus/cli` dependency). Skill
  commands stay the TUI's (`skillCommand(skill, cli)`, an `AgentCommand` submitting a turn). `cli:theme` is a new piece
  (`/theme [name]`, and the built-in `dark` theme in its `cli.themes`).
- Slots take no props besides `Default`; the default slots read the store and a context the App provides (the composed
  renderers and dialogs, and the input's scroll that the transcript's wheel-below drives). Esc / Ctrl+C / Shift+Tab live
  in the default prompt's input box (so neither a takeover nor the ask dialog gets an abort from Esc); Ctrl+D and Ctrl+O
  are global. While an ask is pending, `Layout` draws its dialog in the `prompt` slot's place (a takeover is unmounted
  meanwhile), so a takeover never hides asks; rich dialogs go through `cli.asks[kind]`.
- `cli.entries` keys a renderer by entry kind; text kinds get an `EntryView { entry, width }` (`EntryRenderer`), tool
  kinds the `ToolView` (`ToolRenderer`). A text kind without a plugin renderer keeps the transcript's own row drawing; with
  one it becomes a block like a tool's (measured, kept mounted), whose `Default` draws the same rows. A plugin message
  shows only when some plugin renders its `<plugin>:<type>` (unrendered ones stay hidden, as before). `TextEntry.kind` is
  `TextKind`: the built-in kinds or `` `${string}:${string}` `` (so `cli.push` kinds are namespaced like messages').
  `warn` is a new text kind (`notify` level "warn").
- A block that draws nothing (its content measures 0 rows) gets no background, padding or gap row, so a renderer can
  draw a group of `siblings` in one card. A block's measured height is keyed by width and `expanded`, so Ctrl+O re-measures.
- `partial`: the first `tool_input` of a call creates its block (closing the text streamed before it), deltas are
  batched per frame like text; the `tool_call` replaces the block's call and drops `partial`.
- Themes: `Theme` tokens in `themes.ts` (the only file with color literals; the grep check is a test over `src/**/*.ts(x)`);
  `theme` is one object `applyTheme` changes in place (plugins reading `theme.red` while drawing stay correct), with a
  version counter invalidating cached rows; `useTheme()` re-renders on a switch (the input box and the ask dialog use it). `config.theme` is applied
  before `createCli` returns, so the first frame is drawn in it (`themes.test.tsx` checks the colors drawn). An unknown `config.theme` is reported as
  an error line and the default kept.
- `cli.complete(input, Default)` is synchronous (a plugin that must read files does so synchronously, or keeps a cache).
- `cli.suspend(fn)` is Ink 8's `suspendTerminal` (alternate screen, raw mode, kitty protocol, forced redraw) plus SGR
  mouse reporting off/on, written to the stdout stream directly (Ink's own `write` is muted while suspended).
- `codemode`'s `details`: `CodemodeDetails { calls: { tool, input, status: "running" | "done" | "error" }[] }`,
  reported through `ctx.update` as its script calls tools.
- Earlier deferrals finished: `guard` asks before `write`; `goal` asks before replacing an unfinished goal (no answer
  keeps it), renders `goal:prompt`/`goal:contract` (the contract is no longer `display: false`); `otel` and `langsmith`
  report their first failed export with `ctx.notify("warn")`; `rtk-optimizer` notifies rewrites (when
  `showRewriteNotifications`), suggestions (once each) and skipped rewrites' warnings, and `/rtk` alone asks which
  setting to flip where `ctx.host.interactive` (Pi's settings modal); `web`'s `/web` asks which hit to put into the
  prompt in the TUI (`cliOf(ctx).setInput`); `litellm` gained `/litellm:login [name]` (proxy URL from known ones or
  typed, masked key, checked against `/v1/models`, saved through `ctx.secrets.update`). Every plugin command's test runs
  it through `agent.commands()` (no `Cli` stand-ins left). Not done: `anthropic-auth` has no login of its own (Pi's
  package delegates login to Pi; it has nothing interactive to port), and `web` sets no status (its Pi original's
  activity widget belongs to pi-web-access, not the ported package).
- Tests: `core/src/ask.test.ts` (ask race, headless, abort, notify/status, exit, `agent.commands()`),
  `cli/src/ui.test.tsx` (the TUI on a real agent in a fake terminal: dialogs, slots, entries, themes, suspend, keys)
  and `cli/src/themes.test.tsx` (the colors drawn, with `FORCE_COLOR`).

Phase 8's ports added (see its As built): `MessageMeta.display: true` shows a plugin message no plugin renders with
the built-in plugin-message look (`customMessageText`/`customMessageBg`); `hortusBin` in `@hortus/cli`.

**As built: gaps found by porting Pi packages** (`examples/plugins/themes` from awesome-pi-themes, `decide` from
pi-decide, `powerline` from pi-powerline-footer; each workaround they needed is gone):
- Testing: `@hortus/cli/testing` has `startCli(opts?)` (`createCli` as `hortus` sets it up: the `cli:*` pieces,
  `provided: { "@hortus/cli" }`, then `opts`, its `extra` before the TUI's observer, on `opts.session` or a new one)
  and `renderApp(cli, { columns, rows, colors })` (the App in a fake `terminal`, `exitOnCtrlC: false`; returns the
  terminal plus `app`, `screen()`, `keys(k)`). `colors: true` sets Ink's chalk to truecolor until that app unmounts
  (then restores it), so a test checks drawn colors without setting `FORCE_COLOR` before importing anything.
- Themes: `Theme` gained role tokens (`selectedBg`, `customMessageBg`, `userMessageText`, `assistantText`,
  `customMessageText`, `toolTitle`, `toolOutput`, `toolDiffAdded`/`Removed`/`Context`, `mdHeading`, `mdLink`,
  `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet`,
  `mdTableBorder`, `mdTableHeader`, `thinkingOff`/`Low`/`Medium`/`High`/`Xhigh`/`Max`), each falling back to a generic
  token (`full(t)` in `themes.ts`: generic tokens left out come from `dark`, then each role left out copies its generic
  one, e.g. `mdHeading` ← `yellow`, so a theme setting only generic tokens looks as before). Everything that drew a
  fixed style draws a token now: the selection (was inverse) and blocks' selection overlay `selectedBg` (inverted
  instead when it's "" or the background under it: a user message's, `customMessageBg`, a tool block's; `dark`'s
  differs from `userBackground`); the session
  picker's cursor `accent`; table rules and header `mdTableBorder`/`mdTableHeader`; assistant text `assistantText`;
  plugin entries drawn by the built-in renderer `customMessageText` on `customMessageBg` ("" in `dark`: no background);
  the prompt's border, while idle, the set effort's `thinking<Level>` (auto: `border`). `cli.themes` takes
  `Partial<Theme>`; `Theme` has an index signature, so plugins add tokens of their own (`theme["syntaxKeyword"]`).
  A switch drops the previous theme's own tokens. Pi's `customMessageLabel` and `thinkingMinimal` have no hortus use
  (no label is drawn; there is no "minimal" effort); the themes port keeps them as plugin tokens.
- Ask: `AskEvent.resolve(answer, { value?, reason? })`; `answered` settles with `Answered { answer?, value?, by?,
  reason }` (`by`: the resolving handler's plugin, so each handler gets its own copy of the payload, its `resolve`
  bound to it; `reason`: "answered", "dismissed", a resolver's own like "timeout", "aborted", "unanswered");
  `ctx.ask(req)` still resolves the plain answer, `ctx.ask(req, { detailed: true })` the `Answered`. `show()` /
  `shown` (the TUI calls `show()` when the ask comes on screen, `remote` when it streams it to a client) and
  `engage()` / `engaged` (the generic dialog engages on its first key; `remote`'s new `POST /engage { id }`).
  `shown` is a plain promise; the ask ends "unanswered" once every handler has settled. Nothing shows asks on a host
  that isn't `ctx.host.interactive`, so a handler that would only wait for `shown` checks that first (the TUI host
  reports `interactive: false` until `createCli` returns, when its App can show asks). `decide`
  starts its countdown at `shown` (at once on a non-interactive host), stops it at `engaged`, resolves `undefined` with reason "timeout", and its dialog
  answers `resolve(summary, { value })`: its `AskData` lost the `AbortController`, `expired` and `result` fields.
- `CompleteRequest.signal` aborts that call (combined with the run's signal); `decide`'s judge timeout and
  `powerline`'s vibe generation pass theirs instead of racing the promise.
- CLI input: `PromptInput` is exported (`value`, `caret?`, `onChange(value, caret)`, `onSubmit`, `onKey`, `mask`);
  `decide`'s answer and note editors use it. `cli.keys(input, key, cli)` (in `CliPlugin.cli`): sees each key the
  built-in prompt gets before it does, later plugins first; true takes it (the prompt's Esc / Ctrl+C / Shift+Tab, the
  `/` menu and the input never see it). It runs only while the default prompt is mounted (not under a takeover without
  `Default`, nor while an ask's dialog shows). `cli.submit(value, Default, cli)` wraps `cli.submit` (later plugins
  outermost); a wrapper that takes the input clears it itself. `cli.setInput(text, { caret? })` and
  `UiState.caret` (code points; undefined = the end), kept current as the user types. `cli.copy(text)` writes OSC 52
  through the terminal the App attached and shows "Copied N chars" (the transcript's copy uses it; `setCopied` is
  gone). The generic dialog filters its options by typed text when it has no text line; with `multi`, Space ticks
  only while nothing is typed (so filters and text hold spaces), Tab ticks always.
- Config: `saveConfig` replaces `config.json` with a rename (a temp file in `~/.hortus`, mode 0644), so another hortus
  starting never reads half of it; `cli.close()` also waits for the CLI's queued saves (`/theme`, `/effort`), so tests
  close the CLI before restoring `HOME`. `powerline` saves `powerline.json` the same way.
- Core: `ctx.preview` returns a `Preview` (the `RequestEvent` plus `context` and `skills` as `run_start`/`prompt`
  left them). `readSession(path, leafId?, reducers?)` returns a session file's `SessionState` without opening it.
- Record only: overlays stay a non-goal (`powerline`'s welcome replaces the `transcript` slot); the host draws no
  working indicator (plugins draw theirs in `aboveInput`/`statusBar`); `ModelInfo.subscription`, message timestamps and
  per-agent plugin state are listed under "Possible later" in the README.

**As built: the final round's TUI gaps** (found porting `lens`, `plannotator`, `intercom`, `mcp-adapter` and
`cc-extensions`; each port's workaround is gone; tests: `cli/src/tui-api.test.tsx` through `startCli`/`renderApp` in
color, plus the ports' own):
- Statuses (L1/P3): `ctx.status(key, text | { text, color? })`, `color` a theme token name (drawn by the built-in bar,
  default `dim`; resolved at draw time, so `/theme` recolors it); the `status` event carries `color`. A status belongs
  to the ctx's own session, which core sends as the payload's `session` (a run's, or a subrun/session ctx's; none
  from a host ctx, even though a host ctx's `session` getter reports the current one: final review, statuses a plugin
  set from a host ctx kept at init got stuck after `/new`): `UiState.statuses` (now `Record<key, Status { text,
  color? }>`) is the shown session's plus the host-wide ones, kept per session id, so a subrun's or another
  session's never shows, switching back brings a session's back, and host-wide ones stay across switches. `plannotator` dropped its "is this the shown
  session" filter; `lens` colors its LSP state as Pi does (active green, failed red as a second key, inactive dim);
  `powerline`/`cc-extensions` read `.text` (and `cc-extensions` the color).
- `Cli` is an exported interface (`interface Cli extends Awaited<ReturnType<typeof createCli>>`) and `Terminal` is
  exported, so a plugin's inferred `export default { ... } satisfies CliPlugin` with a `cli.keys` using `cli`
  compiles (I1; `intercom` is back to `satisfies`).
- Commands (M1, and the TUI side of `Command.enabled`): `cli.commands` lists `agent.commands()` anew at every read
  (the menu keys loaded candidates by command name, since each listing gives fresh objects), and `Plugin.commands` may
  be a function of the plugin's host ctx, called at every listing. `mcp-adapter` registers a command per MCP prompt as
  Pi does (`/mcp__<server>__<prompt> [args | key=value]`, from servers known live or cached; the first of a name wins),
  replacing `/mcp-prompt`.
- C1: `ToolRenderer.chrome?(view) → ToolChrome { background?: string | false; padding?: boolean }`: what the host
  draws around the block (default: the status background, padded when it has one); an override's fields win, the rest
  come from the renderer it wraps. `cc-extensions`' cards draw their own shell (Pi's `renderShell: "self"`).
- C2: `cli.complete(input, Default, cli, ctx)` (`ctx` the plugin's host ctx); `cc-extensions` lost its module state.
- C3: `entries["tool:**"]` (alias `tools["**"]`) wraps every tool's composed renderer (built-in, the tool's own, or
  the generic one); `cc-extensions` registers its card once there.
- C4: `cli.scroll(rows | "top" | "bottom")` scrolls the built-in transcript ("bottom" follows new output again);
  `cc-extensions`' transcript mode takes ↑/↓, Home/End and g/G.
- C5: the `prompt` slot takes a `prefix` prop (replacing the input's `> `; `composeSlots` hands slot props through to
  the override, which passes them to `Default`), and `useBorderColor()` / `borderColor(busy, effort)` are the box's
  border rule; `cc-extensions`' `❯ ` is a prefix in that color (inside the box, as Pi-cc's).
- C6: a session plugin entry (`appendEntry`) whose type a plugin renders (`cli.entries[type]`) is a transcript entry
  of that kind (`TextEntry.data`, `entryId`): added as it's appended to the shown session (the CLI watches the
  session's leaf), and on resume `replay(messages, shown, branch)` puts it after the message written before it (before
  every message when none; dropped when that message is no longer shown, e.g. compacted away). `createCli` now builds
  the transcript after `agent.setSession` (reducers replayed), still before what loading and `session_open` reported.
  `cc-extensions`' run summary is only its saved entry now.
- C7: a `header` entry kind (an `EntryRenderer`): the transcript's first row on every session, there only when a plugin
  renders it (one drawing nothing takes no rows). Chosen over a slot so it scrolls with the transcript.
  `cc-extensions`' startup header is that renderer.
- C8: `TextEntry.live` (still streaming), and thinking's `startedAt`/`endedAt` (its first delta; the first text or tool
  input after it), also on the live one (`UiState.live.startedAt/endedAt`); replayed thinking has none.
  `cc-extensions`' "Thought for Ns" reads them (no more per-text timing map or thinking handlers).
- C9: `ToolView.siblings` is `ToolSibling { call, result?, details? }[]`: every call of the message in order, itself
  included, renewed in each sibling block when any of them updates or finishes. `cc-extensions`' groups read it
  instead of the store.
- C11: text entries of messages carry `entryId` and `message` (the streamed reply gets them when its `message`
  arrives); `cc-extensions` finds the compaction entry by the summary's `entryId` and parses skills from the message.

**As built: the final review's TUI fixes.** Statuses by the payload's `session` (above). A plugin whose
`commands(ctx)` or a command's `enabled(ctx)` throws is skipped and reported to `onError` once (core's
`agent.commands()`), instead of crashing the prompt that lists commands on every render. On resume, plugin entries
also anchor on the entry a shown message comes from, so those right after a keep-nothing compaction show after its
summary. `cli.scroll("top")` pins only when there is something to scroll; the transcript's `header` entry is a fresh
object per session (its cached copy text is redone); the `/` menu keys loaded candidates by plugin and command name.

## Verification

- [x] **T** a handler resolving synchronously → no CLI dialog, no `attention`; later handlers see `answered` settle.
- [x] **T** race: a handler resolving after 50 ms while the CLI dialog is open → the dialog closes (its `signal`
  aborts), `ctx.ask` returns the handler's answer; answering in the dialog first aborts the handler instead.
- [x] **T** headless (no handler resolves): `ctx.ask` → `undefined`.
- [x] **T** two asks at once → the CLI shows them one after the other; remote handlers see both immediately.
- [x] **T** abort while an `ask` is pending → `undefined`, the tool finishes.
- [x] **T** `secret: true`: the typed text renders masked and appears in no transcript entry or session line.
- [x] **T** `multi` and `allowText` dialogs return arrays / free text.
- [x] **T** `cli.asks[kind]` renders for its kind; an unknown kind falls back to the generic dialog.
- [x] **T** a core plugin command runs from the `/` menu with a host ctx and can `ask`, `send`; `agent.commands()` lists
  it; a command submitted while busy runs, a plain prompt while busy is refused.
- [x] **T** a plugin command is testable through `agent.commands()` with the harness (`tempHome` + `createAgent`), no
  `Cli` needed (`anthropic-auth`'s test then drops its `{ agent } as unknown as Cli` stand-in).
- [x] **T** `ctx.host` is `tui` + interactive in the CLI, `headless` + not interactive in phase 8. (Headless is the
  default host until phase 8's mode exists: `ask.test.ts` checks it.)
- [x] **T** `ctx.exit()` exits through `session_close("exit")` and `close`.
- [x] **T** (`ui.test.tsx`) `status` events update `UiState.statuses`; `notify` adds an info/warn/error line.
- [x] **T** (`ui.test.tsx`) a `prompt` override that doesn't render `Default` receives Esc (and the run isn't
  aborted); with `Default` rendered, Esc aborts as before.
- [x] **T** `aboveInput` and `transcript` overrides compose in load order and a throwing one falls back via `Guard`.
- [x] **T** `cli.suspend` restores the alternate screen and raw mode after `fn` (also when it throws).
- [x] **T** `cli.setInput` changes the prompt text; submitting clears it.
- [x] **T** `cli.entries.thinking`/`assistant`/`user` overrides render; a `meta` message renders through its `<plugin>:<type>` key,
  `display: false` hides it; `tool:*` renders an MCP tool's call; `cli.push` adds a UI-only entry that is not saved.
- [x] **T** Ctrl+O flips `expanded` for every tool block; `partial` reaches a renderer while input streams; a renderer
  returning nothing for grouped siblings leaves no empty rows.
- [x] **T** two theme packs register 3 themes; `config.theme` picks one; `/theme <name>` switches live; no color
  literal remains outside theme definitions (`grep -n "#[0-9a-fA-F]\{6\}" packages/cli/src/*.tsx`).
- [x] **T** a `cli.complete` wrapper adds `@file` candidates and keeps `/` command candidates from `Default`.
- [x] **R** `ask-user`: the tool's `execute` awaits `ctx.ask`; the test answers via the rendered prompt slot; the model
  sees the answer.
- [x] **R** `guard`: "ask before `write`" → denied answer blocks the call; no UI → blocked.
- [x] **R** `todo`: the `aboveInput` panel shows the list from `useSession(s => s.data[...])`.
- [x] **R** `goal`: `cli.entries["goal:prompt"]` / `["goal:contract"]` render its prompts (today invisible in the CLI;
  Pi shows them as user messages).
- [x] **R** `remote`: answers an `ask` while the CLI dialog is open, closing it.
- [x] **M** `pnpm dev`: the ask dialog takes keyboard focus; Esc dismisses it without aborting the run; Ctrl+D still
  exits; `/theme` switches colors live. (Verified by driving the real CLI in a pty with a temp HOME and a scripted
  provider: Esc during a running turn dismissed the ask and the turn finished without "Interrupted", `/theme` switched
  the colors live, Ctrl+D exited; `config.json`'s theme colored the first frame.)
- [x] **T** (port gaps) `startCli` loads the `cli:*` pieces (`/theme` runs) and `renderApp(cli, { colors })` draws
  colors without `FORCE_COLOR` (`hooks.test.tsx`, `themes.test.tsx`, the `themes`/`decide`/`powerline` tests).
- [x] **T** (port gaps) a partial theme merges over `dark`, roles fall back to its own generic tokens, plugin tokens are
  kept; `mdHeading` colors a heading and `thinkingHigh` the prompt border at effort high; the themes pack maps Pi's
  role tokens.
- [x] **T** (port gaps) `ctx.ask(req, { detailed: true })` reports `value`, `by` and `reason` (answered, dismissed,
  timeout, aborted, unanswered); `shown`/`engaged` settle on `show()`/`engage()`; `decide`'s countdown runs from
  `shown` and stops on `engaged`; `remote`'s `/engage` engages.
- [x] **T** (port gaps) `CompleteRequest.signal` aborts a call.
- [x] **T** (port gaps) `cli.keys` takes keys before the prompt (a taken Esc doesn't abort; `powerline` takes back a
  held steer with Esc mid-run); `cli.submit` wrappers send while busy; `cli.setInput(text, { caret })` places the
  caret and `UiState.caret` follows typing; `cli.copy` writes OSC 52; the generic dialog filters by typed text and
  engages on its first key.
- [x] **T** (port gaps) `ctx.preview` returns `context`/`skills`; `readSession` reads a session file's state.
- [x] **T** (review) `saveConfig` is atomic (readers racing saves always parse it; mode 0644; no temp file left); a
  selection is drawn on `selectedBg`, or inverted when that's the background under it or ""; a handler reading
  `shown` still keeps the ask open and may answer; a `multi` dialog's filter holds spaces and Tab ticks.
- [x] **T** (final review) a host ctx's status is host-wide (updated and cleared across `/new`), a run's stays with
  its session; a throwing `commands(ctx)`/`enabled(ctx)` is skipped and reported once; plugin entries after a
  keep-nothing compaction replay; `scroll("top")` with everything fitting doesn't pin; a replaced same-named command
  doesn't show the old one's candidates.
