import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type CompletionRequest, createAgent, hortusDir, type ToolCall } from "@hortus/core";
import { composeTools } from "@hortus/cli/testing";
import { record, scripted, tempHome } from "@hortus/core/testing";

const dir = fileURLToPath(new URL("..", import.meta.url));

/** A stdio MCP server: `echo-it` (reports progress), `wait` (until cancelled), `cancelled`, `pid`, and one resource. */
const server = `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
const s = new McpServer({ name: "t", version: "1.0.0" }, { instructions: "Be nice." });
let cancelled = false;
s.registerTool("echo-it", { description: "Echoes", inputSchema: { msg: z.string() }, annotations: { readOnlyHint: true } },
  async ({ msg }, extra) => {
    const token = extra._meta?.progressToken;
    if (token !== undefined)
      await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2, message: "half way" } });
    // the SDK drops a notification that arrives in the same chunk as the result
    if (token !== undefined) await new Promise((r) => setTimeout(r, 20));
    return { content: [{ type: "text", text: "echo " + msg }] };
  });
s.registerTool("wait", { description: "Waits until cancelled" }, (extra) =>
  new Promise((done) => extra.signal.addEventListener("abort", () => { cancelled = true; done({ content: [] }); })));
s.registerTool("cancelled", { description: "Whether wait was cancelled" }, async () => ({ content: [{ type: "text", text: String(cancelled) }] }));
s.registerTool("pid", { description: "The pid" }, async () => ({ content: [{ type: "text", text: String(process.pid) }] }));
s.registerResource("readme", "file:///readme", { mimeType: "text/plain" }, async (uri) => ({ contents: [{ uri: uri.href, text: "hello resource" }] }));
await s.connect(new StdioServerTransport());
`;
// cwd: this plugin, so the script resolves the SDK from examples/plugins/node_modules
const stdio = { command: process.execPath, args: ["--input-type=module", "-e", server], cwd: dir };

const call = (name: string, input: unknown = {}, id = name): ToolCall => ({ id, name, input });
const names = (r?: CompletionRequest) => r?.tools.map((t) => t.name) ?? [];
const lastResults = (r?: CompletionRequest) => {
  const m = r?.messages.at(-1);
  return m?.role === "tool" ? m.results.map((x) => x.output) : [];
};

/** A temp home whose mcp.json is `mcp`, and a temp project (cwd) whose `.hortus/mcp.json` is `project`. */
async function setup(t: TestContext, mcp: unknown, project?: unknown) {
  t.after(await tempHome({ plugins: { "mcp-extension": dir } }));
  await writeFile(join(hortusDir(), "mcp.json"), JSON.stringify(mcp));
  const cwd = process.cwd();
  const proj = await mkdtemp(join(tmpdir(), "mcp-ext-"));
  t.after(async () => {
    process.chdir(cwd);
    await rm(proj, { recursive: true, force: true });
  });
  await mkdir(join(proj, ".git"));
  if (project) {
    await mkdir(join(proj, ".hortus"));
    await writeFile(join(proj, ".hortus", "mcp.json"), JSON.stringify(project));
  }
  process.chdir(proj);
}

