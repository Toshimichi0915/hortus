# Phase 6 — nested runs

## Changes

- A child's tools come from `mergePlugins` on its plugin subset plus its plugins' `run_start` handlers — never a copy
  of the host `ctx.tools`; pushed tools (e.g. MCP) reach a child only through their plugin's `run_start`.
- `ctx.subrun(messages, opts) → SubRun` with
  `opts = { system?, tools?, plugins?: { only?: string[]; disable?: string[]; extra?: Plugin[] }, model?, provider?,
  effort?, cwd?, signal?, session?: "memory" | "file" | Session }` and
  `SubRun = { id, session, send(msg, opts), abort(reason?), done: Promise<RunEnd> }`.
  - Reuses the loaded plugins (no reload, no MCP reconnect, `provided` honoured); `plugins` filters which handlers and
    tools take part (`disabledPlugins` generalized) and can add child-only plugins.
  - The handle is returned before the child's first event, so callers can track it; `send` steers the running child
    (phase 3 delivery modes); passing an existing child `Session` resumes it. One run per session at a time (phase 3):
    a child on a session with a run waits for it, so passing the parent's own session from its tool would wait
    forever; reject that `Session` (the run's own, or any with a run in progress) rather than queueing it.
  - Works from tools, handlers and commands; `ctx.run.parent.toolCallId` is set only when started from a tool.
  - `system` may be one reused from a sent request or a preview: core appends each declared tool's `prompt` only when
    `system` doesn't contain it yet (phase 2), so the child's tools don't send theirs twice.
- Run identity: the child's `ctx.run` has `depth = parent + 1` and `parent`; every handler sees it. The CLI transcript
  and status ignore `depth > 0` (a plugin can render children itself).
- **cwd.** Sessions store a cwd (an entry, like model); top-level runs use it, subruns may override it
  (`RunOptions.cwd`, `ctx.run.cwd`). Built-in pieces (`read`/`write`/`edit`/`bash`, AGENTS.md and skill discovery, base
  prompt) use `ctx.run.cwd`, never `process.cwd()`. A plugin switching the session into a worktree sets it.
- File-backed child sessions record their parent; they don't appear in `/resume` or `listSessions`, and
  `listSessions({ parent })` lists them.
- Child usage is reported as the calling tool's `ToolResult.usage` (or added to the parent session's totals when not
  started from a tool).

**As built (deviations and details the plan left open).**
- `ctx.subrun(input, opts?)` returns the `SubRun` synchronously (so nothing of the child can run before the caller has
  the handle). `input` is a message (`string | UserInput`) or `Message[]` seeding the child's session (then run with no
  new input). `done` is `Promise<RunEnd | undefined>` (undefined when an `input` handler took the run); `subrun` throws
  once the agent is closed, and `done` rejects only if it closes before the child starts. `SubrunOptions.source` (default the calling plugin) was added.
- `opts.tools` is a list of tool **names** the child may call, applied after its `run_start` handlers (so MCP tools
  added there can be kept by name) and again wherever a call finds its tool and a request declares them (the run's
  `ctx.tools` stays mutable: a tool pushed into it later, as `mcp-extension` does, is neither declared nor callable, and is pruned from the restricted
  run's `ctx.tools` on its next read, so handlers building from it, like builtin:codemode's description, offer nothing
  it can't call). The list limits tool names, not implementations (plugins are trusted: an allowed tool may do
  anything, a codemode script included), and provider-executed tool calls aren't subject to it. A
  grandchild gets the intersection of its own `tools` with its caller's list (the caller's when it names none); child-only tools come from `plugins.extra` (`Named[]`, like `LoadOptions.extra`,
  since handlers need a name for their ctx and `ctx.state`).
