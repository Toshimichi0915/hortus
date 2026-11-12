import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgent } from "./agent.ts";
import { tsType } from "./codemode.ts";
import { type Events, type Message, type Plugin, tool, toolSchema } from "./llm.ts";
import { connectMcp, McpConfigSchema, type McpServer, mcpResult } from "./mcp.ts";
import { record, scripted, type Turn, tempHome, toolCtx, untimed, until } from "./testing.ts";
import { z } from "zod";

const ctx = toolCtx();

test("tsType", () => {
  assert.equal(
    tsType({
      type: "object",
      properties: { a: { type: "integer", description: "A" }, b: { type: "array", items: { enum: ["x", "y"] } } },
      required: ["a"],
    }),
    '{\n  /** A */\n  a: number;\n  b?: ("x" | "y")[];\n}',
  );
});

test("mcp.json keeps fields it doesn't know, for plugins (a server's lifecycle, top-level settings)", () => {
  const raw = {
    settings: { idle: 5 },
    mcpServers: { a: { command: "x", lifecycle: "lazy" }, b: { url: "http://h/", auth: "oauth" } },
  };
  assert.deepEqual(McpConfigSchema.parse(raw), raw);
});

test("mcpResult", () => {
  assert.equal(
    mcpResult({
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    }),
    "a\nb",
  );
  assert.deepEqual(mcpResult({ content: [], structuredContent: { n: 1 } }), { n: 1 });
  assert.deepEqual(
    mcpResult({
      content: [
        { type: "text", text: "t" },
        { type: "image", data: "AA==", mimeType: "image/png" },
      ],
    }),
    {
      type: "image",
      mediaType: "image/png",
      data: "AA==",
      text: "t",
    },
  );
  // every image, the text on the first
  assert.deepEqual(
    mcpResult({
      content: [
        { type: "image", data: "AA==", mimeType: "image/png" },
        { type: "image", data: "BB==", mimeType: "image/jpeg" },
      ],
    }),
    [
      { type: "image", mediaType: "image/png", data: "AA==", text: "" },
      { type: "image", mediaType: "image/jpeg", data: "BB==" },
    ],
  );
  assert.throws(() => mcpResult({ content: [{ type: "text", text: "bad" }], isError: true }), /bad/);
});

const server = `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
const s = new McpServer({ name: "t", version: "1.0.0" });
s.registerTool("echo-it", { description: "Echoes", inputSchema: { msg: z.string() }, annotations: { readOnlyHint: true } },
  async ({ msg }) => ({ content: [{ type: "text", text: "echo " + msg }] }));
await s.connect(new StdioServerTransport());
`;

test("connectMcp lists and calls a stdio server's tools, and reports one that fails", async () => {
  // cwd is this package, so the server script resolves the SDK
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const mcp = await connectMcp({
    mcpServers: {
      test: { command: process.execPath, args: ["--input-type=module", "-e", server], cwd },
      broken: { command: process.execPath, args: ["-e", "console.error('no luck'); process.exit(1)"] },
      off: { command: "nonexistent", enabled: false },
    },
  });
  try {
    assert.deepEqual(
      mcp.tools.map((t) => t.name),
      ["mcp__test__echo_it"],
    );
    const echo = mcp.tools[0];
    assert.ok(echo);
    assert.equal(await echo.execute({ msg: "hi" } as never, ctx), "echo hi");
    // declared with the server's own schema (as is), its MCP facts in `meta`
    assert.deepEqual(toolSchema(echo), echo.jsonSchema);
    assert.deepEqual((echo.jsonSchema as { properties?: unknown }).properties, { msg: { type: "string" } });
    assert.deepEqual(echo.meta, { mcp: { server: "test", tool: "echo-it", annotations: { readOnlyHint: true } } });
    assert.equal(mcp.errors.length, 1);
    assert.match(mcp.errors[0] ?? "", /^MCP server broken: [\s\S]*no luck/);
  } finally {
    await mcp.close();
  }
});

// mimics chrome-devtools-mcp: a path outside every advertised root is refused
const sandboxed = `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import { fileURLToPath } from "node:url";
import { ListRootsResultSchema } from "@modelcontextprotocol/sdk/types.js";
const s = new McpServer({ name: "t", version: "1.0.0" });
s.registerTool("write", { description: "Writes", inputSchema: { path: z.string() } }, async ({ path }) => {
  if (!s.server.getClientCapabilities()?.roots)
    return { content: [{ type: "text", text: "no roots capability" }], isError: true };
  const { roots } = await s.server.request({ method: "roots/list" }, ListRootsResultSchema);
  const here = process.cwd().split("/").filter(Boolean).join("/");
  const ok = roots.some((r) => fileURLToPath(r.uri).split("/").filter(Boolean).join("/") === here);
  return ok
    ? { content: [{ type: "text", text: "wrote " + path }] }
    : { content: [{ type: "text", text: "denied " + path }], isError: true };
});
await s.connect(new StdioServerTransport());
`;

