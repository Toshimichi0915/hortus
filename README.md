# hortus

A terminal coding agent with a small core and everything else as plugins.

## Install

Requires Node.js 22.15 or newer.

```sh
npm i -g hortus
```

## Setup

Providers and their keys go in `~/.hortus/secrets.json` (mode 0600):

```json
{
  "anthropic": { "type": "anthropic", "apiKey": "${ANTHROPIC_API_KEY}" },
  "openai": { "type": "openai", "apiKey": "${OPENAI_API_KEY}" },
  "openrouter": { "type": "openai", "apiKey": "${OPENROUTER_API_KEY}", "endpoint": "https://openrouter.ai/api/v1" }
}
```

Pick the default model in `~/.hortus/config.json`, or with `/model <provider>/<model>` inside hortus:

```json
{ "provider": "anthropic", "model": "claude-opus-5-5" }
```

Provider types: `anthropic`, `openai` (Chat Completions, also OpenAI-compatible servers) and `openai-responses` (Responses API).

## Usage

```sh
hortus                       # TUI
hortus "fix the failing test"  # TUI, starting with a prompt
hortus -r                    # pick a session to resume
hortus -p "summarize README" # print mode: one run, print the answer, exit
hortus -p --json "..."       # every event as a JSON line
hortus --rpc                 # JSON-line commands on stdin, events on stdout
```

Common flags: `--model <provider>/<model>`, `--effort <auto|level>`, `--session <id|new|memory|key:<key>>`, `--cwd <dir>`, `--tools <name,...>`, `--append-system <text>`, `--disable`/`--only <plugin,...>`, `--plugin <file>`. An unknown flag prints the full usage.

In the TUI: `/` opens the command menu (`/new`, `/resume`, `/model`, `/effort`, `/compact`, `/theme`, `/name`, plus plugin commands and skills), Shift+Tab cycles the effort, Esc aborts a run, Ctrl+O expands tool output, Ctrl+D exits.

## What it reads

- `AGENTS.md` from `~/.hortus/` and every directory from the git root down to the working directory.
- Skills (`SKILL.md`) from `~/.hortus/skills`, `~/.agents/skills` and each project directory's `.agents/skills`.
- MCP servers from `~/.hortus/mcp.json` (the usual `mcpServers` format). Their tools are called from scripts through the `codemode` tool.
- Plugins from `~/.hortus/plugins/<dir>/hortus.json`.

Sessions are saved as JSONL under `~/.hortus/sessions/`. Set `HORTUS_HOME` to use another directory than `~/.hortus`.

## Plugins

Everything built in (tools, providers, prompt, skills, MCP, compaction, TUI commands) is a plugin, and any of them can be disabled, replaced or wrapped. A plugin is a module whose default export is `{ providers?, tools?, on?, entries?, commands? }`, plus `cli` for TUI slots, renderers and keys. A directory plugin has a manifest:

```json
{ "name": "my-plugin", "version": "1.0.0", "entrypoint": "index.js", "dependencies": { "builtin:bash": "*" } }
```

See [AGENTS.md](AGENTS.md) for the full plugin, event and session model.

## Development

```sh
pnpm install
pnpm build   # tsc -b packages/cli (builds core too)
pnpm dev     # build, then run the CLI
pnpm test    # build, then node --test over dist
pnpm lint
```

Packages: `@hortus/core` (providers, agent loop, sessions, plugins), `@hortus/cli` (Ink TUI and modes), `hortus` (the installable `hortus` binary).

## License

MIT
