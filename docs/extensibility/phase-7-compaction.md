# Phase 7 — compaction as a plugin (validation)

Built as a plugin (`builtin:compaction`, disableable), using only phases 2–6. If it needs anything else, that's an API
gap to fix in the earlier phase, not a special case here. Alternative compactors (algorithmic, daemon-backed) plug
into it through the `compact` event rather than replacing it, so the entry format stays one and old sessions keep
replaying whichever compactor wrote them.

## Changes

- **Triggers.** `reason: "threshold"`: in `request`, when estimated context (last `response` usage + chars/4 of newer
  messages) exceeds `info(model).contextWindow - reserve`. `reason: "overflow"`: a context-overflow `response.error`
  → compact, then `response.retry`. `reason: "manual"`: `/compact [instructions]`, or any plugin emitting
  `compact_request { instructions?, done? }` on the bus.
- **Cut point.** Walk back to `keepRecent` tokens over messages with `entryId`, never splitting a tool call from its
  result.
- **Hook.** Before compacting, `ctx.emit("compact", payload)` with
  `{ reason, instructions?, entries (with ids), firstKeptId (mutable), previousSummary?, tokensBefore, contextWindow,
  summary?, details?, cancel? }`. The first `summary` set is final (as `tool_call.result`); `cancel` stops it. With no
  `summary`, `ctx.complete` writes it (reusing the run's sent `system` and `tools` is fine for cache hits: a tool
  `prompt` already in `system` isn't appended again, phase 2).
- **Persist.** Entry `builtin:compaction:compaction { summary, details?, firstKeptId, tokensBefore }`; its replay
  parser replaces older messages in `state.messages` with the summary message
  (`meta: { plugin: "builtin:compaction", type: "summary" }`).
  A run builds each request from its session's messages as they are then (phase 3), so the compacted state applies
  to the same run's later requests and to a `response.retry` (overflow); compacting in a `request` handler, the
  handler also sets that request's `messages` to the session's (`ctx.session.getState().messages`), as the one being
  built was copied before (core still answers unanswered calls in what it sets, after the handlers). One run per
  session at a time (phase 3), so nothing else appends between the compaction and the retry.
- **After.** `ctx.emit("compacted", { entry, reason })`.
- **Settings.** `config.json` `compaction: { enabled, reserve, keepRecent }`.

**As built (deviations and details the plan left open).**
- `builtin:compaction` (`core/src/builtin/compaction.ts`) uses `request`, `response` (+ `retry`), `run_end`, its own
  entry reducer, `ctx.complete`, `ctx.status`, `ctx.notify` and a command: no API was added for it. Types in `llm.ts`:
  `CompactEvent`, `CompactionData`, and `compact` / `compacted` / `compact_request` in `Events`.
- Payload: `entries` became `messages` (the messages, with `entryId`, the summary replaces: from after the previous
  summary up to `firstKeptId`; a getter, so it follows a handler moving `firstKeptId`). `firstKeptId` is optional (none:
  keep nothing). The first `details` set is final too, like `summary`. `contextWindow` is the run's, else the session's
  model's (`ctx.resolve`).
- Estimate: the last reply's `usage.input + output` plus chars/4 of later messages (images ~1200 tokens). The reducer
  moves the usage of everything before the entry (dropped messages, kept replies' own `usage`, which they lose, and the
  summary call's, stored as the entry's `usage?`) into `state.usage`: totals hold (status bar, `powerline`, `goal`) and
  the estimate restarts at the next reply, so a fresh compaction never re-triggers on stale usage. A reply to a request
  built before a compaction saved since (`/compact` mid-run) carries the uncompacted context's usage: the next request
  skips the threshold check, and so do the next ones until a reply to a request built after it arrives.
- Settings are fitted to a known window: `reserve` at most half of it, `keepRecent` at most half of `window - reserve`,
  so on a small window a compaction can't leave the context over the threshold (compacting every request).
- Cut: never at a tool message; at least one message summarized. A handler's `firstKeptId` is fixed up after `compact`:
  moved back off a tool message onto its call, never past a last reply whose calls still run (`/compact` mid-run);
  keeping nothing also keeps what was appended during the summary call. Core leaves out of requests tool results that
  answer no call of the message before (defence in depth; the session keeps them). With none reaching `keepRecent`, "threshold" doesn't
  compact (so a too-large `keepRecent` can't loop) while "overflow"/"manual" cut at the latest valid point.
- Summary: serialized text (Pi's `[User]:` / `[Assistant]:` / `[Tool result]:`, calls and results cut at 2000 chars),
  a summarizer `system`, no tools; the conversation capped at half the window (chars/4; unknown window: half of
  `tokensBefore`), keeping the newest (older parts left out, a long one clipped); not the run's `system`/`tools` (serializing avoids unanswered calls and keeps the
  call small; reusing them stays open to a replacement compactor). The previous summary is kept in the summary
  message's `meta.details.summary` and passed as `previousSummary`, to be updated.
- Overflow: one compaction per failed request; the retry's `response` never compacts again (a second overflow fails
  the run). Detected by HTTP 413 or a "prompt is too long" / "context length" style error message.
- `compact_request { instructions?, done?(entry | undefined) }`: the emit resolves once done; `done` gets the saved
  entry, undefined when cancelled, nothing to compact or failed (reported with `ctx.notify`). `/compact` returns why when
  nothing was saved, nothing on success. One compaction per session at a time.
- `config.compaction.enabled: false` turns off only the automatic triggers (as Pi's setting does); `/compact` works.
- CLI: piece `cli:compaction` renders the summary message (`builtin:compaction:summary`) as one line, pushed live on
  `compacted` for the shown session and replayed on resume.
- Reference plugin `compaction` is a separate algorithmic compactor (a `compact` handler writing the summary from the
  messages: user requests and files touched, merged with the previous summary's and capped at the newest 20 / 50, the
  last reply; a model's previous summary is carried once as `## Earlier`, never nested; `details: { files }`), not a replacement of the built-in:
  core's `compaction.test.ts` is the built-in's harness.
- Earlier deferrals finished: `hermes-memory` flushes what a compaction summarized away (noted in `compact`, flushed on
  `compacted`, so a cancelled or failed one flushes nothing; at least `flushMinTurns` user messages; 10 s cap; waited
  for only for `"manual"`, as an automatic one is mid-request; `flushOnCompact`); `langsmith` posts a `Context Compaction (<reason>)` chain under the turn on
  `compacted`, and both it and `goal` find a run's own messages by entry id (a mid-run compaction shortens the
  history); `goal` re-sends its contract when a compaction summarized it away and counts `state.usage` and tool results' own
  usage (subruns') in its tokens, so they hold across a compaction;
  `powerline` adds the session's `usage` to its totals and keeps `queue` empty (hortus queues nothing during a
  compaction: a prompt runs at once, the compaction applying from its next request; one in progress shows as the
  `compaction` status).

**As built: gaps the Pi ports found, fixed.** Porting `@sting8k/pi-vcc` (`examples/plugins/vcc`), gentle-engram
(`engram`) and `context-mode` exposed these; each workaround is gone from the ports.
1. `CompactEvent.all`: every message (with `entryId`) a cut may keep or summarize: the session's from after the previous
   summary to the end, frozen when the compaction started. `isSummary(message)` (core, `llm.ts`) tells
   builtin:compaction's summary message. `vcc` cuts from `p.all` instead of re-reading `session.getState()` and
   re-detecting the summary.
2. `Session.allEntries(): Promise<SessionEntry[]>`: every branch's entries in file order, once written, upgraded like
   replay (an in-memory session's: its own); `entries()` returns upgraded messages too. `vcc`'s recall reads it instead
   of parsing the JSONL.
3. `compact_request.done(entry | undefined, reason?)`: none comes with builtin:compaction's text (as `/compact` shows
   it: "Nothing to compact", "Compaction cancelled by a plugin", "Compaction failed: …"). `/pi-vcc` returns it.
4. `session_closed { session, reason }`: after `session_close` once no handler cancelled it (`new`/`resume`/`exit`),
   or `"child"` (7). `engram` ends its Engram session there, with no cancel guess.
5. `PluginEntry<T = unknown>` (core, `session.ts`): a plugin entry with `data: T`. `Plugin.entries` reducers get one
   (method-style type, so a reducer may declare `(e: PluginEntry<Todo[]>, state, plugin)`), `Reducers` too, and
   `compacted.entry` is a `PluginEntry<CompactionData>`. The `as unknown as { data }` casts are gone from engram,
   context-mode, deferred-context, btw, goal, hashline-edit, plan-mode, todo, langsmith, vcc and builtin:compaction.
6. `ctx.plugin`: the name the ctx's plugin was loaded under ("host" for the host ctx; a tool's, its plugin's). Reducers
   get it as a third argument (`plugin`), so entry types (`${ctx.plugin}:<type>`) and the `state.data[plugin]` key
   follow a renamed install; full names keep working (`appendEntry` is unchanged, no auto-prefix: the template string is
   the whole convention). `engram` and `context-mode` (now `state.data[plugin] = { events, resume }`) and `vcc`'s
   message `meta.plugin` use it. Not migrated: plugins whose UI reads `state.data.<name>` from components without a ctx
   (todo, goal, btw, plan-mode, hashline-edit, deferred-context).
7. A subrun's session gets `session_closed("child")` (no `session_close`: nothing to cancel) once, when it is done: its
   caller's run has ended and it runs no more (checked at the caller's `run_end` and after each child run); a detached
   child, or one started outside a run, at exit (after the current session's `session_closed("exit")`, before
   `close`). A child resumed by a later subrun is done again (only the latest subrun's end fires). `engram` now captures
   in children too (no `ctx.run.depth` guards in `input`/`message`/`tool_result`) and ends them there.
8. Two user turns in a row: builtin:anthropic merges consecutive user messages (tool results then a plugin's message,
   or two user messages) into one turn, in order (the API merges them itself; proxies may not); OpenAI's two APIs send
   them as they are. Covered by provider tests.

Final round (I3): the estimate is core's `contextTokens(messages)` (the last reply's `input + output` plus
`messageTokens` of later messages: chars/4, an image ~1200), exported; builtin:compaction, the CLI's `usageLine`
(context %), intercom's presence and langsmith's `context_usage` use it.

## Verification

- [x] **T** a long scripted conversation crosses the threshold → the next request starts with the summary and keeps
  the recent messages; the full history is still in the file.
- [x] **T** resume and branch after compaction replay the compacted state; branching from before the compaction entry
  gets the full history.
- [x] **T** the cut never separates a tool call from its result.
- [x] **T** a `compact` handler setting `cancel` → no compaction; setting `summary` (+ `details`) → no `ctx.complete`
  call, and the entry holds them; moving `firstKeptId` moves the cut.
- [x] **T** a context-overflow `response.error` → one compaction (`reason: "overflow"`) and one retry, not a loop.
- [x] **T** `/compact focus on X` and a bus `compact_request` both compact with `reason: "manual"` and pass the
  instructions.
- [x] **T** `compacted` carries the saved entry.
- [x] **T** a session compacted with an external summary still replays with that plugin uninstalled.
- [x] **T** `disabledPlugins: ["builtin:compaction"]` → no compaction, nothing else breaks.
- [x] **T** `grep -ni compact packages/core/src/agent.ts` is empty.
- [x] **R** `compaction` (an algorithmic compactor): supplies `summary` from the entries with no model call.
- [x] **M** `pnpm dev`: a long session compacts, the transcript shows a summary line, the conversation continues.
  (Verified in a pty: `node packages/cli/dist/index.js` (the `pnpm dev` binary) under a temp `HOME` with a scripted provider plugin in `~/.hortus/plugins`, no real keys; its `info` reported a 2000-token window, `compaction.keepRecent` 100, and each
  answer was 3000 characters; at the third prompt builtin:compaction compacted on the threshold, the transcript drew
  `◆ compacted Ship the parser`, and the third and fourth prompts' requests started from the summary.)
- [x] **T** `compaction.test.ts`: `compact.all` is every message after the previous summary whatever the cut; `isSummary`
  finds the summary; a cancelled `compact_request`'s `done` gets `(undefined, "Compaction cancelled by a plugin")`.
- [x] **T** `session.test.ts`: `allEntries` lists both branches in file order, upgraded, before the write settles; an
  in-memory session's are its own.
- [x] **T** `subrun.test.ts`: `session_closed` follows only an uncancelled `session_close`, and the exit's; a child's
  `session_closed("child")` fires once after its caller's run (after the child's `run_end`), a detached one's at exit.
- [x] **T** `events.test.ts`: `ctx.plugin` is the loaded name in handlers, tools and commands ("host" for `agent.ctx`);
  a reducer typed `PluginEntry<number>` gets `plugin` and writes `state.data[plugin]`.
- [x] **T** `anthropic.test.ts`: consecutive user turns (around a dropped empty reply; tool results then a user
  message) are merged in order; `openai.test.ts`: both OpenAI APIs send two user messages as two.
- [x] **R** `vcc`, `engram`, `context-mode` and every reference plugin with entries pass with the casts and
  workarounds removed.
