# Phase 3 — core owns the session; entries; plugin messages

## Changes

**Sessions in core.** `agent.setSession(s)` / `agent.session()` hold the _current_ session (the CLI's `setSession`,
`/new` and `/resume` call it); `run(opts)` runs on it by default, and `run({ session })` runs on any other (embedders
serving several conversations share one agent: plugins and MCP load once). Runs append each message as it completes;
the CLI's `turn` becomes display-only. A run's `ctx.session` is its session; the host ctx's is the current one.

**Lifecycle.** Events `init` (once, after load), `session_open { session, reason: "start" | "new" | "resume" }`,
`session_close { session, reason: "new" | "resume" | "exit", cancel? }` (`cancel` vetoes `new`/`resume`, not `exit`),
`close` (once, at exit). Exit awaits `session_close` + `close` with a timeout (default 3 s) after the aborted run's
`run_end`. All get the host ctx (phase 2). `close` is where plugins flush and drop per-run state kept in module maps
keyed by run id (a run cut off by exit never reaches its own `run_end` cleanup): `tracer` and `otel` export the spans
of runs still open, then clear their maps.

**Entries.** `Plugin.entries?: Record<string, (entry, state) => void>`; types are stored as `<plugin>:<type>`. A
plugin that `replaces` another also replays the replaced plugin's entry types (it inherits its prefix), so swapping
an implementation doesn't strand old sessions. Messages in `run_start.messages` and `request.messages` carry
`entryId?` (providers strip it), so plugins can map them back to the session. `SessionState.data: Record<string,
unknown>` holds plugin state rebuilt by replay. `Session.appendEntry(type, data)`. `ctx.session` exposes the branch's
entries with ids. Effort moves into the `model` entry beside model and provider (`config.json` effort stays the
default). A core `name` entry titles the session; `/resume` and `listSessions` show it.

**Messages.** User messages gain `images?: Image[]` and
`meta?: { plugin: string; type: string; details?: unknown; display?: false }`: plugin messages the model sees; the
CLI renders them through `cli.entries` (phase 4) or hides them.

**Sending.** `ctx.send(msg, { deliver?, model?, provider?, effort?, source? }) → Promise<RunEnd | undefined>`:

| `deliver`             | During a run                                                                     | When idle                      |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------------ |
| `"context"` (default) | appended at the next turn boundary; never forces a model call                    | appended; the next run sees it |
| `"steer"`             | appended at the next turn boundary; the loop continues even after a final answer | starts a run                   |
| `"after"`             | queued; starts a run after this one ends                                         | starts a run                   |
- Called from a run's own `input`/`run_start`/`prompt`: appended before its first request, whatever `deliver` says.
  Sent from elsewhere to a run that is still starting: waits for its first turn boundary (`"after"`: its end).
- Called from a `turn_end` handler: applies at that same `turn_end` (`"steer"` there keeps the run going).
- Called from `run_end`, or a `turn_end` that stops: treated as idle. `run_end` also fires for `ctx.preview()`
  (`source: "preview"`, phase 2): continuation logic checks `source === "run"`, and `send` from a preview's ctx
  (its `run_start`/`prompt`/`request`/`run_end` handlers) never starts a run (`"steer"`/`"after"` act like
  `"context"`), or every context viewer's preview would.