test("mcp-extension: eager, lazy, extension and project servers; mid-run connect; progress; resources; commands", async (t) => {
  await setup(
    t,
    {
      settings: { maxRetries: 0 },
      mcpServers: {
        echo: { ...stdio, lifecycle: "eager" },
        lazy: stdio,
        broken: { command: process.execPath, args: ["-e", "process.exit(1)"], lifecycle: "eager" },
        // overridden off by the project
        off: { ...stdio, lifecycle: "eager" },
      },
    },
    { mcpServers: { proj: { ...stdio, lifecycle: "eager" }, off: { enabled: false } } },
  );
  const asked: string[] = [];
  const rec = record();
  const provider = scripted([
    { toolCalls: [call("mcp_echo_echo_it", { msg: "hi" })] },
    { toolCalls: [call("mcp_connect", { name: "lazy" })] },
    { toolCalls: [call("mcp_lazy_echo_it", { msg: "late" })] },
    { toolCalls: [call("mcp_read_resource", { server: "echo", uri: "file:///readme" }), call("mcp_status")] },
    { text: "done" },
  ]);
  const agent = await createAgent({
    host: { kind: "test", interactive: true },
    extra: [
      {
        name: "ext",
        plugin: {
          on: {
            mcp_servers: (p) => {
              p.servers.ext = stdio;
              // mcp.json wins the name
              p.servers.echo = { command: "nonexistent" };
            },
            ask: (p) => {
              asked.push(p.question);
              p.resolve("Trust");
            },
          },
        },
      },
      { name: "scripted", plugin: { providers: { scripted: provider } } },
      { name: "rec", plugin: rec },
    ],
  });
  t.after(() => agent.close());

  // builtin:mcp is replaced: its codemode-only tools never appear
  const end = await agent.run("go");
  assert.equal(end?.error, undefined);
  assert.equal(asked.length, 1);
  assert.match(asked[0] ?? "", /\.hortus\/mcp\.json/);

  const first = provider.requests[0];
  const mcp = names(first).filter((n) => n.startsWith("mcp_") && n.includes("_echo_it"));
  // sorted, whatever order the servers connected in; no lazy or overridden-off server
  assert.deepEqual(mcp, ["mcp_echo_echo_it", "mcp_ext_echo_it", "mcp_proj_echo_it"]);
  assert.ok(names(first).includes("mcp_status"));
  assert.ok(!names(first).some((n) => n.startsWith("mcp__")));
  const echo = first?.tools.find((x) => x.name === "mcp_echo_echo_it");
  assert.match(echo?.description ?? "", /Echoes \[read-only\]/);
  // declared with the server's schema as is; its annotations are structured too
  assert.deepEqual((echo?.jsonSchema as { required?: unknown } | undefined)?.required, ["msg"]);
  assert.deepEqual(echo?.meta, { mcp: { server: "echo", tool: "echo-it", annotations: { readOnlyHint: true } } });

  assert.deepEqual(lastResults(provider.requests[1]), ["echo hi"]);
  const updates = rec.events
    .filter((e) => e.name === "tool_update")
    .map((e) => (e.payload as { details: unknown }).details);
  // one per echo call (hi, late)
  assert.deepEqual(updates, [{ mcpProgress: "half way" }, { mcpProgress: "half way" }]);
  // connected mid-run: declared from the next request on, after the run_start ones
  assert.match(
    lastResults(provider.requests[2])[0] ?? "",
    /MCP server lazy ready; 4 tools discovered and active\.\nInstructions: Be nice\./,
  );
  assert.ok(names(provider.requests[2]).includes("mcp_lazy_echo_it"));
  assert.deepEqual(lastResults(provider.requests[3]), ["echo late"]);
  const [resource, status] = lastResults(provider.requests[4]);
  assert.equal(resource, "hello resource");
  const rows = JSON.parse(status ?? "[]") as { name: string; state: string; source: string; lifecycle: string }[];
  assert.deepEqual(
    rows.map((r) => [r.name, r.state, r.source, r.lifecycle]),
    [
      ["ext", "ready", "extension", "eager"],
      ["echo", "ready", "global", "eager"],
      ["lazy", "ready", "global", "lazy"],
      ["broken", "failed", "global", "eager"],
      ["off", "stopped", "project", "lazy"],
      ["proj", "ready", "project", "eager"],
    ],
  );

  const errors = rec.events.filter((e) => e.name === "notify" && (e.payload as { level: string }).level === "error");
  assert.equal(errors.length, 1);
  assert.match(String((errors[0]?.payload as { text?: string } | undefined)?.text), /Failed to start broken/);

  // commands
  const cmd = (name: string) => {
    const c = agent.commands().find((x) => x.name === name);
    assert.ok(c, name);
    return c;
  };
  assert.match((await cmd("mcp").run("")) ?? "", /^MCP: 4\/6 servers ready\n {2}✓ ext \(ready\)/);
  assert.match((await cmd("mcp").run("echo")) ?? "", /Tools: 4\/4 active/);
  assert.deepEqual((await cmd("mcp").complete?.())?.map((c) => c.value).sort(), [
    "broken",
    "echo",
    "ext",
    "lazy",
    "off",
    "proj",
  ]);
  assert.match((await cmd("mcp:resources").run("")) ?? "", /echo: 1 resources, 0 templates/);
  assert.match((await cmd("mcp:resources").run("echo")) ?? "", /file:\/\/\/readme \(text\/plain\)/);
  assert.match((await cmd("mcp:resources").run("echo file:///readme")) ?? "", /hello resource/);
  assert.equal(await cmd("mcp:stop").run("echo"), "mcp-extension: Stopped echo");
  assert.ok(!agent.ctx.tools.some((x) => x.name === "mcp_echo_echo_it"));
  assert.match((await cmd("mcp:start").run("echo")) ?? "", /Started echo \(4 tools\)/);
  assert.ok(agent.ctx.tools.some((x) => x.name === "mcp_echo_echo_it"));
});

