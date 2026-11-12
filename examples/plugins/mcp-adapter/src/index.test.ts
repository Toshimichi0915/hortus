import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type AskEvent,
  type CompletionRequest,
  createAgent,
  hortusDir,
  type LoadOptions,
  openSession,
  type ToolCall,
} from "@hortus/core";
import { composeTools } from "@hortus/cli/testing";
import { record, scripted, tempDir, tempHome, type Turn } from "@hortus/core/testing";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const dir = fileURLToPath(new URL("..", import.meta.url));

/** A stdio MCP server; with LOG set, it appends a line to that file each time it starts. */
const server = `
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
if (process.env.LOG) appendFileSync(process.env.LOG, "start\\n");
const s = new McpServer({ name: "t", version: "1.0.0" }, { instructions: "Be nice." });
s.registerTool("echo-it", { description: "Echoes a message", inputSchema: { msg: z.string() }, annotations: { readOnlyHint: true } },
  async ({ msg }, extra) => {
    const token = extra._meta?.progressToken;
    if (token !== undefined) {
      await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2, message: "half way" } });
      await new Promise((r) => setTimeout(r, 20));
    }
    return { content: [{ type: "text", text: "echo " + msg }] };
  });
s.registerTool("delete_thing", { description: "Deletes a thing", inputSchema: { id: z.number() }, annotations: { destructiveHint: true } },
  async ({ id }) => ({ content: [{ type: "text", text: "deleted " + id }] }));
s.registerTool("big", { description: "Lots of output" }, async () =>
  ({ content: [{ type: "text", text: Array.from({ length: 300 }, (_, i) => "line " + i).join("\\n") }] }));
s.registerTool("structured", { description: "Structured", outputSchema: { n: z.number() } }, async () =>
  ({ content: [{ type: "text", text: "n is 7" }], structuredContent: { n: 7 } }));
s.registerTool("ask-name", { description: "Asks the user's name" }, async () => {
  const r = await s.server.elicitInput({ message: "Who are you?", requestedSchema: { type: "object",
    properties: { name: { type: "string", title: "Name" }, age: { type: "integer" } }, required: ["name"] } });
  return { content: [{ type: "text", text: r.action === "accept" ? "Hello " + r.content.name + " (" + r.content.age + ")" : r.action }] };
});
s.registerTool("sample", { description: "Samples the client's model" }, async () => {
  const r = await s.server.createMessage({ messages: [{ role: "user", content: { type: "text", text: "sample me" } }], maxTokens: 50 });
  return { content: [{ type: "text", text: "model said: " + r.content.text }] };
});
s.registerResource("readme", "file:///readme", { mimeType: "text/plain" }, async (uri) => ({ contents: [{ uri: uri.href, text: "hello resource" }] }));
s.registerPrompt("greet", { description: "Greets someone", argsSchema: { name: z.string() } },
  ({ name }) => ({ messages: [{ role: "user", content: { type: "text", text: "Hello " + name } }] }));
await s.connect(new StdioServerTransport());
`;
// cwd: this plugin, so the script resolves the SDK from examples/plugins/node_modules
const stdio = (log?: string) => ({
  command: process.execPath,
  args: ["--input-type=module", "-e", server],
  cwd: dir,
  ...(log && { env: { LOG: log } }),
});

const call = (name: string, input: unknown = {}, id = `${name}-${Math.random()}`): ToolCall => ({ id, name, input });
const names = (r?: CompletionRequest) => r?.tools.map((t) => t.name) ?? [];
const results = (r?: CompletionRequest) => {
  const m = r?.messages.at(-1);
  return m?.role === "tool" ? m.results.map((x) => x.output) : [];
};
const starts = async (log: string) => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;

/** A temp home whose `~/.hortus/mcp.json` is `mcp`, and a temp project (the cwd) whose `.mcp.json` is `project`. */
async function setup(t: TestContext, mcp: unknown, project?: unknown) {
  t.after(await tempHome({ plugins: { "mcp-adapter": dir } }));
  await writeFile(join(hortusDir(), "mcp.json"), JSON.stringify(mcp));
  const proj = await tempDir(t, "mcp-adapter-");
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  await mkdir(join(proj, ".git"));
  if (project) await writeFile(join(proj, ".mcp.json"), JSON.stringify(project));
  process.chdir(proj);
  return proj;
}

const agentWith = (provider: ReturnType<typeof scripted>, opts: LoadOptions = {}, extra: LoadOptions["extra"] = []) =>
  createAgent({
    host: { kind: "test", interactive: true },
    ...opts,
    extra: [...extra, { name: "scripted", plugin: { providers: { scripted: provider } } }],
  });

