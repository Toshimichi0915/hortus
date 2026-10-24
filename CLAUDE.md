# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

phi is a terminal coding agent (TypeScript, pnpm workspace): `@phi/core` (providers, tool loop, sessions, plugins) and `@phi/cli` (commander + Ink TUI).

## Commands

```sh
pnpm build          # tsc -b packages/cli (project references build core too)
pnpm dev            # build, then run node packages/cli/dist/index.js
pnpm test           # build, then node --test over packages/*/dist/**/*.test.js
pnpm lint           # biome lint
pnpm format         # biome format --write
```

Tests run from compiled `dist/`, so build first. Single test file: `pnpm build && node --test packages/core/dist/session.test.js` (add `--test-name-pattern "<name>"` to pick one test). Tests use `node:test` + `node:assert/strict`, colocated as `*.test.ts(x)`.

## Conventions

- Source imports use `.ts`/`.tsx` extensions; `rewriteRelativeImportExtensions` rewrites them on emit. ESM only, `verbatimModuleSyntax` (use `import type`), `noUncheckedIndexedAccess`.
- Prefer `interface` over `type` for object shapes; use `type` only for unions, intersections, and other aliases an interface can't express.
- Biome: 2-space indent, 120 cols, double quotes, organized imports.
- `// ponytail:` comments mark deliberate shortcuts with a known ceiling and upgrade path.

## Architecture

- **Provider-neutral messages** (`core/src/llm.ts`): `Message` is `user | assistant | tool`. Each provider (`providers/*.ts`) converts to/from its own API. Assistant messages may carry `raw: { provider, content }`, replayed verbatim only to the same provider (e.g. Anthropic thinking blocks); other providers rebuild from `text`/`toolCalls`. Anthropic sanitizes foreign tool-call ids. OpenRouter is just `openaiProvider` with a `baseURL`.
- **Plugins** (`plugins.ts`, `builtin.ts`): a plugin's default export is `{ providers?, tools?, on? }`; `on` handles `Events` (`llm.ts`: `session_start`, `text`, `tool_call`, `message`), run in plugin order with mutable payloads. builtin's `session_start` pushes the base system prompt. `builtin` (openrouter/openai/anthropic + read/write/bash tools) loads first, then every `~/.phi/plugins/<dir>/phi.json` (`name`, `version`, `entrypoint`, `dependencies`/`optionalDependencies` as `{ name: npm-style range }`, checked with `semver`; dependencies load first, missing required ones or cycles throw); later plugins override providers and tools by name. Define tools with the `tool()` helper (zod input schema, converted via `z.toJSONSchema`).
- **Agent loop** (`agent.ts`): `createAgent(plugin?)` loads config and plugins once (`plugin` last; it's how callers observe a run, as `app.tsx` does); its `run(history, { model?, provider? })` resolves provider/model/key per run, emits `session_start` to build the system prompt, then loops up to 50 steps, running tool calls in parallel and emitting `text` / `tool_call` / `message`. Tool errors and invalid input are returned to the model as `isError` results, not thrown. Model precedence: override → `config.model` (only if the provider is `config.provider`) → provider `defaultModel`.
- **State in `~/.phi`**: `config.json` (provider, model), `plugins/`, `secrets.json` (API keys per provider, mode 0600; keys are passed explicitly so SDKs never read env vars), `sessions/<epoch>_<uuid>.jsonl`.
- **Sessions** (`session.ts`): append-only JSONL of entries forming a tree via `parentId`; state is rebuilt by replaying root→leaf through versioned `parsers` (`v` + `type`; unknown lines skipped). Resuming from an earlier entry branches within the same file. `model` entries snapshot both model and provider per branch. Adding a new entry type = new `EntryBody` variant + parser.
- **CLI** (`cli/src`): `index.tsx` defines commands (`phi`, `phi -r [uuid]`, `phi config [set-provider|set-model|set-key|models]`). `app.tsx` runs the agent and handles `/model` and `/provider` in-session commands. `transcript.tsx` does its own wrapping, scrolling, mouse selection and copy (alternate screen + SGR mouse reporting); `entry.ts`'s global `transcript` is reprinted to normal scrollback on exit.
