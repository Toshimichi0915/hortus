import type { Plugin } from "@hortus/core";

/** Shell commands never run, and why: the model sees the reason in the call's error result. */
const RULES: { pattern: RegExp; reason: string }[] = [
  {
    // rm with both -r (or -R) and -f (any spelling) on /, /*, ~, $HOME or ${HOME}, quoted or not
    pattern:
      /\brm\s+(?=(?:\S+\s+)*?-(?:[a-zA-Z]*[rR]|-recursive))(?=(?:\S+\s+)*?-(?:[a-zA-Z]*f|-force))(?:-\S+\s+)*(["']?)(?:\/\*?|~\/?|\$\{?HOME\}?\/?)\1\/?(?:\s|;|&|\||$)/,
    reason: "it would delete the whole filesystem or home directory",
  },
  { pattern: /--no-preserve-root/, reason: "it disables rm's protection of /" },
];

const strings = (v: unknown) => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");

/**
 * Blocks dangerous shell commands in `tool_gate`, after every `tool_call` handler (so it judges the input that runs),
 * before they run: the call gets an error result with the reason, so the model can try something else. Asks before
 * every file write and every code run (`effects.code`: a codemode script, which can do anything since `node:vm` is not
 * a sandbox; only its `tools.*` calls pass this gate on their own) (`ctx.ask`): anything but "Allow" (a denial, a
 * dismissed dialog, or no one to ask) blocks it. Which input is a command, a written path or code comes from the
 * tool's `effects` (builtin `bash`/`write`/`edit`/`codemode` declare them).
 * Calls a tool makes through `ctx.runTool` pass the same gate, codemode scripts' included; `"required": true` in
 * hortus.json keeps it in every subrun, whatever its plugin filter.
 */
export default {
  on: {
    tool_gate: async (p, ctx) => {
      if (p.block !== undefined) return;
      const input = (p.call.input ?? {}) as Record<string, unknown>;
      const effects = p.tool?.effects;
      for (const command of (effects?.exec ?? []).flatMap((k) => strings(input[k]))) {
        const rule = RULES.find((r) => r.pattern.test(command));
        if (rule) {
          p.block = `Blocked by guard: ${rule.reason}`;
          return;
        }
      }
      // code (a codemode script: node:vm is no sandbox) can do anything unseen by this gate: ask, like a write
      const writes = (effects?.writes ?? []).flatMap((k) => strings(input[k]));
      const [question, noun] = effects?.code?.length
        ? [`Allow ${p.call.name} to run code? It can do anything.`, "the code"]
        : [`Allow writing ${writes.join(", ")}?`, "the write"];
      if (!effects?.code?.length && !writes.length) return;
      const answer = await ctx.ask({ question, options: [{ label: "Deny" }, { label: "Allow" }] });
      // fail closed: no one to ask is a no
      if (answer !== "Allow")
        p.block = `Blocked by guard: ${answer === undefined ? `no one approved ${noun}` : `the user denied ${noun}`}`;
    },
  },
} satisfies Plugin;