test("mcp-extension: a host not yet interactive at ready asks about the project's servers at `interactive`", async (t) => {
  await setup(t, { mcpServers: {} }, { mcpServers: { proj: { ...stdio, lifecycle: "eager" } } });
  const asked: string[] = [];
  const host = { kind: "test", interactive: false };
  const agent = await createAgent({
    host,
    extra: [
      {
        name: "ask",
        plugin: {
          on: {
            ask: (p) => {
              asked.push(p.question);
              p.resolve("Trust");
            },
          },
        },
      },
    ],
  });
  t.after(() => agent.close());
  assert.deepEqual(asked, []);
  assert.ok(!agent.ctx.tools.some((x) => x.name === "mcp_proj_echo_it"));
  host.interactive = true;
  await agent.ctx.emit("interactive", {});
  assert.equal(asked.length, 1);
  assert.ok(agent.ctx.tools.some((x) => x.name === "mcp_proj_echo_it"));
});

test("mcp-extension: aborting a run cancels the MCP call; close stops every server", async (t) => {
  await setup(t, { mcpServers: { echo: { ...stdio, lifecycle: "eager" } } });
  const provider = scripted([{ toolCalls: [call("mcp_echo_wait")] }, { text: "unreached" }]);
  const agent = await createAgent({
    extra: [
      {
        name: "abort",
        plugin: { on: { tool_call: (_, ctx) => void setTimeout(() => ctx.abort("test"), 200) } },
      },
      { name: "scripted", plugin: { providers: { scripted: provider } } },
    ],
  });
  const end = await agent.run("go");
  assert.ok(end?.aborted);
  const run = async (name: string) => (await agent.ctx.runTool(call(`mcp_echo_${name}`))).output;
  // notifications/cancelled reached the server
  let cancelled = "false";
  for (let i = 0; i < 50 && cancelled !== "true"; i++) {
    cancelled = await run("cancelled");
    if (cancelled !== "true") await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(cancelled, "true");
  const pid = Number(await run("pid"));
  await agent.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("mcp-extension: the TUI draws a running MCP tool's progress under its block", async () => {
  const { default: plugin } = await import("./index.tsx");
  const block = composeTools([plugin], undefined, (e) => assert.fail(e))("mcp_echo_echo_it");
  const view = { call: call("mcp_echo_echo_it", { msg: "hi" }), width: 60 };
  assert.match(block.text({ ...view, details: { mcpProgress: "half way" } }), /\nhalf way$/);
  assert.doesNotMatch(
    block.text({ ...view, details: { mcpProgress: "half way" }, result: { id: "x", output: "echo hi" } }),
    /half way/,
  );
});
