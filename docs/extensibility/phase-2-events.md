# Phase 2 — one `ctx`, loop events, gated tool calls

## Changes

**`ctx`.** Every handler gets `(payload, ctx)`; every `Tool.execute` gets `(input, ctx & { update, callId })`; every
`Provider.complete` gets `(req, callbacks, ctx)`, so providers and their wrappers build per-call headers from
`ctx.session`/`ctx.run` and report quota via `ctx.status` without module state that races across concurrent runs.

```ts
interface Ctx {
  run?: {
    id: string;
    depth: number;
    parent?: { runId: string; toolCallId?: string };
    provider: string;
    type: string;
    endpoint?: string;
    model: string;
    effort?: Effort;
    cwd: string;
  }; // absent outside a run
  signal: AbortSignal;
  abort(reason?: string): void; // aborts the current run; run_end says who
  busy(): boolean; // a run is in progress
  tools: Tool[]; // the run's callable set
  runTool(call: ToolCall): Promise<ToolResult>; // always gated
  complete(req: Request & { provider?: string; model?: string; effort?: Effort }): Promise<AssistantMessage>;
  listModels(): Promise<{ provider: string; id: string }[]>;
  emit(name: string, payload: unknown): Promise<void>; // open bus; Events is extended by declaration merging
  // phase 1 already gives tools these two (`ToolContext`) and the agent (`agent.secrets`, `agent.fetch`):
  secrets: { get(name, { refresh? }), update(name, fn), find(type) }; // SecretStore: logins through their owner's auth
  fetch: typeof fetch; // LoadOptions.fetch, so harness tests stub every request
  // added later: session, send (3), ask/notify/status (4), subrun (6)
}
```