- Plugin filter: `only`/`disable` match a plugin's name or a name it `replaces`, over the caller's run's set (a
  grandchild inherits its parent's filter); `only` always keeps the host's own `LoadOptions.extra` (the CLI's observer,
  a test's provider and recorder) less their tools (an embedder's tool plugin doesn't reach an `only` child),
  `disable` can drop them. An unfiltered child reuses the merged defs, its tools a
  snapshot taken at load (before plugins pushed any into the host `ctx.tools`); a filtered one is `mergePlugins`'d anew
  (load conflicts it hits are not reported again: they were at load). The child's handlers, tools, providers (`resolve`, `ctx.complete`), `ask`
  handlers and the `idle`/`message` events on its session are its set's; `init`/`ready`/`close`, commands and entry
  reducers stay the agent's.
- `RunInfo.parent` is `{ session?, runId?, toolCallId? }`: from a command (a host ctx) there is no parent run, so
  `runId` became optional and `session` (the caller's session id) was added; `depth` is the caller's + 1 (1 from a
  command).
- Defaults: `model`/`provider`/`effort` from the caller's run (else its session's settings), kept for every run on the
  child session. **Every run on a child session is a child**: a `send` (e.g. `handle.send(..., { deliver: "steer" })`
  after it ended) wakes it with the same plugins, depth and parent; `abort` aborts whichever runs now.
- Accepted sessions: a new one (no entries), one a subrun made (a child), or a file in the caller's children's
  directory (`childDir(<caller's session id>)`, a child resumed after a restart). Rejected: anything else (it would
  make every later run on it a child: the CLI's shown session would go blank), the caller's own and the current
  session, and any with a run in progress or waiting (`lane.running`) → throws "A subrun needs a new session or a
  child's, with no run in progress".
- Abort: `opts.signal` → `aborted.by: "user"`; aborting the caller (its run, or the calling tool call's `runTool`
  signal) stops the child with the caller's `aborted` (else `{ by: "user" }`). A `runTool` call's own signal counts only
  while that call runs: codemode aborts its scripts' signal when the script ends, and a child started from such a call
  that outlives it stays, until the run aborts; `handle.abort(reason)` → `by` = the
  caller's plugin. The caller's abort reaches a run of the child woken later (a `send`) only while the caller's run
  goes on; one woken after it ended is on its own, though its `RunInfo.parent` still names that run.
- cwd: `Ctx.cwd` (new: the run's, else the session's, else `process.cwd()`) is what built-in pieces read (the
  `skills` handler runs outside runs too, where `ctx.run` is absent). Core entry `cwd` (`Session.setCwd`,
  `SessionState.cwd`, `SessionInfo.cwd`); a run uses `RunOptions.cwd ?? session cwd ?? process.cwd()`, and the first run
  on a session without one records it (so sessions know their project). A subrun's cwd is `opts.cwd`, else a resumed
  child session's, else the caller's `ctx.cwd`, and is written to the child session. `read`/`write`/`edit` resolve
  paths against `ctx.cwd` (messages keep the path as given), `bash` spawns in it; `toolCtx()` sets `cwd`.
- File-backed children: `newSession(childDir(<caller's session id>))`, i.e. `~/.hortus/sessions/<parent id>/`. The
  directory records the parent (no entry needed), so `listSessions()` (one dir, `.jsonl` files) never sees them and
  `listSessions({ parent })` reads that dir; `/resume` and `-r` don't find them. `listSessions` takes
  `string | { dir?, parent? }`. `newSession(dir)` is synchronous (the dir is made on the first write), which is what
  lets `subrun` return at once for "file" too.
- Usage: a child run sums its messages' usage (replies, and results' `usage`) and reports it at its end: to the calling
  tool call while it runs (core adds it to that call's `ToolResult.usage`; a nested `ctx.runTool` call's goes to its
  caller's, as nested results aren't saved), else to the caller's session as a core `usage` entry
  (`Session.addUsage`, `SessionState.usage`), which `usageLine(messages, window, extra?)` and the status bar add.
  Known gap: a subrun started from a child's own handler (not a tool) lands on the child session's `usage`, not the
  top session's.
- CLI: the observer drops events with `ctx.run.depth > 0` besides other sessions' (a child is never on the shown session
  anyway, since a subrun can't use its caller's session).
