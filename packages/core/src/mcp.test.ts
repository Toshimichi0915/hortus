import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import { runTool } from "./agent.ts";
import { codemodeTool, runScript, tsType } from "./codemode.ts";
import { tool } from "./llm.ts";
import { connectMcp, mcpResult } from "./mcp.ts";

const add = tool({
  name: "add",
  description: "Adds",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }) => a + b,
});
const fail = tool({
  name: "fail",
  description: "Fails",
  inputSchema: z.object({}),
  execute: async () => {
    throw new Error("boom");
  },
});

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

test("runScript calls tools, collects output and reports failures", async () => {
  const tools = [add, fail];
  assert.equal(
    await runScript(
      tools,
      "const [x, y] = await Promise.all([tools.add({a: 1, b: 2}), tools.add({a: 3, b: 4})]);\nconsole.log('hi', {x});\nreturn x + y;",
      5,
    ),
    '10\n<console_output>\nhi {\n  "x": 3\n}\n</console_output>',
  );
  assert.equal(await runScript(tools, "", 5), "(no output)");
  await assert.rejects(runScript(tools, "text('before'); await tools.fail({});", 5), /before\nScript error: boom/);
  await assert.rejects(runScript(tools, "await tools.add({a: 'x'});", 5), /Invalid input for add/);
  await assert.rejects(runScript(tools, "await new Promise(() => {});", 0.05), /timed out/);
  const img = { type: "image", mediaType: "image/png", data: "AA==", text: "shot" } as const;
  const shot = tool({ name: "shot", description: "", inputSchema: z.object({}), execute: async () => img });
  const r = await runScript([shot], "image(await tools.shot());", 5);
  assert.ok(typeof r !== "string" && r.path);
  assert.deepEqual(r, { ...img, path: r.path, text: `shot\n[Image saved to ${r.path}]` });
  assert.equal(readFileSync(r.path, "base64"), "AA==");
  assert.match(codemodeTool(tools).description, /add\(input: \{\n {4}a: number;/);
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
  assert.throws(() => mcpResult({ content: [{ type: "text", text: "bad" }], isError: true }), /bad/);
});

const server = `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
const s = new McpServer({ name: "t", version: "1.0.0" });
s.registerTool("echo-it", { description: "Echoes", inputSchema: { msg: z.string() } },
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
    assert.equal(await echo.execute({ msg: "hi" } as never), "echo hi");
    assert.equal(mcp.errors.length, 1);
    assert.match(mcp.errors[0] ?? "", /^MCP server broken: [\s\S]*no luck/);
    // reachable from codemode under the same name
    assert.equal(await runScript(mcp.tools, "return tools.mcp__test__echo_it({ msg: 'x' })", 5), "echo x");
  } finally {
    await mcp.close();
  }
});

test("a direct call to a codemode-only tool says how to reach it", async () => {
  const echo = tool({ name: "mcp__s__echo-it", description: "", inputSchema: z.object({}), execute: async () => "" });
  const r = await runTool([], { id: "1", name: "mcp__s__echo-it", input: {} }, [echo]);
  assert.equal(r.isError, true);
  assert.match(r.output, /only reachable from codemode: call `await tools\.mcp__s__echo_it\(input\)`/);
  assert.equal((await runTool([], { id: "2", name: "nope", input: {} }, [echo])).output, "Unknown tool: nope");
});

// mimics chrome-devtools-mcp: a path outside every advertised root is refused
const sandboxed = `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { ListRootsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
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
    assert.equal(await write.execute({ path: `${cwd}/shot.png` } as never), `wrote ${cwd}/shot.png`);
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
    await assert.rejects(write.execute({ path: "/tmp/x" } as never), /no roots capability/);
  } finally {
    await mcp.close();
  }
});