Handlers outside a run (e.g. `skills` from a host's `listSkills(agent.ctx)`), and from phase 3 `init`, `session_open`
and commands, get a **host ctx**: no `run`, and it stays valid between runs (timers, sockets, child-process callbacks
keep it), always targeting the agent's current session. A handler's `ctx` is the
emitting one: events caused from inside a tool (its `ctx.complete`, `ctx.emit`, `ctx.runTool`) carry that tool's
`callId`, so tracers can parent them.

**Tool results** carry `images?: Image[]` instead of `image?` (MCP and codemode pass every image through; providers
send all of them). `tool_call`'s `call` is a copy: edits to `call.input` apply to execution only and the input is
validated after all handlers ran; the saved assistant message (and provider `raw`) keeps the model's input, so a
plugin injecting a credential there never leaks it to the session or the model.

**Provider-executed tools.** A provider may return tool calls with `result` already set (server-side web search,
an agent-backed "model" reporting its own tool activity). Core doesn't execute them but still fires
`tool_call`/`tool_result` for display, before the assistant `message` (which carries the result its handlers left);
such calls alone don't continue the loop. `Tool.providerOptions?` passes
provider-specific tool fields (grammar tools) through untouched.

**One provider-call path.** `run` and `ctx.complete` call the provider through the same function, which fills
`maxTokens` (unless the caller set it) from the provider's `info(model).maxOutput`, cached per `<provider>/<model>` as
phase 1's `run` does, before firing `request`; so a routing provider's limit (e.g. Claude behind LiteLLM) applies to a
plugin's `ctx.complete` too, instead of the provider's 64000 fallback.

**Attribution and preview.** Core stamps every tool with `plugin` (the name of the plugin that provided it; a
wrap keeps it, see phase 5's As built). `ctx.preview()` fires `run_start`/`prompt`/`request` with `source: "preview"` and returns the request without
calling the provider or persisting anything (context viewers).

**File lock.** Core exports a tool lock, `withToolLock(path, fn)` (in-process, per resolved path: no lockfile, so
nothing is left in the project after a crash); `builtin:write`/`builtin:edit` use it, so replacement or additional
editing tools serialize with them. Phase 1's `withFileLock` (a `<path>.lock` file, cross-process) stays for files
under `~/.hortus`, not project files.

**Events** (mutable payloads, load order; `skills`, `text`, `thinking`, `tool_update`, `message` stay):

| Event         | Payload                                                                                                                                                                                              | Fires                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_start`   | `{ tools, skills, context, messages (readonly), model, provider, effort? }`                                                                                                                          | once per run; replaces `session_start`                                                                                                                     |
| `prompt`      | `{ system: string[], tools (readonly), skills (readonly), context (readonly) }`                                                                                                                      | after `run_start`; pieces write prompt text here                                                                                                           |
| `request`     | `{ id, source: "run" \| <plugin>, provider, type, system, tools, messages (copy), model, effort?, maxTokens? }`                                                                                      | before every provider call, `ctx.complete` included; edits apply to that call only                                                                         |
| `response`    | `{ id, request (frozen: what was actually sent), payload? (serialized provider payload, observe-only), assistant?, error?, meta?: { stopReason?, responseId?, model?, status?, headers? }, retry? }` | after every provider call, success or failure; built-in providers fill `payload`/`meta`; `retry = true` re-fires `request` for the same turn, at most once |
| `tool_call`   | `{ call: ToolCall & { parentId? }, result? }`                                                                                                                                                        | before each call; the first `result` set is final: later handlers still run (observers) but can't change it                                                |
| `tool_result` | `{ call, result }`                                                                                                                                                                                   | after each call, including results a `tool_call` handler supplied                                                                                          |
| `turn_end`    | `{ assistant, results?, stop }`                                                                                                                                                                      | after each assistant message (and its tool results); `stop` ends the run                                                                                   |
| `run_end`     | `{ source, messages, error?, aborted?: { by: "user" \| <plugin>, reason? } }`                                                                                                                        | in a `finally`: on success, throw and abort                                                                                                                |
| `tool_input`  | `{ id, name, partial: string }`                                                                                                                                                                      | streamed tool-call arguments, when the provider streams them (live cards)                                                                                  |

Order of one run: `run_start → prompt → (request → response → [provider-run tool_call → tool_result]… → message →
[tool_call… → tool_update* → tool_result…] → message → turn_end)* → run_end`.

**Tool sets.** `run_start.tools` is the callable set (execution, `ctx.tools`, `runTool` resolve against it).
`request.tools` is what's declared to the model for that call. A model call to an undeclared tool gets an
"unknown tool" error result. New flags: `Tool.exposure?: "direct" | "codemode"` (codemode tools are callable, never
declared) and `Tool.sequential?: boolean` (runs alone, after the parallel ones). Duplicate names in `run_start.tools`
→ reported via `onError`, the later dropped.

**Gating.** `ctx.runTool` is the only way to run a tool; it fires `tool_call`/`tool_update`/`tool_result` with
`parentId` and id `<parent>/<n>`. In a batch, `tool_call` handlers run call by call before any call executes;
execution stays parallel. A throwing `tool_call` handler blocks the call with an error result (fail closed); other
throwing handlers are reported via `onError` and skipped. Tools get `ctx.signal`, so Esc cancels them.

**As built (deviations and details the plan left open).**
- `Provider.complete(req, callbacks?, ctx?)`: `CompleteCallbacks` is `{ text, thinking, toolInput, payload, meta }`, all
  optional (the old positional `onText`/`onThinking` are gone). `payload` and `meta` are how providers fill
  `response.payload`/`response.meta`; core adds `status`/`headers` from an SDK error (`APIError`) itself. The OpenAI
  chat provider now creates the stream with `.withResponse()`, to see the HTTP response, and accumulates the chunks
  itself (the SDK's `ChatCompletionStream` takes a changed chunk `id`, which some compatible endpoints send, for a new
  request); the SDK's stream just ends on abort, so it throws `APIUserAbortError` then, and an error if the stream
  ended without a `finish_reason`. Anthropic reads `stream.response`.
  `stopReason`: `end`, `tool_use`, `max_tokens`, else the API's own reason.
- `CompletionRequest.headers` (and so `request.headers`): headers for that one call, which the built-in providers
  pass as SDK request options. This is how a wrapper sends `ctx.session.id` (`CreateOptions.headers` is per instance).
- `ctx.session` is `RunOptions.session` (the host's, e.g. the CLI's shown session) until phase 3 makes sessions core's;
  `Session.id` (the file name's uuid) was added for it. "Two concurrent subruns" is tested as two concurrent top-level
  runs on different sessions (subruns are phase 6); nothing per-run lives in module state.
- `ctx.preview(messages, opts?)` takes the history (no core-owned session yet; phase 3 can default it). `run_start` has
  `source: "run" | "preview"`, so observers (tracer) skip previews; a preview fires no `response`, but does fire
  `run_end` (`source: "preview"`; see the port fixes below).
- `run` resolves with the `RunEnd` payload, also when aborted (Esc or `ctx.abort`); it rejects only when the run failed.
  `RunOptions` moved to `llm.ts` and gained `session`.
- The ctx a handler, tool or provider gets is bound to who acts: the handler's plugin, the tool's `plugin`, the
  provider's secrets entry name. That name is `abort`'s `by` and `complete`'s `source`. `agent.ctx` is the host ctx
  (bound as "host"); it replaces `agent.secrets`/`agent.fetch`, and `ToolContext` is now `ToolCtx`. The exported
  ungated `runTool(tools, call, ctx, codemodeOnly)` is gone (`ctx.runTool` is the only way), as is
  `mergePlugins`' `emit` (the agent emits, binding a ctx per plugin).
- The host ctx's `abort` aborts every running run; `busy()` counts running runs.
- Handler errors: `LoadOptions.onError(plugin, Error("Plugin <p>'s <event> handler failed: …"))`; the next handler
  still runs and the run goes on. Its default prints the message to stderr (load conflicts keep their default throw:
  `loadPlugins` has its own default); the CLI shows an error line. Only a host's `onError` that throws fails the run,
  at that point. A throwing `tool_call` handler blocks the call with `Blocked by <plugin>: <message>`, without `onError`.
- `text`/`thinking`/`tool_input`/`tool_update` are queued in order without blocking the stream; their handlers finish
  before the `response`/`tool_result` that follows. Their ctx has a queue of its own, so they can await
  `ctx.complete`/`ctx.runTool`. An error among them (a throwing `onError`) is thrown once: by the run after `response`
  or after the turn's tool calls, or by the host-level `agent.ctx.runTool` that caused it (each has its own queue).
- `request.messages` is a deep copy (`structuredClone`), so in-place edits don't reach later requests, `run_end` or the
  caller's history; `request.tools` is a shallow copy (tool defs are shared). Tool results (provider-executed ones
  too) lose their `details` in it: providers never send them, and they may not be cloneable (a function).
- A call reaching its turn to run after the run was aborted (during gating, or a `sequential` one waiting for the
  others) isn't executed: its result is `Aborted` (an error), and `tool_result` still fires.
- Model calls resolve against that request's `tools` (what was declared), `ctx.runTool` against the run's callable set.
  A model's direct call to a `codemode`-exposed tool gets "Unknown tool" plus how to reach it from codemode.
- MCP tools are `exposure: "codemode"` (when codemode is on) in place of the old `codemodeOnly` list, and carry
  `plugin: "builtin:mcp"` (codemode: `"builtin:codemode"`) ahead of phase 5. Codemode scripts still call tools'
  `execute` directly, so `tool_call` doesn't see them yet (phase 5 routes them through `ctx.runTool`).
- `response.assistant` may be changed by handlers (`litellm` sets `usage.cost` from `x-litellm-response-cost` there).
- Provider-executed calls (`ToolCall.result`) are gated and reported but get no tool message; providers leave them
  out when rebuilding history from `text`/`toolCalls` (their own `raw` carries them). The CLI draws their block too.
- A tool returns one `Image` or an `Image[]`; `ToolResult.images` replaces `image` (old session lines are upgraded on
  replay). Chat Completions sends them in one user message after the tool messages.
- `Tool.providerOptions` is keyed by API (`anthropic`, `openai`, `openai-responses`), spread into that API's tool def.
- `withToolLock` lives in `tools.ts`. It is re-entrant per async context (`AsyncLocalStorage`, as `withFileLock`): a
  wrapper of `edit` taking it around `Default.execute`, or a holder calling `edit` through `ctx.runTool`, doesn't
  deadlock; once released, a call from the holder's context queues again. `bash` kills its process group on `ctx.signal`, and doesn't start on an aborted one.
- `turn_end.stop` is honoured both ways; nothing yet adds messages on `stop = false` after a final answer (phase 3's
  `steer` will).
- Testing: `scripted` turns get `(req, ctx, callbacks)` and may be async (to wait for `req.signal`); `toolCtx(overrides?)` builds a
  `ToolCtx` for calling a tool's `execute` directly.
- Ports finished: `litellm` sends `x-litellm-session-id` from `ctx.session` per call and reads the charged cost from
  `response.meta.headers` (its wrapped `fetch` and shared `lastCost` are gone); `web` aborts its requests with
  `ctx.signal` (combined with its own timeout).
- Reference plugins: `guard` (blocks `rm -rf`/`-Rf` of `/`, `~`, `$HOME`/`${HOME}`, quoted or not, and
  `--no-preserve-root`; asking before `write` is phase 4, codemode calls phase 5), `tracer` (writes each run's span tree to `~/.hortus/traces.jsonl` at `run_end`;
  flushing in `close` is phase 3, nesting subruns phase 6), `plan-mode` (`/plan [off | <provider>/<model> [effort]]`;
  mode kept in module state until phase 3's entry; it removes `codemode` too, since codemode is built once over every
  plugin tool and its scripts would still reach `write`/`edit`/`bash`: phase 5 closes that gap).
- The CLI drops a run's streamed-but-unfinished text and thinking on each `request` with `source: "run"`, so after a
  `response.retry` only the retried attempt shows.

**As built: gaps the Pi ports found, fixed.** Porting `pi-otel` (`examples/plugins/otel`), `pi-deferred-context-engine`
(`deferred-context`) and `pi-rtk-optimizer` (`rtk-optimizer`) needed workarounds; each is gone now.
1. `ToolCtx.env?: Record<string, string>`: builtin:bash merges it into its child's environment. A wrapper passes
   variables as `Default.execute(input, { ...ctx, env: { ...ctx.env, NAME: v } })` (otel's `TRACEPARENT`, which it
   used to `export` ahead of the command).
2. `request` (and so `response.request`) has `provider` (the secrets.json entry) and `type`, observe-only (editing them
   doesn't reroute; core strips both before the provider call). otel's `gen_ai.provider.name` reads it, right for a
   cross-provider `ctx.complete` too.
3. `ToolWrap.optional` / `ProviderWrap.optional`: a wrap of nothing is skipped silently instead of reported (a load
   error by default). otel's bash wrap is optional, so `disabledPlugins: ["builtin:bash"]` loads.
4. `run_start.context: ContextFile[]` (`{ path, content }`), readonly in `prompt`: builtin:prompt pushes the AGENTS.md
   files in its `run_start` (it loads first) and renders them in `prompt`, after every `run_start` handler changed the
   list. deferred-context dedupes the list there instead of re-reading and swapping the rendered text.
5. `Tool.prompt?: string`: after the `request` handlers ran, core appends the `prompt` of each tool that request
   declares to its `system` (blank-line separated, in declaration order), so a deferred tool's guidance arrives with
   it. A prompt `system` already contains isn't added again, so a caller reusing a sent request's or a preview's
   `system` with its tools (phase 6 subruns, phase 7's compactor) doesn't send it twice. A codemode-only tool is never
   declared, so its prompt is never sent. `request` handlers see `system` without it; `response.request` and `ctx.preview()`'s result include it. The
   built-in tools have no prompt text yet; `hello` and `web` (on `web_search`, covering its siblings) moved theirs
   there.
6. `ctx.preview()` fires `run_end` (`RunEnd.source: "run" | "preview"`; with `error` if it failed), so per-run state
   set up in `run_start` is dropped there; deferred-context no longer cleans up in `request`.
7. Manifest `"order": "last"` (directory plugins and pieces): loaded after every plugin without it (still before
   `extra`); among themselves, and against dependencies, dependency order wins (a plugin depending on a "last" one
   pulls it earlier). deferred-context uses it, so it sees the final `request.tools`. Chosen over per-handler hints:
   one field, one sort pass, and the order is visible in `agent.plugins`.
8. `tool_result.result` may be replaced (`p.result = { ...p.result, output }`): core uses the payload's after the
   handlers, with the call's `id` (a replacement that isn't an object is ignored), so a result always answers its
   call. A provider-run call's replacement is in its assistant message (saved, resumed). rtk-optimizer replaces it
   instead of mutating core's object.
9. `tool_update` is `{ call, details }` (`call` is the `tool_call` copy, what runs; the old `id` is `call.id`).
   rtk-optimizer's set of running bash ids is gone.
10. The saved `details` are the last `tool_update` payload's after its handlers (core waits for them), not the raw
    `ctx.update` value; `undefined` last means none. rtk-optimizer's re-cleaning in `tool_result` is gone.
11. builtin:bash streams `ctx.update({ output })` (`BashUpdate`: the last 8 KB of stdout+stderr so far, raw; once cut,
    it starts after a line break, or for one longer line at a UTF-8 character), at most every 100 ms and only once output has waited that long (quick commands send none),
    then `ctx.update(undefined)` when done, so the result keeps no details (its `output` has it all). The CLI's bash
    block shows the live output's last lines until the result arrives; live or finished, it shows what a terminal
    would: each line from its last `\r` (progress bars), escapes and other control characters dropped. rtk-optimizer's test no
    longer wraps bash.

**As built: final round (security & run model), fixed.** The last ten Pi ports (`final-gaps.md` S7/N2, N3, B1, P1,
L2, W1, W3, I2) needed these; their workarounds are gone.
1. **`tool_gate`** (S7/N2): after every `tool_call` handler of a call (mutators, `order: "last"` and `extra` ones
   included), core deep-copies and freezes the call and fires `tool_gate { call, tool?, env?, result?, block? }`:
   `call` is exactly what runs (the tool gets a copy of that frozen input), `tool` the tool it resolves to (none:
   unknown or not callable there), `env` the `tool_call` handlers' `env` (frozen), `result` one a `tool_call` handler
   supplied. `block = "<text>"` (the error result's whole output) or a throw (`Blocked by <plugin>: …`) blocks; the
   first block is final and replaces even a supplied non-error result (fail closed); later gates see `block`. Not fired
   for provider-run calls. Order per call: `tool_call` handlers → freeze → `tool_gate` handlers → run (or the supplied
   result) → `tool_result`; a batch gates every call before any runs, as before. `guard`, `safety-net` (no longer
   `order: "last"`), `permission-system`, `fabric`'s approvals and `plannotator`'s planning guard moved there.
   Chosen over changing `tool_call`'s "first result final" rule: mutators and gates no longer share one ordered list.
2. **Env before the gate** (N2/N4): `tool_call.env` (handlers set it) becomes `ToolCtx.env` and is what `tool_gate`
   sees. A `ToolWrap` adding env inside `execute` is part of the tool (trusted like it) and isn't gated.
3. **`Tool.effects?: { reads?, writes?, exec?, readOnly? }`** (N3): the input keys holding read paths, written paths
   and shell commands (`exec` is a key list, not a boolean, so a gate knows which input to analyze), and "changes
   nothing". builtin `read` `{ reads: ["path"], readOnly: true }`, `write` `{ writes: ["path"] }`, `edit`
   `{ reads, writes: ["path"] }`, `bash` `{ exec: ["command"] }`; an MCP tool with `readOnlyHint` gets
   `{ readOnly: true }` (`mcp.ts`). safety-net, permission-system, guard and fabric read it, falling back to their
   name/key guesses for tools without it.
4. **`ProviderWrap.wrap(Default, ctx)`** (B1/S2): `ctx` is the wrapping plugin's host ctx (its `ctx.state` is its
   handlers'); `mergePlugins(plugins, onError, ctxOf?)` passes it, `createAgent` merges after the host ctx exists (so
   `loadNamed` loads without merging), and a subrun's re-merge passes it too. billion-context's private route header
   is gone: its wrap reads the plugin's config and routes the calls its `request` handler stamped.
5. **`ToolCtx.stop()`** (P1): ends the run after the current batch (`turn_end.stop` starts true; handlers may undo it;
   sends wait as for a handler's stop). plannotator's `terminate` uses it.
6. **Pushed tools are stamped** (L2): a tool pushed into `ctx.tools` (run or host array) without `plugin` gets the
   pushing ctx's plugin, in place (a proxy per array and plugin; not for the host ctx, and not in `run_start.tools`,
   which every handler shares), so a plugin re-adding its own `tool()` constant keeps its `ctx.state`. lens pushes its
   constants back instead of keeping removed tool objects.
7. **`ToolCtx.parentId`** (W3): the calling tool's call id for a `ctx.runTool` call. **`toolResult({ output, value?,
   images?, isError? })`** (W1): `execute` returns text for the model and a `value` for `runTool` callers at once (a
   symbol-branded object, so plain objects stay values); **`Tool.outputSchema`** (JSON Schema of `value`) is codemode's
   declared return type (MCP tools pass the server's). web-access returns both forms and dropped its nested-call map.
8. **`ctx.pending()`** (I2): the sends waiting on the ctx's session (`{ deliver, source, message }`: the run's inbox,
   then those queued after it). intercom's `busyDelivery: "human-first"` holds incoming messages while a run goes on
   and steers one in at a turn's end only when no `source: "user"` send waits; the rest go once idle.

- Not changed: there is no `ctx.exec`; plugins run processes with `node:child_process` and pass `ctx.signal`.
  Per-run state in module maps keyed by run id is cleaned up in `run_end`; a run cut off by process exit is phase 3's
  `close` (recorded there). Per-plugin config/state files: `hortusDir()/<plugin>.json` or a `<plugin>/` dir (AGENTS.md).

**As built: final round (misc core & tooling), fixed.** The same ports (`final-gaps.md` A3, A4, P2/S3, M3–M6, W4,
C10, C12, I4) needed these; their workarounds are gone.
1. **`ctx.trust(path, { reason? })` → boolean** (P2/S3): project trust, VS Code-style: true when the path (resolved
   against `ctx.cwd`, then `realpath`) or a directory above it is in `~/.hortus/trust.json` (`{ trusted: string[] }`,
   mode 0600, written by rename under `withFileLock`; `trustedPaths`/`isTrusted`/`addTrusted`/`trustFile` in
   `secrets.ts`); else, on an interactive host, one `ctx.ask` (kind `"trust"`, `data: { path }`, options "Trust" /
   "Not now", `reason` appended to the question) shared by every caller of that path at once. "Trust" is saved; a
   refusal (or Esc) holds for the agent's life, so it is asked again in a new process; unanswered/aborted (nobody saw
   it) is forgotten; non-interactive → false without asking. Chosen over per-file trust: one answer per project
   serves every plugin. `mcp-extension`, `plannotator`, `permission-system` (besides its own `trustedProjects`) and
   `mcp-adapter` use it; mcp-adapter now trusts the project, not each server definition (its `mcp-adapter-trust.json`
   is gone), so a trusted project's changed servers aren't asked about again.
2. **`ctx.ask(req, { signal })`** (M3): the caller withdraws its question (`reason: "aborted"`, handlers' `signal`
   aborts). mcp-adapter passes the MCP request's signal to its elicitation and sampling asks.
3. **`Host.ui?: boolean`** (M5): the host will show asks to a person at some point (TUI and `--rpc` from the start;
   `--rpc` clears it when stdin closes), so a plugin seeing `interactive: false` at `ready` knows to wait for
   `interactive`. mcp-adapter's "blocked" error says whether the user will be asked.
4. **`fitEffort(effort, efforts)`**, applied by core to every request (runs, `ctx.complete`, previews) from
   `info(model).efforts` before `request` (W4): as is when taken; "off" → the lowest level; a level → the nearest below,
   else the lowest above. web-access's one-off calls just send `effort: "off"`.
5. **`temperature?`** on `CompletionRequest`/`CompleteRequest` (M4), sent by the built-in providers only when set
   (Anthropic takes it only with thinking off). mcp-adapter's sampling passes the server's.
6. **Images a `tool_result` handler adds** (M6) are saved like returned ones (temp file, `path`, an
   `[Image saved to …]` line on `output`) after the handlers.
7. **`ToolResult.durationMs`** (C10): how long `execute` ran, stamped by core before `tool_result` (and kept after it),
   saved with the result, never sent (stripped from requests like `details`); none for a handler-supplied result.
   cc-extensions shows it (finished calls, also on resume) instead of timing `tool_call` → `tool_result` itself.
   Tests compare results through `untimed(v)` (`@hortus/core/testing`), which drops `durationMs`.
8. **`Command.enabled?(ctx)`** (C12): false leaves the command out of `agent.commands()` (asked at every listing; a
   same-named earlier plugin's shows instead) and makes a stale `AgentCommand.run` throw. cc-extensions' `/context`
   and `/exit` use it instead of throwing when their setting is off. (The TUI copies `agent.commands()` once; re-reading
   is M1's.)
9. **`stateOf<S>(ctx, key, init)`** (I4): `ctx.state[key]`, made by `init()` the first time, typed; the final-round
   ports (lens, plannotator, intercom, billion-context, permission-system, web-access, cc-extensions, mcp-adapter)
   use it instead of casting `ctx.state`.
10. **`parseFrontmatter(text)`** (A3, `context.ts`): `{ meta, body }` (YAML; `{}` without frontmatter; throws on
   invalid YAML), the parser skills use. pi-subagents' agent/prompt files and workflows' agent files use it instead of
   hand-written parsers.
11. **Markdown isn't formatted** (A4): Biome 2.6 formatted `.md` and turned `---\nname: x` frontmatter into a heading,
   so skills were silently skipped. The root `biome.json` excludes `**/*.md` (pi-subagents' nested `biome.json` is
   gone); postman's skills were restored from the package, lens's SKILL.md fixed, and `context.test.ts` checks that
   every `.md` with frontmatter under `examples/plugins` parses and every SKILL.md names and describes its skill.

**As built: the final review's fixes.**
1. **`node:vm` is not a sandbox**: a codemode script reached `process` (`console.log.constructor("return process")()`)
   and so anything, while gates saw only its `tools.*` calls. `ToolEffects.code?: string[]` (keys holding code the
   tool runs with the agent's powers) is declared by `codemode` and Fabric's `fabric_exec` (`{ code: ["code"] }`),
   context-mode's `ctx_execute`/`ctx_execute_file`/`ctx_batch_execute` and workflows' `workflow`; guard asks before
   such a call ("Allow <tool> to run code?"), safety-net asks too (rule `analysis.unconfined-code` when denied or no
   one can answer), permission-system keeps asking (a tool without exec/path keys), Fabric rates it `execute`. A new
   key instead of `exec` (the review's suggestion): gates parse `exec` values as shell commands, which code isn't.
   No isolate dependency was added; the real fix (QuickJS-wasm or `isolated-vm`) is in the README's "Possible later".
2. `tool_gate`'s `tool` is the tool the frozen call names (a `tool_call` handler may rename it), not the original's.
3. A plugin replacing a `required` one is `required` itself (along a replacer chain).
4. Example tools declare effects: hashline-edit `replace`/`insert` (`reads`/`writes: ["path"]`), background-tasks
   `bg_run` (`exec: ["command"]`). lens's `ast_grep_replace` stays undeclared (it writes the whole project when
   `paths` is absent, which `effects` can't say; undeclared means unknown to gates).
5. `disabledPlugins` / `LoadOptions.disabled` (`--disable`) match `prefix*` like subrun filters and `--only`.

## Verification

- [x] **T** `record()` sees exactly the event order above for: no tools; two parallel tools; a provider throw
  (`response.error`, then `run_end.error`); abort mid-stream and mid-tool (`run_end.aborted`).
- [x] **T** `run_end` fires exactly once on every path (success, throw, abort).
- [x] **T** `run_start` removing a tool → absent from `request.tools` and a model call to it gets "unknown tool".
- [x] **T** `run_start` changing `model`/`effort` → the scripted provider sees them.
- [x] **T** `prompt` runs after `run_start`: a plugin removing `edit` in `run_start` leaves no `edit` prompt text.
- [x] **T** `request` edits apply to that call only (the next request and saved history don't have them); its
  `messages` is a copy (pushing into it doesn't change the run's history).
- [x] **T** `request.tools` adding a run tool with `exposure: "codemode"` declares it for that call only.
- [x] **T** `Tool.providerOptions` is spread into each API's tool def, only that API's key (`openai.test.ts`, "every
  provider declares a tool's jsonSchema ...").
- [x] **T** `response` pairs with `request` by id, including for `ctx.complete` (`source` = plugin name).
- [x] **T** `tool_call` setting `result` skips execution; a later handler still runs, sees `result`, and its attempt to
  clear or replace it is ignored; `tool_result` still fires.
- [x] **T** `tool_call` editing `call.input` changes what executes but not the saved assistant message or the
  in-memory history; an edit making the input invalid yields an "invalid input" result.
- [x] **T** `response.request` equals what the scripted provider received even when a later-loaded plugin edited
  `request`; `response.payload` is set by each built-in provider.
- [x] **T** `response.retry` re-sends the turn once; setting it again on the retry's response is ignored.
- [x] **T** `ctx.preview()` returns the request a run would send; the scripted provider gets no call and the session
  file is unchanged.
- [x] **T** every tool in `run_start.tools` has `plugin` set; a wrapped tool reports the wrapper.
- [x] **T** a provider wrapper reads `ctx.session` id in `complete` and sends it as a header; two concurrent subruns
  send their own ids.
- [x] **T** a scripted provider returning a call with `result` preset: no execution, `tool_call`/`tool_result` fire,
  and the run ends if that was the only call.
- [x] **T** `withToolLock`: a plugin tool and `builtin:edit` editing the same file in one batch don't interleave.
- [x] **T** a tool returning two images → both reach the scripted request (each provider's conversion test too).
- [x] **T** a `ctx.complete` inside a tool fires `request`/`response` whose handler `ctx.callId` is that tool's call.
- [x] **T** `response.meta.stopReason` is set by each built-in provider (`end`, `tool_use`, `max_tokens`).
- [x] **T** `response.meta.headers` carries the HTTP response headers (each built-in provider), so a plugin reads e.g.
  LiteLLM's `x-litellm-response-cost` from the `response` event; `litellm` then drops the variable its wrapped
  `fetch` shares with `complete`.
- [x] **T** a tool refreshes a login through its owner's `auth` via `ctx.secrets` (as `ToolContext.secrets` does since
  phase 1), and `ctx.secrets.find(type)` lists the entries of a type.
- [x] **T** a throwing `tool_call` handler → error result, tool not executed; a throwing `tool_result`/`run_start`
  handler → `onError`, run continues.
- [x] **T** `ctx.runTool` from inside a tool fires the gate with `parentId`, id `<parent>/1`, and is blocked by it.
- [x] **T** batch gating: with two calls, both `tool_call` handlers finish before either tool starts.
- [x] **T** `sequential` tool runs after the others finish, alone.
- [x] **T** `turn_end.stop = true` ends the run after that turn.
- [x] **T** `ctx.signal` aborts a long-running tool when the run is aborted.
- [x] **T** `ctx.complete({ provider, model })` reaches another configured provider; `listModels` returns all.
- [x] **T** `ctx.complete` to a provider whose `info` reports `maxOutput` sends it as `maxTokens` (in `request` too).
- [x] **T** `ctx.emit("x:y", p)` reaches every plugin's `on["x:y"]` in load order.
- [x] **T** `ctx.abort("budget")` from a `turn_end` handler ends the run; `run_end.aborted` is
  `{ by: <plugin>, reason: "budget" }`; Esc gives `{ by: "user" }`.
- [x] **T** each built-in provider emits `tool_input` deltas that concatenate to the final input.
- [x] **R** `guard`: blocks `rm -rf /` in `bash` with a reason the model sees; lets `ls` through.
- [x] **R** `tracer`: produces one root span per run, one child per request/response and per tool call, nested by
  `parentId`; failed provider calls close their span with the error.
- [x] **T** (port fix 1) `bash` runs with `ctx.env` merged into its environment; otel's `TRACEPARENT` reaches the shell
  through it.
- [x] **T** (2) every `request` carries `provider`/`type`, which the provider call doesn't get; otel reports
  `gen_ai.provider.name` from it.
- [x] **T** (3) an `optional` tool or provider wrap of nothing is skipped without `onError`; otel loads with
  `builtin:bash` disabled.
- [x] **T** (4) a `run_start` handler editing `context` changes the rendered AGENTS.md; deferred-context shows one copy
  of identical files.
- [x] **T** (5) a tool's `prompt` is in the `system` of requests declaring it, not of one whose handler removed it;
  `request` handlers don't see it, `response.request` does; reusing the sent `system` with the tool adds it once.
- [x] **T** (6) `ctx.preview()` fires `run_end` with `source: "preview"`.
- [x] **T** (7) `order: "last"` sorts after the rest, dependency order kept; deferred-context runs after a later-named
  plugin adding `write` to `request.tools`, so `write` stays deferred.
- [x] **T** (8) a `tool_result` handler replacing `result` changes the saved and sent result; a replacement without
  the call's id still answers it, a non-object one is ignored; a provider-run call's replacement is in its message,
  which follows its `tool_result`, and the CLI shows it after the text streamed before it.
- [x] **T** (9) `tool_update` carries `call`; (10) its handlers' `details` edits are what's saved.
- [x] **T** (11) `bash` streams `{ output }` updates and ends with none saved; a cut tail starts after a line break
  (or at a character); the CLI bash block shows live output without ANSI codes, a progress bar's last state, and no
  control characters; rtk-optimizer strips colour from builtin:bash's updates.
- [x] **T** (final 1) `tool_gate` sees the input a later-loaded `tool_call` mutator left, frozen; the first block is
  final; a block replaces a supplied non-error result; a throwing gate blocks (`gates.test.ts`; safety-net with a
  harmless `shred --version` probe behind a recorder: rewritten into it, and supplied as a cached result).
- [x] **T** (final 2) `tool_call.env` reaches `tool_gate` frozen and the tool's `ctx.env`.
- [x] **T** (final 3) the built-in tools' `effects`; guard, safety-net, permission-system and fabric pass with them.
- [x] **T** (final review) codemode declares `effects.code`; guard and safety-net ask before it and block it when no one
  approves, so a script's `node:vm` escape (a harmless env-var recorder) never runs; `tool_gate`'s `tool` follows a
  renamed call; a replacer of a required plugin is required; `disabledPlugins` takes `prefix*`.
- [x] **T** (final 4) a `"*"` provider wrap reads the state its plugin's handlers set; billion-context routes without
  its header.
- [x] **T** (final 5–8) `ctx.stop()` ends the run after its batch; `parentId` names the calling tool; `toolResult`'s
  fields and `outputSchema` in codemode's declaration; a pushed `tool()` constant gets its pusher's `ctx.state`;
  `ctx.pending()` lists a context send and a queued "after" one with their sources.
- [x] **T** intercom's `busyDelivery: "human-first"`: a message arriving mid-run waits behind a pending `source:
  "user"` send and arrives once idle (fails with `"steer"`).
- [x] **R** `plan-mode` (core half): with the mode on, `write`/`edit`/`bash`/`codemode` are absent from the run and the model is
  the plan model.
