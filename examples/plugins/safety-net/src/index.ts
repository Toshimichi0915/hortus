import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Ctx, type GatedCall, type Plugin, projectRoot, type ToolEffects } from "@hortus/core";
import {
  analyzePowerShell,
  analyzeShell,
  CATALOG,
  checkPath,
  gate,
  type Hit,
  type Intent,
  OTHER_INTENTS,
  type State,
} from "./analyze.ts";
import { loadPolicy, type Policy, userDir } from "./policy.ts";
import { SECRET_RULES } from "./secrets.ts";

const INTENT_TEXT: Record<Intent, string> = {
  hard_stop:
    "Do not retry this operation or attempt any workaround (other tools, flags, or paths). Report the block to the user and continue with the rest of the task.",
  use_alternative: "Do not retry the blocked form. Continue the task using the safer alternative described above.",
  scope_down:
    "Retry with a narrower, explicit target as described above. Escalate to the user if the broad operation is truly required.",
  manual_only:
    "If this operation is truly needed, ask the user for explicit permission and have them run the command manually.",
  stop_and_explain:
    "Do not brute-force variants. Simplify or restructure the command so it can be analyzed, or report the block to the user.",
};

/** input keys that name a file, in tools that don't declare `effects` (the original's list, for MCP and plugin tools) */
const PATH_KEYS = new Set([
  "absolutepath",
  "destination",
  "directorypath",
  "directory_path",
  "file",
  "file_path",
  "filepath",
  "include",
  "notebook_path",
  "path",
  "paths",
  "searchdirectory",
  "search_directory",
  "searchpath",
  "targetfile",
  "target_file",
  "dir_path",
]);
const WRITE_TOOL = /write|edit|patch|create|delete|remove|move|rename|replace|append/i;

const intentOf = (id: string): Intent =>
  CATALOG[id]?.intent ?? OTHER_INTENTS[id] ?? (id.startsWith("custom.") ? "manual_only" : "hard_stop");

const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}...` : s);

/** The denial the model reads (the original's layout). */
export function format(hit: Hit, info: { tool: string; command?: string; cwd: string; warning?: string }): string {
  return [
    "BLOCKED by CC Safety Net",
    `Reason: ${hit.reason}`,
    `Rule: ${hit.id}`,
    `Tool: ${info.tool}`,
    info.command && `Command: ${clip(info.command)}`,
    hit.segment && hit.segment !== info.command && `Segment: ${clip(hit.segment)}`,
    `Working directory: ${clip(info.cwd)}`,
    info.warning && `Config warning: ${info.warning}`,
    INTENT_TEXT[intentOf(hit.id)],
  ]
    .filter(Boolean)
    .join("\n\n");
}

const stateFor = (policy: Policy, cwd: string): State => ({
  policy,
  anchor: cwd,
  cwd,
  depth: 0,
  env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")),
});

const strings = (v: unknown) => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string" && !!x);

/**
 * What a tool call would do, and the rule it breaks, if any: by the tool's `effects` (its command and path keys) when
 * it declares them, else guessed from its name and input keys.
 */
export function check(
  call: Pick<GatedCall, "name" | "input">,
  policy: Policy,
  cwd: string,
  effects?: ToolEffects,
): Hit | null {
  const st = stateFor(policy, cwd);
  const input = (call.input ?? {}) as Record<string, unknown>;
  if (call.name === "powershell") {
    const command = input.command;
    return typeof command === "string" && command.trim() ? analyzePowerShell(command, st) : null;
  }
  const exec = effects ? (effects.exec ?? []) : call.name === "bash" ? ["command"] : [];
  for (const command of exec.flatMap((k) => strings(input[k]))) {
    const hit = command.trim() ? analyzeShell(command, st) : null;
    if (hit) return hit;
  }
  const paths: [string, "read" | "write"][] = effects
    ? [
        ...(effects.writes ?? []).flatMap((k) => strings(input[k]).map((p): [string, "write"] => [p, "write"])),
        ...(effects.reads ?? []).flatMap((k) => strings(input[k]).map((p): [string, "read"] => [p, "read"])),
      ]
    : call.name === "bash"
      ? []
      : Object.entries(input)
          .filter(([k]) => PATH_KEYS.has(k.toLowerCase()))
          .flatMap(([, v]) =>
            strings(v).map((p): [string, "read" | "write"] => [p, WRITE_TOOL.test(call.name) ? "write" : "read"]),
          );
  for (const [path, mode] of paths) {
    const hit = checkPath(path, mode, st, path);
    if (hit) return hit;
  }
  return null;
}

/** One denial in the audit log: `<user dir>/logs/<cwd>/<YYYY-MM>/<YYYY-MM-DD>-<session>.jsonl`. */
function audit(hit: Hit, call: GatedCall, ctx: Ctx, level: string) {
  const ts = new Date().toISOString();
  const session = (ctx.session?.id ?? "no-session").replace(/[^A-Za-z0-9_.-]+/g, "_");
  const dir = join(userDir(), "logs", ctx.cwd.replace(/[^A-Za-z0-9]/g, "-").slice(0, 180), ts.slice(0, 7));
  const command = (call.input as { command?: unknown })?.command;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = {
      ts,
      sessionId: session,
      decision: "deny",
      agent: "hortus",
      level,
      toolName: call.name,
      ...(typeof command === "string" && { command: command.slice(0, 10_000) }),
      segment: hit.segment,
      reason: hit.reason,
      ruleId: hit.id,
      cwd: ctx.cwd,
    };
    appendFileSync(join(dir, `${ts.slice(0, 10)}-${session}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {}
  // ponytail: no retention pruning (audit.retention_days); add it when logs grow
}