- `model`/`provider`/`effort` apply to the run it starts only. The Promise resolves with that run's `run_end` payload
  (`undefined` for `"context"`, and for `"steer"`/`"after"` sent from the run's own ctx: that run, or one queued
  behind it, can't end while a tool or awaited handler of it waits). The host starts runs through `LoadOptions.onWake` (the CLI queues them like submits).
- After `close`, `send` throws.

`run_start`/`request` edits are never persisted; persisting goes through `send`.

**Input.** Event `input { text, images?, source: "user" | <plugin> | string, handled }`, before every run started from
text: CLI submit, and `send` that starts a run (with its `source`: voice, chat bridges). `handled = true` → no run.

**Idle.** Event `idle`, fired when a run (`source: "run"`, never a preview) ends and nothing is queued to start another. "Done" notifications and busy
indicators use it instead of `run_end`.

**Usage.** `ToolResult.usage?`, added to the session's totals.

**As built (deviations and details the plan left open).**
- `run(input?: string | UserInput, opts)` replaces `run(history, opts)`: the history is the session's messages
  (`opts.session`, else the current one, else a fresh `memorySession()` — so embedders and tests without a session
  still run, each run on its own history). With `input`, `input` fires and the user message is added; `run` resolves
  `undefined` when a handler set `handled`. Model and provider default to the session's state, effort to the
  session's unless `effort` is a key of the options (the CLI passes `runEffort`, where `undefined` means "provider
  default"). `RunOptions.source` is `input.source` (default "user").
- `message` now fires for every message a run adds, user ones included (the input, sends), so the CLI draws user
  entries from it (plugins' sends show up; `meta` ones are hidden until phase 4). One run is
  `input → message → skills → run_start → prompt → … → run_end → idle`. An idle `"context"` send fires `message`
  with the host ctx.
- `entryId` is set on messages in session state and run histories (so in `run_start.messages`, `request.messages`,
  `message`, `turn_end`, `run_end`); the file stores messages without it. Providers rebuild user messages (images
  first, then the text; `meta`/`entryId` dropped), so no request carries it; `scripted` records requests without it.
- Plugin entries: `session.appendEntry("<plugin>:<type>", data)` takes the full type (the plugin names its own
  prefix; reducers only see their own prefixes, which is what keeps two plugins' `"state"` apart). The agent builds
  `Reducers` from `Plugin.entries` (own name and every `replaces` name; a throwing reducer goes to `onError`) and
  `session.replay(reducers)` re-replays a session's branch with them; `setSession` and `run` call it, so sessions
  opened before the agent (the CLI's first, `/new`, `/resume`) need no agent-specific `openSession`.
  `Session.path` is optional (`memorySession()`, which phase 6's `"memory"` can use); `append` resolves with the saved
  messages (`entryId` set); writes are serialized per session.
- Sends: `deliver` is resolved against the ctx's run (a handler's or tool's), else the session's running run, else
  idle. A `"context"` send during a run resolves at once, and so does a `"steer"`/`"after"` from the run's own ctx
  (with `undefined`; awaiting the run it steers or the one queued behind it from a tool would deadlock); from
  elsewhere a `"steer"` delivered at a boundary resolves with that run's `run_end`. Only the run's own sends join it
  before its first request; others' wait for its first boundary (when an `input` handler takes the run, they act as
  when idle). "A `turn_end` that stops" = one aborted, or whose `stop` a handler set while tools still
  ran: its sends (and any that missed the last boundary) act as when idle after `run_end`: context appended, steer and
  after queued. Per session, runs queued by sends start one at a time (`LoadOptions.onWake(start)`: the host calls
  `start(hostOpts)`, and is told the session: the CLI queues the shown session's like submits and starts others' at
  once, without its busy state or the prompt's effort; send's model/provider/effort win); `idle` fires when a run ends
  with none queued or waking, after the run has settled (so `run` resolves first, and an idle handler may await a
  run it starts without deadlocking a host that wakes runs only once the last has ended), with a host ctx on that
  session (its sends go there, not to the current session). Known gap: a `"steer"` from outside between a run's end
  and a queued run's start (while the host holds its `onWake`) has no run to steer, so it queues a run of its own.
  Preview sends: before its request they join the preview's request only (a preview persists nothing); later
  (`run_end`) they are `"context"` on its session.
- `setSession(session, reason)` returns false when a `session_close` handler cancelled; `/new` and `/resume` then say
  "A plugin kept the current session". The CLI's `setSession` is now async.
- Exit: `agent.close({ timeout = 3000 })` aborts runs (`aborted: { by: "host", reason: "exit" }`), waits for them up to
  the timeout, then runs `session_close("exit")` + `close` up to the timeout again (so at most twice it), then stops
  MCP. Sends queued behind the aborted runs start nothing and resolve with `undefined`; no `idle` fires once closed.
- **One run per session at a time.** A run on a session that has one (`run()`, a send's wake) waits for it to end
  (a second at once would see the first's calls in flight as unanswered, and each run the other's messages), so a
  run's history is exactly its session's messages: the run never keeps its own copy; `run_start.messages`, each
  request (a `response.retry` too) and `run_end.messages` are the session's messages as they are then. So an entry
  persisted mid-run whose reducer rewrites `state.messages` (phase 7's compaction) applies from the next request, and
  a send made without awaiting it shows once. A lane counts a run from its call until after its leftover sends are
  queued, so a send in between queues behind it instead of starting a second run. (A subrun on its parent's own
  session, awaited by the parent's tool, would wait forever: phase 6's children use their own sessions.)
- Unanswered calls: each request (runs, previews, `ctx.complete`), after its `request` handlers, answers every model-run call that no `tool`
  message right after its assistant message answers (a crash or kill mid-tool, wherever user messages landed after
  it: an idle send, an `input` handler's) with `{ output: "Interrupted", isError: true }`, merged into that `tool`
  message or as a new one, as providers reject unanswered calls. Only the request: the session file is left as it is
  (a resumed transcript shows no block for such a call). The CLI's `close` is `agent.close` (no `turn` to save any
  more: the CLI's `UiState.turn` is gone).
- The CLI draws only events whose `ctx.session` is the shown session (runs on other sessions, e.g. an embedder's,
  stay out of the transcript); the `message` of a send appended outside a run has that session as `ctx.session`. The
  CLI's effort follows the shown session's (`setEffort` from a plugin too), else `config.json`'s.
- Effort: the `model` entry holds `effort`; `/effort` saves it to the session and to `config.json`, whose value is the
  effort of sessions that have none. `Session.setEffort`/`setName`; a `name` entry is `SessionInfo.title` (else the
  first user message), which `/resume` and the session picker show. No command sets a name yet (phase 8's `--name`).
- `ToolResult.usage` is summed by `usageLine` (the status line), provider-run calls' results included; the context
  fill still comes from the last reply.
- `@hortus/cli/testing` exports `createCli`, so a plugin test can drive the CLI (`remote` does).
- Earlier deferrals finished: `plan-mode` stores its mode as `plan-mode:mode` entries (per branch, resumed);
  `deferred-context` keeps session promotions, demotions and `/deferred unblock` as `deferred-context:state` entries
  instead of module sets; `tracer`/`otel` export runs still open in `close` (their open spans ended then; `exit` marked)
  and clear their maps (`openRuns()`); `rtk-optimizer` loads its config in `init` and `session_open` (Pi's
  session_start) instead of every `run_start` (its state stays module-wide; metrics stay process-wide).
- Reference plugins: `todo` (a `todo` tool saving the whole list as `todo:list`; `items(state)` reads
  `state.data.todo`; phase 4 adds its `aboveInput` panel) and `remote` (a local HTTP server started in `init`: address
  and a fresh bearer token in `~/.hortus/remote-<pid>.json` (0600, removed in `close`; one per process, so two hortus
  processes don't clobber each other's, and clients pick one of `remote-*.json`), `POST /send { text, deliver? }`
  sends through the init ctx (default steer, `source: "remote"`), `GET /events` streams events as SSE; phase 4 adds
  answering `ask`, phase 8 the same over `--rpc`).
- **Gaps the phase 3 ports found** (`langsmith`, `goal`, `hashline-edit`; workarounds removed):
  1. `RunInfo.info: ModelInfo`: the provider's `info` for the run's model, from the agent's per-provider/model cache
     (the one `maxTokens` uses; `{}` when unknown), set before `run_start` and again after it changes the model.
     `langsmith` reports `context_usage { tokens, contextWindow, percent }`; `hashline-edit` sizes auto-read-all as
     Pi does (1.5 bytes per context token, 200 KB to 2 MB). No `ctx.modelInfo(provider, model)`: nothing needs another
     model's yet.
  2. Event `turn_start { index }` (from 0) before each turn's first request (runs only, not previews); `langsmith` and
     `otel` open their turn spans there instead of guessing from the first `request` after `turn_end`. (`tracer`
     never inferred turns: nothing to migrate.)
  3. Outside a run, `ctx.abort`/`ctx.busy` cover the runs on the ctx's session (the host ctx's current one, `idle`'s
     own), every run only when it has none; a run's ctx still aborts just its run; exit (`agent.close`) aborts every
     run. `goal` pauses with `ctx.abort` instead of keeping each run's ctx. The CLI's Esc is unchanged (its own run's
     signal).
  4. `input.meta`: the sent message's `meta`, editable like `text`/`images`. `goal` sends its prompts as `goal:prompt`
     meta messages (`details.goalId`) and checks that at `input`, not a `<goal_id>` tag in the text (so the CLI hides
     them until phase 4 renders them as `cli.entries["goal:prompt"]` / `["goal:contract"]`).
  5. `RunInfo.source`: `input.source` / `RunOptions.source` (default "user"); `goal` reads `ctx.run.source` instead of
     keeping each session's `input.source`.
  6. No new API: `Session.appendEntry` is documented (and tested) to run its reducer before it returns, so a state read
     and the append computed from it with no `await` between are atomic; `hashline-edit`'s `commit` relies on that.
  7. `ToolRenderer.text?(view, Default)`: `Default` is the replaced renderer's text, so `hashline-edit`'s `read`
     wrapper copies `Default(readView(view))` instead of falling back to `renderToString` (phase 4's `cli.entries`
     keeps this shape).

Phase 7's ports added (see its As built): `session_closed` (after an uncancelled `session_close`, and for a done
subrun's session), `Session.allEntries()`, `PluginEntry<T>` for reducers (which also get the plugin's loaded name) and
`ctx.plugin`. Phase 8's ports added `target` (the session switched to) to `session_close`/`session_closed` on
"new"/"resume", `MessageMeta.display: true` (shown without a renderer) and `newSession(dir?, id?)` (see its As built).

Final round (P4): `appendEntry(type, data)` passes `data` through JSON before the reducer runs, so a reducer sees live
exactly what it sees on replay (undefined fields gone, Dates as strings), never the caller's object.

## Verification

- [x] **T** `session.test.ts`: a plugin entry type is replayed into `state.data`; branching from before it drops it;
  a file with entries of an absent plugin replays without them.
- [x] **T** entry types are namespaced: two plugins using `"state"` don't collide.
- [x] **T** a plugin with `replaces: ["x"]` replays sessions containing `x:*` entries.
- [x] **T** `request.messages[i].entryId` matches the session entry; no provider request contains `entryId`.
- [x] **T** `run` appends messages as they complete: kill the run after the first tool result and the file has it.
- [x] **T** two concurrent `run({ session })` on different sessions keep their messages apart and load plugins once;
  two on one session run one after the other (`send.test.ts`).
- [x] **T** `/new` and `/resume` fire `session_close` then `session_open` with the right reasons; `cancel` on
  `session_close("new")` keeps the current session; `cancel` on `exit` is ignored.
- [x] **T** exit fires `run_end` (aborted), then `session_close("exit")`, then `close`; a `close` that hangs is cut
  off by the timeout.
- [x] **T** effort is per branch: set on one branch, resume another → the other's effort (`session.test.ts`:
  branching from before a `setEffort` gets the earlier effort).
- [x] **T** a `name` entry shows in `listSessions` and the `/resume` candidates.
- [x] **T** `send` from `run_start` → in the first request and saved before the user's reply.
- [x] **T** `send({ deliver: "context" })` during the final turn → no extra model call; the next run's first request
  contains it.
- [x] **T** `send({ deliver: "steer" })` in the final `turn_end` → one more model call in the same run.
- [x] **T** `send({ deliver: "after" })` during a run → a second run starts after `run_end`; `idle` fires once, after it.
- [x] **T** `send` from `run_end` with `"steer"` starts a run (goal-loop continuation) and doesn't fire `idle` between.
- [x] **T** a `run_end` handler that sends `"steer"` from a `ctx.preview()` starts no run, and a preview fires no `idle`.
- [x] **T** `send({ deliver: "steer", model: "m2" })` when idle runs on `m2`, resolves with its `run_end`, and the
  next plain run is back on the session's model.
- [x] **T** a host ctx captured in `init` and used from a `setTimeout` after two runs targets the current session
  (after `/new`, the new one); after `close`, `send` throws.
- [x] **T** `input.handled` stops the run; `input` rewriting `text` changes the saved user message; a starting `send`
  fires `input` with its `source`.
- [x] **T** user message `images` reach each provider's request; `meta` messages are sent to the model as text.
- [x] **T** `ToolResult.usage` is added to the totals the status line shows.
- [x] **R** `todo`: the tool writes entries; resuming the session and branching restore the list in `state.data`.
- [x] **R** `remote`: from a timer outside any run, `send({ deliver: "steer" })` starts a turn in the CLI; its events
  reach the plugin.
- [x] **R** `tracer`/`otel`: a run still open at exit is flushed in `close` (its spans exported, ended at exit) and
  their per-run maps are empty afterwards.
- [x] **R** `plan-mode` (persistence): `/plan` stores the mode as an entry; resuming the session keeps it on.
- [x] **M** `pnpm dev`: Ctrl+D during a run exits within the timeout and the session file has the completed messages.
  (Verified in a pty: `node packages/cli/dist/index.js` (the `pnpm dev` binary) under a temp `HOME` with a scripted provider plugin in `~/.hortus/plugins`, no real keys; the model called `read`, then its next request never settled and ignored the
  abort; Ctrl+D exited after 3.0 s, and the session file held `user`, `assistant` (the call) and `tool` (the file's
  text).)
- [x] **T** gaps: `ctx.run.info`/`ctx.run.source` and `turn_start` indexes (`send.test.ts`); `input.meta` reaches the
  handler and the saved message; a host ctx's `abort`/`busy` cover only its session's runs; `appendEntry`'s reducer
  runs before it returns (`session.test.ts`); a wrapper's `text` gets `Default` (`app.test.tsx`).
- [x] **R** gaps: `langsmith` (turns from `turn_start`, `context_usage` with the window), `otel` (turns from
  `turn_start`), `goal` (meta-tagged prompts, `ctx.run.source`, `ctx.abort`), `hashline-edit` (budget from
  `ctx.run.info`, `read`'s text via `Default`) pass their tests on the new API.