- Earlier deferrals finished: `tracer` nests a subrun's root under the starting tool call's span (else the parent run's
  root) and writes it with its parent's tree (when it outlives the parent, it is taken out of that tree at the parent's
  `run_end` and written on its own at its own); `otel` opens the child's root span
  under that tool span, same trace; `langsmith` the same for its run tree; `powerline` reads the session's cwd for its
  path/git segments, lists recent prompts only from sessions with the same `SessionInfo.cwd`, and has `/cd [dir]`
  (`ctx.session.setCwd`); `fabric` programs get `agents.run({ task, tools?, cwd?, model?, provider?, systemPrompt? })` →
  `{ id, status, text, error? }` (a one-shot child; Pi's resident agents, actors, councils and runners stay out);
  `hashline-edit` and `langsmith` read `ctx.cwd`. `goal` and `plan-mode` had no phase-6 deferral in their code (the
  `goal` port has no completion auditor to move onto `subrun`). `mcp-extension`'s project `.hortus/mcp.json` stays at
  the process's cwd (its servers are per agent, not per session).
- Reference plugin `subagent`: a `subagent { task, cwd? }` tool running `ctx.subrun` with `cwd`, `tools: ["read"]` and
  `plugins: { disable: ["subagent"] }`, returning the child's final text (its error or abort as the tool's error).
