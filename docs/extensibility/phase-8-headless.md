# Phase 8 — headless and RPC modes

For work that outlives the UI (background subagents, spawned children, scripts) and for other frontends (chat
gateways, web cockpits, editors) that drive hortus as a process.

## Changes

- **Flags mirror `subrun` options** and work in every mode, interactive included: `--model <provider>/<model>`,
  `--effort`, `--session <uuid|new|memory>`, `--name`, `--cwd`, `--append-system <text>`, `--disable <plugin,...>`,
  `--only <plugin,...>`, `--plugin <path>` (an extra plugin, like `LoadOptions.extra`), `--tools <name,...>`, and a
  positional initial prompt.
- `hortus -p <prompt>`: runs one prompt without the TUI and exits; `--json` streams every event as one JSON line
  (`{ event, payload, run }`) on stdout; the final answer is the last `message`.
- `hortus --rpc`: long-lived. Reads JSON lines on stdin — `prompt { text, deliver? }`, `abort`, `answer { askId,
  answer }`, `engage { askId }`, `command { name, arg }`, `set_session { session }`, `exit` — and writes every
  event (asks included, with ids) as JSON lines on stdout. The RPC host is one more `ask` handler, so remote answers
  race like any other: it calls the ask's `show()` when it writes the ask line (so `shown`-waiters such as `decide`'s
  countdown start), `engage()` on `engage { askId }` (a client's user started answering), and stays pending until
  the ask is answered or its `signal` aborts.
- `ctx.host`: `-p` is `{ kind: "headless", interactive: false }` (`ask` resolves `undefined`: no handler shows it, so
  `shown`-waiters don't hold it open). `--rpc` is `{ kind: "rpc", interactive: true }` while a client is attached
  (stdin open), so plugins that only ask an interactive host (`decide`: `interactive: false` reads as nobody to ask)
  ask over RPC; once stdin closes it is `interactive: false` and its `ask` handler settles without answering. When a
  client attaches (and `interactive` turns true) the RPC host fires the `interactive` event (phase 5's port gaps), as
  the TUI does once it can show asks, so questions held back at startup (`mcp-extension`'s project trust) are asked.
  `notify`/`status` go to stderr (or JSON lines). Throwing handlers and other runtime `onError` reports (core's default
  already prints them to stderr) go to stderr in `-p`, and as JSON lines (`{ error, plugin }`) in `--json`/`--rpc`.
- Exit code: 0 on a finished run, 1 on error, 130 on SIGINT (which aborts the run gracefully: `run_end`, saved
  messages, `session_close("exit")`, `close`).

**As built (deviations and details the plan left open).**
- `cli/src/flags.ts`: `parseFlags` (`node:util` `parseArgs`), `flaggedSession`, `applyFlags` (model/effort/name/cwd are
  written to the session, as `/model`, `/effort` and a `name`/`cwd` entry would be, so the TUI, `-p` and `--rpc` all
  start from the session), `flagOptions`. `--session` defaults to `new`; `-r [id]` stays (TUI only: a usage error with `--session`,
  `-p` or `--rpc`). `--effort auto` clears the session's effort. `--cwd` also `chdir`s the process (MCP configs and anything else reading the process's cwd agree).
  `--plugin <file>` is a module path (not a plugin dir), loaded as `extra` named by its absolute path; repeatable.
  `--tools` and `--append-system` are the `extra` plugin `cli:flags` (a `run_start` keeping only those tools, children
  included; a `prompt` part), so they use nothing a plugin can't. `-p` needs a positional prompt (no stdin reading).
- `--only` is new core API: `LoadOptions.only` (in `loadPlugins`), the same rule as a subrun's `plugins.only`: the
  other plugins keep only their providers (so `--only builtin:read` still has builtin:anthropic, or a test's
  `scripted` dir plugin); `extra` ones all stay. `--disable` is `LoadOptions.disabled` (hard: a required dependency on
  it throws, its providers go too).
- `-p` and `--rpc` send plugins' `console.log`/`info`/`debug` to stderr (`index.tsx`, before any plugin loads), so
  stdout stays the answer or JSON lines.
- `-p` (`headless.ts` `printMode`): sends queued after the run (`deliver: "after"`, `goal`-style loops) are started
  through its `onWake` with the same SIGINT-aborted signal, and it waits until none is left (not for `idle`, which
  never fires when an `input` handler takes the queued send); prints the session's last assistant text. `--json` lines are
  `{ event, payload, run }` with `run` the full `RunInfo` (absent outside runs: `init`, `ready`, `session_open`, ...);
  payloads are serialized with errors as `{ name, message }`, sessions as `{ id, path? }`, functions, signals and
  promises dropped (an unserializable payload: `{ event, run, unserializable: true }`). Exit 1 also for an abort that
  is neither the user's nor `ctx.exit()`'s. A second SIGINT exits at once.
- `--rpc` (`rpcMode`): commands are `{ type: "prompt" | "abort" | ... , ...fields }`. `prompt` without `deliver` is
  `agent.run` (queued after a running run), with one `agent.ctx.send(..., { deliver, source: "user" })` (`deliver`
  validated). Any command may carry an `id`; a command's reply is one line `{ response: <its type>, id?, ... }`:
  `{ response: "command", id?, name, text? }`, `{ response: "set_session", id?, session, ok }` (`set_session
  { session: <id> | "new" | "memory" | "key:<key>" }`, opened as reason "new" when nothing was written to it yet, else
  "resume"); a failed command's is `{ response, id?, error: { name, message } }` (`name` too for `command`). Bare
  `{ error: <message>, plugin? }` lines are errors no command asked for: handler reports `{ error, plugin }`, an
  unparsable line `{ error: "Not JSON" }` (not echoed), a non-object `{ error: "Not a command object" }`. Asks are written as
  `{ event: "ask", payload: { askId, ...request } }` and followed by `{ event: "answered", payload: { askId, by?,
  reason, answer? } }` (no answer for a `secret` ask). Runs it starts (and plugins' sends, through its `onWake`) take
  an `AbortController` each, so `abort` reports `by: "user"`. `host.interactive` turns true (and `interactive` fires)
  once the agent is up and its session set; when stdin closes it turns false, the pending asks are let go, and the
  process exits 0 once its runs are done. A positional
  prompt is run as the first `prompt`.
- Testing: core `scriptedPlugin(turnsSource)` (a `scripted` directory plugin's files, imported by URL so it loads
  in-process too) and `@hortus/cli/testing`'s `hortusBin` / `spawnHortus(t, args)`.
- Reference plugins: `subagent { task, cwd?, background? }`: with `background` it spawns `hortus -p --json --session
  memory --disable subagent --tools read --cwd <dir> --model <caller's> [--effort] <task>` (`@hortus/cli`'s
  `dist/index.js`: `hortusBin`, the host's own through its hook), returns at once, and delivers
  the child's last top-level assistant `message` (or its error lines) as a `subagent:result` message with
  `send({ deliver: "after" })`; children still running are killed in `close` and on process `exit`; its spawn env adds `ctx.env`. Only on an
  interactive host (`ctx.host.interactive`): under `-p` (or `--rpc` once stdin closed) the parent may exit before the
  result arrives, so it runs in the foreground there.
  `remote` is unchanged: `remote/src/rpc.test.ts` runs it inside `hortus --rpc`, where a stdin client and remote's
  HTTP clients race for the same ask.
- Earlier deferrals finished: `langsmith` nests top-level runs under an embedder's run, `parent` in its config
  (`LANGSMITH_HORTUS_TRACE`, else `LANGSMITH_TRACE`: a dotted order, LangSmith's `langsmith-trace` header value), and
  wraps `bash` and `subagent` (optional) to pass the tool run's dotted order as `LANGSMITH_HORTUS_TRACE`, so a `hortus
  -p` they start (a background subagent included) nests under that tool run. `pi-subagents`-style background runners:
  `subagent --background`. Phase 7 leftover: a child woken while its `session_closed("child")` handlers still run stays
  armed (`Child.rearmed`) and is closed again after that run (`subrun.test.ts`).

- **Port gaps** (found porting Pi's session-hub, background-tasks and kxm into `examples/plugins/`; each port and
  `subagent` now use the API below instead of a workaround):
  1. `hortusBin` (`@hortus/cli`, also re-exported by `@hortus/cli/testing`): the path of `dist/index.js`, through the
     host's resolve hook the running host's own; plugins spawn `process.execPath, [hortusBin, ...]`. (`subagent`
     imports it dynamically, only for `background`, so the foreground tool needs no CLI.)
  2. `session_close` and `session_closed` carry `target` (the `Session` being switched to) on "new"/"resume".
     session-hub's copy of `cli:resume` is gone. A wrap form for commands (`Default` like tool wraps) was not added:
     `target` removes the only need found; commands still replace by name.
  3. RPC `prompt { id? }`: when the run it started (or, with `deliver`, the run it joined) ends, `{ response: "prompt",
     id?, ...run_end }` is written (a failed run or send: `{ response: "prompt", id?, error: { name, message } }`, the only line it
     writes; a `context` send appended while idle: no run fields). session-hub matches replies by id.
  4. `--seed <file.json>` (a `Message[]`): appended to the session by `applyFlags` (every mode) before anything runs;
     only to a session without messages (else "--seed needs a new or empty session": restarts don't duplicate it).
     background-tasks' `bg_delegate` seeds the child with the projection as messages (a temp file removed when the task
     ends) and sends only the directive.
  5. `--session key:<key>` (also `set_session`, `-p`, the TUI): the session whose id is `keyedId(key)` (a uuid-shaped
     sha256 of the key; core's `newSession(dir?, id?)` takes the id), created when missing, so renaming it keeps the
     link. kxm opens `key:kxm:<project>:<worker>:<scope>`.
  6. `-p` without a prompt runs on the session when it has something to answer: its last message a user message,
     tool results or an assistant's unanswered tool calls (else exit 1: "-p needs a prompt, or a session with
     something to answer ...", checked before `applyFlags` writes anything, so a refused start creates no session).
     `applyFlags` writes model/effort/name/cwd only when they change. kxm restarts a request whose user message an
     earlier attempt saved (a top-level `message` line) without sending it again.
  7. `MessageMeta.display?: boolean`: `true` shows a plugin message with the built-in plugin-message look when no
     plugin renders its kind (`false` still hides it; unset: shown only when rendered). kxm's pass-through renderer
     is gone (its inbound requests are `display: true`), and kxm no longer imports `@hortus/cli` but for `hortusBin`.
  8. `builtin:name` (core piece): `/name <title>` sets the current session's name (no title: shows it), on any host;
     over RPC it is `command { name: "name", arg }` (no separate `set_name`).
     Recorded, not changed: (9) entry renderer keys such as `"background-tasks:notification"` are fixed in code while
     the message's kind is `${ctx.plugin}:<type>`, so a plugin installed under another name loses its renderers (goal,
     workflows too); (10) under `-p`, background-tasks' notifications that arrive after the run (and its queued sends)
     have ended are lost when the process exits, as in Pi.; (11) keyed sessions (kxm's workers') are listed by `/resume` and `-r` like any
     other.

**As built: final round (B2/A2, S4).**
- `--parent <session id>` (`-p`/`--rpc` only): the process's sessions are that session's children: `--session`
  (`new`, an id, `key:<key>`) and RPC `set_session` resolve in `childDir(parent)` (`flaggedSession(session, parent)`),
  so `/resume` and `-r` don't list them and `listSessions({ parent })` does; `LoadOptions.parent` makes every top-level
  run a child: `ctx.run.depth` one more than the parent session's place in the tree (`sessionLineage(id)`: 0 for a
  top-level file, +1 per child dir; a session without a file counts as top-level), `parent: { session }`, `root` the
  tree's root. A spawner tells the child's own runs from its subruns by `run.parent.session === <its session>`.
  billion-context (delegates; its `BILI_*` env lineage is gone), background-tasks (`bg_delegate`), pi-subagents
  (background runs; nesting depth from `ctx.run.depth`, the env keeps only `maxDepth`/`allowedAgents`) and subagent
  pass it. kxm's workers keep top-level keyed sessions: a worker serves the hub, not a conversation, and outlives
  `/new` (recorded, not changed).
- subagent's background children run `hortus --rpc` (the task as `prompt { id: "task" }`, stdin closed once its reply
  arrives): each `ask` line goes to the parent's `ctx.ask` (the TUI's dialog) and the answer back as `answer`, as
  pi-subagents relays its supervisor questions; the result is the reply's `run_end`. Each relayed ask carries an
  `AbortSignal` (`ctx.ask(req, { signal })`), aborted when the child's `answered` line for it arrives (the child
  settled it itself, e.g. an autopilot) or the child exits, so the parent's dialog goes away (final review).

## Verification

- [x] **T** spawning `node dist/index.js -p` with the phase 0 harness (scripted provider via a plugin in `tempHome`):
  prints the answer, exit 0.
- [x] **T** `--json` emits the phase 2 event order as JSON lines, each with `run.id`.
- [x] **T** `--session <uuid>` continues that session; `--session memory` writes no file; `--disable builtin:bash` and
  `--tools read` restrict the tools; `--plugin <path>` loads that plugin last; `--name` titles the session.
- [x] **T** the same flags apply in interactive mode (CLI starts on the given session/model, initial prompt submitted).
  (`cli/src/headless.test.ts`, through `parseFlags`/`flaggedSession`/`applyFlags`/`flagOptions` and `startCli`, the
  path `index.tsx` takes; the TUI binary itself isn't spawned. The other T items: `headless.test.ts` spawning
  `dist/index.js`; guard: `examples/plugins/guard/src/headless.test.ts`.)
- [x] **T** a tool calling `ctx.ask` under `-p` gets `undefined` (the `guard` plugin blocks instead of hanging).
- [x] **T** `--rpc`: `prompt` → events on stdout; an `ask` event's id answered via `answer` resolves the tool (writing
  it settles `shown`, `engage` settles `engaged`; `ctx.host.interactive` is true while stdin is open);
  `abort` aborts; `command` runs a plugin command; `set_session new` fires `session_close`/`session_open`.
- [x] **T** SIGINT → exit 130, `run_end.aborted.by = "user"` and `close` fired, completed messages saved.
- [x] **R** `subagent --background`: spawns `hortus --rpc --parent <session> --session memory --disable subagent`,
  relays its ask to the parent's ask handlers, and the parent later receives the result via
  `send({ deliver: "after" })`.
- [x] **T** (final review) an ask the background child settles itself is withdrawn from the parent's handlers.
- [x] **T** (final) `-p --parent`: the session (keyed too) is among the parent's children, not listed at the top, and
  its runs carry `depth`/`parent`/`root` (`headless.test.ts`); billion-context's and pi-subagents' child sessions
  are the parent's children.
- [x] **R** `remote` over `--rpc`: a test client drives a full turn and answers an ask from stdin.
- [x] **T** port gaps: `hortusBin` used by every port and `subagent`; `session_close`/`session_closed.target`
  (`core/src/subrun.test.ts`; session-hub's resume test); RPC `prompt { id }` replies, `/name` over RPC, `--seed`,
  `--session key:<key>`, `-p` without a prompt (also after a tool round; refused before flags write), `--seed` refused
  on a session with messages, one reply with its id for a failed RPC command (`cli/src/headless.test.ts`; background-tasks' and kxm's tests);
  `display: true` (`cli/src/ui.test.tsx`); `/name` (`core/src/ask.test.ts`).