test("connectMcp advertises roots so file tools can write outside the temp dir", async () => {
  // this package, so the server script resolves the SDK and the root is outside the temp dir
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const mcp = await connectMcp(
    { mcpServers: { box: { command: process.execPath, args: ["--input-type=module", "-e", sandboxed], cwd } } },
    [cwd],
  );
  try {
    const write = mcp.tools.find((t) => t.name === "mcp__box__write");
    assert.ok(write);
    assert.equal(await write.execute({ path: `${cwd}/shot.png` } as never, ctx), `wrote ${cwd}/shot.png`);
  } finally {
    await mcp.close();
  }
});

test("connectMcp without roots still works for servers that don't need them", async () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const mcp = await connectMcp(
    { mcpServers: { box: { command: process.execPath, args: ["--input-type=module", "-e", sandboxed], cwd } } },
    [],
  );
  try {
    const write = mcp.tools.find((t) => t.name === "mcp__box__write");
    assert.ok(write);
    await assert.rejects(write.execute({ path: "/tmp/x" } as never, ctx), /no roots capability/);
  } finally {
    await mcp.close();
  }
});

// cwd is this package, so the server scripts resolve the SDK
const pkg = fileURLToPath(new URL("..", import.meta.url));
const echoServer: McpServer = { command: process.execPath, args: ["--input-type=module", "-e", server], cwd: pkg };
const lastResults = (messages?: Message[]) => {
  const m = messages?.at(-1);
  return m?.role === "tool" ? m.results : [];
};

/** An agent on `turns` with `plugins`, then a recorder; its `run_start` tools are recorded by name. */
async function agentWith(turns: Turn[], plugins: Plugin[] = [], disabled: string[] = []) {
  const provider = scripted(turns);
  const rec = record();
  const tools: string[][] = [];
  const agent = await createAgent({
    disabled,
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider } } },
      ...plugins.map((plugin, i) => ({ name: `p${i}`, plugin })),
      { name: "rec", plugin: rec },
      { name: "tools", plugin: { on: { run_start: (p) => void tools.push(p.tools.map((t) => t.name)) } } },
    ],
  });
  return { agent, provider, rec, tools };
}

test("builtin:mcp: a server's tools are codemode-only; with builtin:codemode disabled they are declared", async (t) => {
  t.after(await tempHome({ mcp: { mcpServers: { test: echoServer } } }));
  const code = { code: "return await tools.mcp__test__echo_it({ msg: 'x' });" };
  const a = await agentWith([{ toolCalls: [{ id: "1", name: "codemode", input: code }] }, {}]);
  t.after(() => a.agent.close());
  await a.agent.run("go");
  const [first, second] = a.provider.requests;
  assert.ok(first?.tools.some((t) => t.name === "codemode"));
  assert.ok(!first?.tools.some((t) => t.name === "mcp__test__echo_it"));
  assert.deepEqual(lastResults(second?.messages), [{ id: "1", output: "echo x" }]);
  const start = a.rec.events.find((e) => e.name === "run_start")?.payload as Events["run_start"] | undefined;
  const echo = start?.tools.find((t) => t.name === "mcp__test__echo_it");
  assert.deepEqual([echo?.exposure, echo?.plugin], ["codemode", "builtin:mcp"]);

  const b = await agentWith(
    [{ toolCalls: [{ id: "1", name: "mcp__test__echo_it", input: { msg: "y" } }] }, {}],
    [],
    ["builtin:codemode"],
  );
  t.after(() => b.agent.close());
  await b.agent.run("go");
  assert.ok(b.provider.requests[0]?.tools.some((t) => t.name === "mcp__test__echo_it"));
  assert.ok(!b.provider.requests[0]?.tools.some((t) => t.name === "codemode"));
  assert.deepEqual(lastResults(b.provider.requests[1]?.messages), [{ id: "1", output: "echo y" }]);
  const bStart = b.rec.events.find((e) => e.name === "run_start")?.payload as Events["run_start"] | undefined;
  assert.equal(bStart?.tools.find((t) => t.name === "mcp__test__echo_it")?.exposure, "direct");
});

test("builtin:mcp: any codemode host (codemodeHost, whatever its name) keeps MCP tools codemode-only", async (t) => {
  t.after(await tempHome({ mcp: { mcpServers: { test: echoServer } } }));
  const exec = tool({
    name: "exec",
    description: "Runs scripts",
    codemodeHost: true,
    inputSchema: z.object({}),
    execute: async () => "",
  });
  const a = await agentWith([{}], [{ tools: [exec] }], ["builtin:codemode"]);
  t.after(() => a.agent.close());
  await a.agent.run("go");
  assert.deepEqual(
    a.provider.requests[0]?.tools.map((x) => x.name).filter((n) => n === "exec" || n.startsWith("mcp__")),
    ["exec"],
  );
  assert.equal(a.agent.ctx.tools.find((x) => x.name === "mcp__test__echo_it")?.exposure, "codemode");
});