async function policyFor(cwd: string): Promise<Policy> {
  return loadPolicy((await projectRoot(cwd)) ?? cwd);
}

const OPERATOR_DOC = `# CC Safety Net (hortus)

CC Safety Net is a hortus plugin that checks every tool call (bash commands, file tools, and calls made from codemode scripts, subagents and other nested runs) before it runs, and blocks destructive commands and secret access. It parses what a command does: wrapping it (\`sudo\`, \`env\`, \`bash -c\`, \`python -c\`, \`xargs\`, \`find -exec\`) or reordering flags doesn't hide it. Code a tool runs (a codemode script) can't be analyzed, so you are asked before it runs (blocked when no one can answer). It is not a sandbox.

## Commands (the user's, not tools)

- \`/safety-net status\`: the effective level, capabilities and the policy files loaded.
- \`/safety-net explain <command>\`: the verdict for a command, without running it.
- \`/safety-net rules\`: every built-in rule and whether it is on.
- \`/safety-net logs\`: recent denials from the audit log.

## Configuration

- Levels: \`standard\` (default), \`strict\` (fail closed: unparseable commands, dynamic targets, uploads), \`paranoid\` (strict plus blocking every rm -rf outside temp roots and every interpreter one-liner). Set per session with \`CC_SAFETY_NET_LEVEL\`, or in \`policy.json\` (\`safety.level\`).
- \`policy.json\` lives in the user scope (\`$CC_SAFETY_NET_HOME\`, default \`~/.hortus/safety-net/\`) and the project scope (\`<project>/.cc-safety-net/\`, committed). Fields: \`safety.level\`, \`safety.overrides\` (\`fail_closed\`, \`paranoid_rm\`, \`paranoid_interpreters\`), \`workflow.worktree_mode\`, \`destructive_command_protection\` (\`enabled\`, \`overrides\` of rule ids to "on"/"off", \`allow_paths\`), \`secret_protection\` (\`enabled\`, \`overrides\`, \`allow_paths\`, \`deny_paths\`). Catastrophic rules (deleting root, home or .git) can't be turned off.
- Both \`policy.json\` files are protected: you may read them and propose a change in another file, but only the user may apply it.
- Custom rules only add blocks: \`<scope>/rule.json\` (\`{ "rules": ["name"] }\`) names rulebooks at \`<scope>/rules/<name>/rulebook.json\` (\`{ "name", "rules": [{ "name", "command", "subcommand"?, "block_args": [...], "match"?: { "command_path", "any_args", "exclude_args" }, "reason" }] }\`). They are read on every tool call.

## Explain a block

Run \`/safety-net explain\` (or read the block's Rule line), say in plain language what the rule guards against, and suggest the safer alternative its reason names (e.g. \`git stash\` before \`git reset --hard\`). A false positive in a built-in rule can only be relaxed by the user, with a per-rule override in their policy.

## Safety rules

Help the user operate CC Safety Net, never evade it. Do not change levels, edit the policy, or propose a weaker policy to get a blocked command through unless the user explicitly asks for that outcome and understands what the block guards against.`;

const DEFAULT_REQUEST = "Help me with CC Safety Net.";

/**
 * cc-safety-net: every tool call passes a command analyzer before it runs (`tool_gate`, which also sees codemode
 * scripts' calls, nested `ctx.runTool` calls and subruns'). A tool running code (`effects.code`: e.g. fabric_exec,
 * whose `node:vm` is no sandbox; builtin codemode runs in QuickJS and needs none) asks the user first, blocked when no one can answer. A denial becomes the call's error result, in the original's
 * format, and a line in the audit log. `tool_gate` runs after every `tool_call` handler, which may rewrite the input
 * (rtk-optimizer does), on the frozen input that runs, and its block wins over a result a `tool_call` handler supplied.
 * `"required": true` keeps it in every subrun whatever its plugin filter (and under `--only`).
 */
