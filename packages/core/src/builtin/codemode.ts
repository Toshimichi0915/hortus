import { codemodeDescription, codemodeTool, type Piece, version } from "../index.ts";

const has = (tools: readonly { name: string; exposure?: string }[], name: string, exposure?: string) =>
  tools.some((t) => t.name === name && (!exposure || t.exposure === exposure));

/**
 * The `codemode` tool, declared only while the run has tools with `exposure: "codemode"` (whichever plugin made them),
 * its description declaring every tool its scripts can call (the run's, so one removed in `run_start` is out of reach).
 * A model's direct call to a codemode-only tool is told how to reach it. Without `codemode` in the run (removed in
 * `run_start`), codemode-only tools are declared directly instead.
 */
export default {
  name: "builtin:codemode",
  version,
  plugin: {
    tools: [codemodeTool],
    on: {
      request: (r, ctx) => {
        if (r.source !== "run" && r.source !== "preview") return;
        const callable = ctx.tools.filter((t) => t.name !== "codemode");
        const only = callable.filter((t) => t.exposure === "codemode");
        // no codemode host in the run (codemode removed by a run_start handler): its tools are declared directly, so
        // they stay reachable
        if (!ctx.tools.some((t) => t.codemodeHost))
          return void r.tools.push(...only.filter((t) => !r.tools.includes(t)));
        const i = r.tools.findIndex((t) => t.name === "codemode");
        const self = r.tools[i];
        if (!self) return;
        if (!only.length) r.tools.splice(i, 1);
        else r.tools[i] = { ...self, description: codemodeDescription(callable) };
      },
      tool_result: ({ call, result }, ctx) => {
        if (result.output !== `Unknown tool: ${call.name}` || call.parentId) return;
        if (has(ctx.tools, call.name, "codemode") && has(ctx.tools, "codemode"))
          result.output += ` (it is only reachable from codemode: call \`await tools.${call.name.replace(/\W/g, "_")}(input)\` in a codemode script)`;
      },
    },
  },
} satisfies Piece;