test("builtin:mcp: a run whose run_start removed codemode gets MCP tools direct, as copies", async (t) => {
  t.after(await tempHome({ mcp: { mcpServers: { test: echoServer } } }));
  const drop: Plugin = {
    on: {
      run_start: (p) => {
        p.tools.splice(
          p.tools.findIndex((x) => x.name === "codemode"),
          1,
        );
      },
    },
  };
  // plugins run after builtin:mcp, so call its handler on a run_start a remover already edited
  const a = await agentWith([{}]);
  t.after(() => a.agent.close());
  await a.agent.run("warm");
  const start = { tools: [...a.agent.ctx.tools] } as Events["run_start"];
  await drop.on?.run_start?.(start, a.agent.ctxOf("builtin:mcp"));
  const mcp = a.agent.plugins.find((x) => x.name === "builtin:mcp")?.plugin;
  await mcp?.on?.run_start?.(start, a.agent.ctxOf("builtin:mcp"));
  const echo = start.tools.find((x) => x.name === "mcp__test__echo_it");
  assert.equal(echo?.exposure, "direct");
  assert.equal(a.agent.ctx.tools.find((x) => x.name === "mcp__test__echo_it")?.exposure, "codemode");
});

test("mcp_servers: a plugin's server connects, mcp.json wins a name; a failing server is one notify error", async (t) => {
  const broken: McpServer = { command: process.execPath, args: ["-e", "console.error('no luck'); process.exit(1)"] };
  t.after(await tempHome({ mcp: { mcpServers: { test: echoServer, broken } } }));
  const plugin: Plugin = {
    on: {
      mcp_servers: ({ servers }) => {
        servers.test = { command: "nonexistent" };
        servers.extra = echoServer;
      },
    },
  };
  const { agent, rec, tools } = await agentWith([{}], [plugin]);
  t.after(() => agent.close());
  await agent.run("go");
  assert.deepEqual(tools[0]?.filter((n) => n.startsWith("mcp__")).sort(), [
    "mcp__extra__echo_it",
    "mcp__test__echo_it",
  ]);
  const notes = rec.events.filter((e) => e.name === "notify").map((e) => e.payload as Events["notify"]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.level, "error");
  assert.match(notes[0]?.text ?? "", /^MCP server broken: [\s\S]*no luck/);
});

test("close stops the MCP server processes", async (t) => {
  const pidFile = join(tmpdir(), `hortus-mcp-${process.pid}-${Date.now()}`);
  const withPid = `import { writeFileSync } from "node:fs"; writeFileSync(process.env.PIDFILE, String(process.pid));\n${server}`;
  t.after(
    await tempHome({
      mcp: {
        mcpServers: {
          test: {
            command: process.execPath,
            args: ["--input-type=module", "-e", withPid],
            cwd: pkg,
            env: { PIDFILE: pidFile },
          },
        },
      },
    }),
  );
  const { agent } = await agentWith([{}]);
  await agent.run("go");
  const pid = Number(await readFile(pidFile, "utf8"));
  await rm(pidFile);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive());
  await agent.close();
  await until(() => !alive());
});

test("builtin:mcp: the host ctx has the MCP tools once connected (outside runs too), after every plugin's init", async (t) => {
  t.after(await tempHome());
  let initDone = false;
  const plugin: Plugin = {
    on: {
      init: async () => {
        await new Promise((r) => setTimeout(r, 20));
        initDone = true;
      },
      // state set by an async init is there when servers are asked for
      mcp_servers: ({ servers }) => {
        if (initDone) servers.late = echoServer;
      },
    },
  };
  const { agent } = await agentWith([], [plugin]);
  t.after(() => agent.close());
  await until(() => agent.ctx.tools.some((t) => t.name === "mcp__late__echo_it"), 10_000);
  const r = await agent.ctx.runTool({ id: "1", name: "mcp__late__echo_it", input: { msg: "host" } });
  assert.deepEqual(untimed(r), { id: "1", output: "echo host" });
});

test("connectMcp: a server that doesn't answer in time fails like one that errors", async (t) => {
  const { createServer } = await import("node:http");
  // accepts the request and never answers
  const hung = createServer(() => {});
  await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r));
  t.after(() => {
    hung.closeAllConnections();
    hung.close();
  });
  const { port } = hung.address() as { port: number };
  const started = Date.now();
  const mcp = await connectMcp(
    { mcpServers: { slow: { url: `http://127.0.0.1:${port}/mcp` }, test: echoServer } },
    [],
    300,
  );
  t.after(() => mcp.close());
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(mcp.errors, ["MCP server slow: timed out after 0.3s"]);
  assert.deepEqual(
    mcp.tools.map((t) => t.name),
    ["mcp__test__echo_it"],
  );
});