- **Gaps found by porting `btw`, `hermes-memory` and `workflows`** (each workaround removed from the ports):
  - TUI parts reach their plugin's ctx: `cli.keys(input, key, cli, ctx)` and `cli.submit(value, Default, cli, ctx)` get
    the plugin's host ctx (as `cli.init` did); `usePluginCtx()` (`@hortus/cli`) returns it in the plugin's slot
    components, entry/tool renderers and ask dialogs (`App` wraps each in a `PluginCtx` provider; `composeSlots` & co.
    are unchanged). Re-rendering is the plugin's: `@hortus/cli` re-exports zustand's `createStore`/`StoreApi`/`useStore`
    for a store kept in `ctx.state` (`btw` does this; `workflows` keeps its own version + listeners with
    `useSyncExternalStore`). No module state needed: one set per agent.
  - `SubrunOptions.seed?: Message[]`: the child's session starts with them, then `input` runs as a normal input (its
    `input` event fires). The `Message[]` form of `input` stays (seed, no new input).
  - Plugin filters never drop providers: a plugin filtered out by `only`/`disable` keeps only its `providers` (defs and
    wraps), so a child keeps builtin:anthropic/openai and auth wrappers (`hermes-memory` now uses `only: [itself]`).
  - Exit subruns: `close()` refuses top-level runs and sends at once, but subruns (and runs and sends on child sessions)
    stay allowed until the `session_close("exit")`/`close` handlers have finished or hit the timeout; then whatever is
    still running is aborted (`{ by: "host", reason: "exit" }`, a child starting just then too) and `subrun` throws.
    `hermes-memory` flushes through a subrun at exit too (its direct-completion fallback is gone).
  - `SubrunOptions.detached?: boolean`: the caller's abort (run, tool call, Esc) never reaches the child; `parent` is
    still the caller's (session, run, tool call) and its usage goes to the caller's session (never the tool's result,
    which is already saved); `agent.close` still aborts it. `workflows` background agents use it instead of `init`'s
    host ctx.
  - `ctx.run` in `input` handlers: the run's provider/model are resolved before `input` fires (reused by `run_start`
    unless the settings changed meanwhile), so `ctx.run` (id, depth, source, model...) is set; left unset only when
    resolving fails (the run then reports that error as before). `workflows` arms by run id instead of by session.
  - `projectRoot(cwd): Promise<string | undefined>` (core, `context.ts`): the nearest dir with a `.git`, the rule
    `projectDirs` (now built on it) and AGENTS.md/skills discovery use; `hermes-memory`'s project tier uses it.
  - (Final round, S5/S6) `SubrunOptions.agent` (a name) is the child's `RunInfo.agent` (a grandchild names its own);
    `RunInfo.root` is the top-level session's id: a top-level run's own session's (under `--parent`, its tree's root),
    a child's its caller's root. permission-system keys per-agent policy on `agent` (else `source`) and session
    grants on `root`; its child→root map is gone.
  - (Phase 7) a child's session gets `session_closed("child")` once it is done: its caller's run has ended and it runs
    no more; a detached one, or one started outside a run, at exit (see phase 7's As built).

## Verification

- [x] **T** `grep -n "process.cwd()" packages/core/src/builtin/` is empty.
- [x] **T** a subrun with `cwd: <tmp>` reads files and AGENTS.md relative to `<tmp>`; a session whose cwd entry is
  `<tmp>` does the same for top-level runs, and resuming it restores the cwd.
- [x] **T** `plugins: { disable: ["builtin:prompt"] }` → the child's system prompt has no AGENTS.md text.
- [x] **T** `plugins: { disable: ["subagent"] }` → the child has no `subagent` tool (no recursion); `extra` adds a
  child-only plugin that the parent never sees.
- [x] **T** a subrun doesn't reload plugins (a load counter in a test plugin stays 1) and doesn't reconnect MCP.
- [x] **T** the handle's `id` is known before the child's `run_start`; `send({ deliver: "steer" })` reaches the running
  child; `abort` ends it with `aborted.by` = the caller; `done` resolves with its `run_end`.
- [x] **T** resuming a file-backed child `Session` continues its history.
- [x] **T** a subrun started from a command has `parent` without `toolCallId`.
- [x] **T** child events carry `depth: 1` and the parent's ids; `cli.test.ts`: none of them reach the transcript.
- [x] **T** (final) `RunInfo.agent` and `root` down two levels (`gates.test.ts`); permission-system's per-agent policy
  keyed on `agent`.
- [x] **T** aborting the parent aborts the child; the child's `run_end.aborted` fires.
- [x] **T** gating applies in children: `guard` blocks a child's `bash` call.
- [x] **T** two concurrent subruns on different sessions send their own session ids (phase 2 tested this with two
  top-level runs; re-test it with real subruns through a provider wrapper reading `ctx.session`).
- [x] **T** a file-backed child session is absent from `listSessions()` and present in `listSessions({ parent })`.
- [x] **T** child usage appears in the parent's totals once.
- [x] **R** `subagent`: the tool delegates a task with its own cwd and a read-only tool set, returns the child's final
  text; `tracer` nests the child's spans under the tool call.
- [x] **T** `hooks.test.tsx`: a plugin's `cli.keys`/`cli.submit` get its host ctx and its slot's `usePluginCtx()` the
  same `ctx.state`; a zustand store there re-renders the slot; `usePluginCtx` outside a plugin component throws.
- [x] **T** `subrun.test.ts`: `seed` + `input` → the child's request is seed then input, and its `input` event fires.
- [x] **T** `subrun.test.ts`: `only`/`disable` children of an agent whose provider and provider wrap are pieces (not
  host extras) still reach that provider through the wrap.
- [x] **T** `subrun.test.ts`: at exit, `session_close`/`close` handlers start subruns and `send` to them; one left running
  is aborted by the host; afterwards `subrun` and `run` throw.
- [x] **T** `subrun.test.ts`: a `detached` child outlives its caller's abort, keeps `parent` with `runId`/`toolCallId`,
  reports usage to the session (not the tool result); `agent.close` aborts one still running.
- [x] **T** `subrun.test.ts`: `input` handlers see `ctx.run` (id equal to `run_start`'s, depth, source, model), for
  top-level and child runs.
- [x] **T** `context.test.ts`: `projectRoot` is the nearest `.git` dir (a `.git` file too), undefined outside one.
- [x] **R** `btw` (seed + `usePluginCtx`/store, no module state), `hermes-memory` (`only: [self]`, exit flush subrun,
  `projectRoot`), `workflows` (`detached`, `ctx.run` in `input`, `usePluginCtx` + ctx in `keys`): their tests pass.