test("mcp-adapter: proxy, lazy servers and the cache, direct and search tools, approvals, guard, elicitation, sampling, prompts", async (t) => {
  const logs = await tempDir(t, "mcp-logs-");
  const alphaLog = join(logs, "alpha");
  await setup(
    t,
    {
      settings: { approveTools: ["delete_*"], outputGuard: { maxLines: 100 } },
      mcpServers: {
        alpha: { ...stdio(alphaLog), description: "Test tools", searchKeywords: { "echo-it": ["parrot"] } },
        beta: { ...stdio(), lifecycle: "eager", directTools: ["echo-it"] },
        gamma: { ...stdio(), directTools: "search", includeTools: ["echo-*"] },
      },
    },
    { mcpServers: { proj: stdio() } },
  );
  const asked: AskEvent[] = [];
  const answer = (p: AskEvent) => {
    asked.push(p);
    const q = p.question;
    if (p.kind === "trust") return "Trust";
    if (p.kind === "mcp-adapter:approval") return "Allow for session";
    if (p.options?.some((o) => o.label === "Submit")) return "Submit";
    if (q.endsWith("\n\nName")) return "Bob";
    if (q.endsWith("\n\nage (optional)")) return "42";
    if (q.includes("wants a completion")) return "Allow";
    return undefined;
  };
  const rec = record();
  const turns: Turn[] = [
    { toolCalls: [call("mcp", {}), call("mcp", { search: "parrot echo" })] },
    { toolCalls: [call("beta_echo_it", { msg: "hi" }), call("mcp", { tool: "alpha_delete_thing", args: { id: 1 } })] },
    {
      toolCalls: [
        call("mcp", { tool: "delete_thing", server: "alpha", args: { id: 1 } }),
        call("mcp", { tool: "alpha_big" }),
        call("mcp", { tool: "alpha_read_readme" }),
        call("mcp", { tool: "alpha_structured" }),
        call("mcp", { describe: "alpha-echo-it" }),
      ],
    },
    { toolCalls: [call("mcp", { tool: "alpha_ask_name" })] },
    { toolCalls: [call("mcp", { tool: "alpha_sample" })] },
    // the sampling request, through ctx.complete
    (req) => {
      assert.deepEqual(req.messages, [{ role: "user", content: "sample me" }]);
      return { text: "sampled!" };
    },
    { text: "done" },
    // the MCP prompt's run
    { text: "hi Bob" },
  ];
  const provider = scripted(turns);
  const agent = await agentWith(provider, {}, [
    {
      name: "ask",
      plugin: {
        on: {
          // a plugin's server; a config file wins a name
          mcp_servers: (p) => {
            p.servers.ext = stdio();
            p.servers.alpha = { command: "nonexistent" };
          },
          ask: (p) => {
            const a = answer(p);
            if (a) p.resolve(a);
          },
        },
      },
    },
    { name: "rec", plugin: rec },
  ]);
  t.after(() => agent.close());
  await agent.setSession(await openSession(null));

  const end = await agent.run("go");
  assert.equal(end?.error, undefined);
  // the project's server was asked about once
  assert.equal(asked.filter((a) => a.kind === "trust").length, 1);

  const [r1, r2, r3, r4, r5] = provider.requests;
  // one proxy tool and beta's chosen direct tool; nothing of lazy or search-mode servers yet; no codemode
  const mcpNames = (r?: CompletionRequest) => names(r).filter((n) => /^(mcp|alpha|beta|gamma|proj)(_|$)/.test(n));
  assert.deepEqual(mcpNames(r1), ["mcp", "beta_echo_it"]);
  assert.ok(!names(r1).includes("codemode"));
  assert.match(r1?.tools.find((x) => x.name === "mcp")?.description ?? "", /alpha \(\d+ tools\) — Test tools/);

  const [status, search] = results(r2);
  assert.match(status ?? "", /✓ beta \(connected, 7 tools, eager\)/);
  assert.match(status ?? "", /· alpha \(not running, 7 tools, lazy\)/);
  assert.match(status ?? "", /proj \(not running/);
  // a keyword finds alpha's echo-it first; search activated gamma's search-mode tool
  assert.match(search ?? "", /^\d+ tools match "parrot echo"[^:]*:\nalpha_echo_it\n {2}Echoes a message/);
  assert.match(search ?? "", /Now available directly: gamma_echo_it/);
  assert.ok(names(r2).includes("gamma_echo_it"));

  assert.deepEqual(results(r3), ["echo hi", "deleted 1"]);
  const approvals = asked.filter((a) => a.kind === "mcp-adapter:approval");
  // the second identical call reused the session grant
  assert.equal(approvals.length, 1);
  assert.match(
    approvals[0]?.question ?? "",
    /alpha wants to run delete_thing\n\nThe server marks this tool as destructive/,
  );

  const [deleted, big, readme, structured, described] = results(r4);
  assert.equal(deleted, "deleted 1");
  const spill = /Full output saved to (\S+)\]$/.exec(big ?? "")?.[1];
  assert.match(big ?? "", /^line 0\n[\s\S]*line 99\n\n\[Output truncated: 300 lines/);
  assert.equal((await readFile(spill ?? "", "utf8")).split("\n").length, 300);
  assert.equal(readme, "hello resource");
  assert.equal(structured, 'n is 7\n{\n  "n": 7\n}');
  assert.match(
    described ?? "",
    /^alpha_echo_it\nServer: alpha {2}Original name: echo-it[\s\S]*Hints: read-only[\s\S]*"msg"/,
  );

  assert.deepEqual(results(r5), ["Hello Bob (42)"]);
  assert.deepEqual(results(provider.requests[6]), ["model said: sampled!"]);
  // progress reached the TUI as tool_update details
  assert.ok(rec.events.some((e) => e.name === "tool_update" && JSON.stringify(e.payload).includes("half way")));

  // alpha started once at startup (to read its tools for the cache), then once for its first call
  assert.equal(await starts(alphaLog), 2);
  const cache = JSON.parse(await readFile(join(hortusDir(), "mcp-cache.json"), "utf8"));
  assert.deepEqual(
    cache.servers.alpha.prompts.map((p: { name: string }) => p.name),
    ["greet"],
  );

  // the session holds the grant and the activation
  const data = agent.session()?.getState().data["mcp-adapter"] as { approvals: string[]; activated: string[] };
  assert.equal(data.approvals.length, 1);
  assert.deepEqual(data.activated, ["gamma_echo_it"]);

  // commands
  const cmd = (name: string) => {
    const c = agent.commands().find((x) => x.name === name);
    assert.ok(c, name);
    return c;
  };
  assert.match((await cmd("mcp-adapter").run("")) ?? "", /^MCP: \d\/5 servers connected/);
  assert.match((await cmd("mcp-adapter").run("tools")) ?? "", /gamma:\n {2}gamma_echo_it \[search\]/);
  assert.match(
    (await cmd("mcp-adapter").run("prompts")) ?? "",
    /^\/mcp__ext__greet <name> — Greets someone\n\/mcp__alpha__greet <name>/,
  );
  // a command per prompt, as Pi registers them
  assert.equal(cmd("mcp__alpha__greet").args, "<name>");
  await assert.rejects(
    cmd("mcp__alpha__greet").run(""),
    /Missing required argument: name\.\nUsage: \/mcp__alpha__greet <name>/,
  );
  assert.equal(await cmd("mcp__alpha__greet").run("name=Bob"), "Sent MCP prompt alpha/greet");
  for (let i = 0; i < 200 && rec.events.filter((e) => e.name === "run_end").length < 2; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(provider.requests.at(-1)?.messages.at(-1), { role: "user", content: "Hello Bob" });

  // a new agent: alpha's tools come from the cache (it isn't started), the project's server isn't asked about again,
  // and resuming the session brings back the activated tool and the grant
  const leaf = agent.session()?.getState().messages.at(-1)?.entryId;
  await agent.close();
  const before = asked.length;
  const provider2 = scripted([
    { toolCalls: [call("mcp", { search: "delete" }), call("mcp", { tool: "alpha_delete_thing", args: { id: 1 } })] },
    { text: "ok" },
  ]);
  const again = await agentWith(provider2, {}, [
    { name: "ask", plugin: { on: { ask: (p) => void p.resolve(answer(p)) } } },
  ]);
  t.after(() => again.close());
  await again.setSession(await openSession(leaf ?? ""), "resume");
  await again.run("again");
  assert.equal(asked.length, before);
  assert.ok(names(provider2.requests[0]).includes("gamma_echo_it"));
  assert.match(results(provider2.requests[1])[0] ?? "", /^\d+ tools match "delete":\nalpha_delete_thing/);
  assert.equal(results(provider2.requests[1])[1], "deleted 1");
  // started for the call only
  assert.equal(await starts(alphaLog), 3);
});

test("mcp-adapter: headless approvals fail closed, project servers stay blocked, codemode tools, idle stop", async (t) => {
  const logs = await tempDir(t, "mcp-logs-");
  const log = join(logs, "alpha");
  await setup(
    t,
    {
      settings: { codemode: true, approveTools: "destructive", idleTimeout: 0.002 },
      mcpServers: { alpha: stdio(log) },
    },
    { mcpServers: { proj: stdio() } },
  );
  const rec = record();
  const provider = scripted([
    {
      toolCalls: [
        call("codemode", { code: "return await tools.mcp__alpha__echo_it({ msg: 'x' });" }),
        call("mcp", { tool: "alpha_delete_thing", args: { id: 2 } }),
      ],
    },
    { toolCalls: [call("mcp", { tool: "echo-it", server: "alpha", args: '{"msg":"y"}' })] },
    { text: "done" },
  ]);
  const agent = await agentWith(provider, { host: { kind: "test", interactive: false } }, [
    { name: "rec", plugin: rec },
  ]);
  t.after(() => agent.close());
  await agent.run("go");

  const [r1, r2, r3] = provider.requests;
  // MCP tools reach the model only through the proxy and codemode
  assert.ok(names(r1).includes("codemode"));
  assert.ok(!names(r1).some((n) => n.startsWith("mcp__") || n.startsWith("alpha_")));
  assert.match(r1?.tools.find((x) => x.name === "codemode")?.description ?? "", /mcp__alpha__echo_it/);
  const [script, gated] = results(r2);
  // a script gets the whole CallToolResult
  assert.deepEqual(JSON.parse(script ?? "").content, [{ type: "text", text: "echo x" }]);
  assert.equal(
    gated,
    'MCP tool "delete_thing" on server "alpha" is approval-gated and requires an interactive session.',
  );
  // a proxy call runs under the tool's own name (guards see it), its string args parsed, its name matched loosely
  assert.deepEqual(results(r3), ["echo y"]);
  const nested = rec.events.find(
    (e) =>
      e.name === "tool_call" &&
      (e.payload as { call: ToolCall }).call.name === "mcp__alpha__echo_it" &&
      JSON.stringify(e.payload).includes('"y"'),
  );
  assert.ok((nested?.payload as { call: { parentId?: string } } | undefined)?.call.parentId);

  // nobody could answer: the project's server is blocked, not asked about
  const status = async () =>
    (await agent
      .commands()
      .find((c) => c.name === "mcp-adapter")
      ?.run("")) ?? "";
  assert.match(await status(), /⊘ proj \(blocked/);
  // idle: stopped soon after its last call
  for (let i = 0; i < 300 && /✓ alpha/.test(await status()); i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(await status(), /· alpha \(not running/);
});

test("mcp-adapter: installs a streamable HTTP server from its URL; disable and enable write the project override", async (t) => {
  const proj = await setup(t, { mcpServers: {} });
  const http = createServer(async (req, res) => {
    const s = new McpServer({ name: "h", version: "1.0.0" });
    s.registerTool("ping", { description: "Ping" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    await s.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  t.after(() => {
    http.closeAllConnections();
    return new Promise((r) => http.close(r));
  });
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  const provider = scripted([
    { toolCalls: [call("mcp", { action: "install", url, server: "local" })] },
    { toolCalls: [call("mcp", { tool: "local_ping" })] },
    { text: "done" },
  ]);
  const agent = await agentWith(provider);
  t.after(() => agent.close());
  await agent.run("go");
  assert.match(
    results(provider.requests[1])[0] ?? "",
    /^Installed local \(http:[^)]+\) in [^\n]+mcp-adapter\.json\.\n\nlocal \(connected, 1 tools\)\n- local_ping\(\) - Ping/,
  );
  assert.deepEqual(results(provider.requests[2]), ["pong"]);
  const saved = JSON.parse(await readFile(join(hortusDir(), "mcp-adapter.json"), "utf8"));
  assert.deepEqual(saved.mcpServers.local, { url });

  const cmd = agent.commands().find((c) => c.name === "mcp-adapter");
  assert.match((await cmd?.run("disable local")) ?? "", /Disabled local/);
  const override = JSON.parse(await readFile(join(proj, ".hortus", "mcp-adapter.json"), "utf8"));
  assert.deepEqual(override.mcpServers.local, { disabled: true });
  assert.match((await cmd?.run("")) ?? "", /○ local \(disabled/);
  assert.ok(!agent.ctx.tools.some((x) => x.name === "local_ping"));
  await cmd?.run("enable local");
  assert.match((await cmd?.run("reconnect local")) ?? "", /Reconnected local/);
  assert.match((await cmd?.run("")) ?? "", /✓ local \(connected/);
});

test("mcp-adapter: the TUI draws an mcp call as one line plus its first result line", async () => {
  const { default: plugin } = await import("./index.tsx");
  const block = composeTools([plugin], undefined, (e) => assert.fail(e))("mcp");
  const view = { call: call("mcp", { search: "screenshot" }), width: 60 };
  assert.equal(block.text({ ...view, details: { mcpProgress: "half way" } }), 'mcp search "screenshot"\nhalf way');
  const result = { id: "x", output: "2 tools match\na\nb" };
  assert.equal(block.text({ ...view, result }), 'mcp search "screenshot"\n2 tools match\n… 2 more lines (Ctrl+O)');
  assert.equal(block.text({ ...view, result, expanded: true }), 'mcp search "screenshot"\n2 tools match\na\nb');
});