export default {
  on: {
    tool_gate: async (p, ctx) => {
      if (p.block !== undefined) return;
      const policy = await policyFor(ctx.cwd);
      let hit = check(p.call, policy, ctx.cwd, p.tool?.effects);
      // code (`effects.code`, e.g. a node:vm program) can do anything this analyzer can't see:
      // the user decides, and with no one to ask it is blocked
      if (!hit && p.tool?.effects?.code?.length) {
        const answer = await ctx.ask({
          question: `CC Safety Net can't analyze code: allow ${p.call.name} to run it? It can do anything.`,
          options: [{ label: "Deny" }, { label: "Allow" }],
        });
        if (answer !== "Allow")
          hit = {
            id: "analysis.unconfined-code",
            reason: `${p.call.name} runs code that can do anything, which CC Safety Net can't analyze, and ${answer === undefined ? "no one approved it" : "the user denied it"}`,
          };
      }
      if (!hit) return;
      audit(hit, p.call, ctx, policy.level);
      const command = (p.call.input as { command?: unknown })?.command;
      p.block = format(hit, {
        tool: p.call.name,
        ...(typeof command === "string" && { command }),
        cwd: ctx.cwd,
        ...(policy.warnings.length && { warning: policy.warnings.join("; ") }),
      });
    },
  },
  commands: [
    {
      name: "cc-safety-net",
      description: "Operate CC Safety Net: explain blocks, rules, configuration",
      args: "[request]",
      run: (arg, ctx) => {
        const text = `${OPERATOR_DOC}\n\n## User request\n\n${arg.trim() || DEFAULT_REQUEST}`;
        // a turn now when idle, else once the running one ends (Pi's followUp)
        void ctx.send(text, { deliver: ctx.busy() ? "after" : "steer" }).catch(() => {});
      },
    },
    {
      name: "safety-net",
      description: "CC Safety Net status, explain <command>, rules, logs",
      args: "[status | explain <command> | rules | logs]",
      complete: () => ["status", "explain", "rules", "logs"].map((value) => ({ value })),
      run: async (arg, ctx) => {
        const [sub = "status", ...rest] = arg.trim().split(/\s+/);
        const policy = await policyFor(ctx.cwd);
        if (sub === "explain") {
          const command = arg.trim().slice("explain".length).trim();
          if (!command) throw new Error("Usage: /safety-net explain <command>");
          const hit = check({ name: "bash", input: { command } }, policy, ctx.cwd);
          return hit ? format(hit, { tool: "bash", command, cwd: ctx.cwd }) : `ALLOWED: ${command}`;
        }
        if (sub === "rules") {
          const st = stateFor(policy, ctx.cwd);
          const lines = Object.keys(CATALOG).map((id) => `${gate(st.policy, id, "") ? "on " : "off"} ${id}`);
          return [...lines, `secret rules: ${SECRET_RULES.length}`, ...policy.rules.map((r) => `on  ${r.id}`)].join(
            "\n",
          );
        }
        if (sub === "logs") {
          const n = Number(rest[0]) || 10;
          const lines: string[] = [];
          const walk = (d: string) => {
            for (const e of (() => {
              try {
                return readdirSync(d, { withFileTypes: true });
              } catch {
                return [];
              }
            })())
              if (e.isDirectory()) walk(join(d, e.name));
              else if (e.name.endsWith(".jsonl"))
                lines.push(...readFileSync(join(d, e.name), "utf8").trim().split("\n"));
          };
          walk(join(userDir(), "logs"));
          const entries = lines
            .flatMap((l) => {
              try {
                return [
                  JSON.parse(l) as { ts: string; ruleId: string; toolName: string; command?: string; segment?: string },
                ];
              } catch {
                return [];
              }
            })
            .sort((a, b) => a.ts.localeCompare(b.ts))
            .slice(-n);
          return entries.length
            ? entries.map((e) => `${e.ts} ${e.ruleId} ${e.toolName}: ${clip(e.command ?? e.segment ?? "")}`).join("\n")
            : "No denials logged.";
        }
        if (sub !== "status") throw new Error(`Unknown subcommand: ${sub}`);
        return [
          `level: ${policy.level}`,
          `fail_closed: ${policy.failClosed}, paranoid_rm: ${policy.paranoidRm}, paranoid_interpreters: ${policy.paranoidInterpreters}, worktree_mode: ${policy.worktree}`,
          `destructive protection: ${policy.destructive.enabled ? "on" : "off"}, secret protection: ${policy.secret.enabled ? "on" : "off"}`,
          `policy files: ${policy.files.join(", ")}`,
          `custom rules: ${policy.rules.length}`,
          ...policy.warnings.map((w) => `warning: ${w}`),
        ].join("\n");
      },
    },
  ],
} satisfies Plugin;
