import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgent, type Notify } from "@hortus/core";
import { scripted, tempHome } from "@hortus/core/testing";

/** A stand-in for mcp.postman.com: streamable HTTP answering with plain JSON, one tool. Records each POST's headers. */
async function fakePostman() {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    seen.push(req.headers);
    let body = "";
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (msg.id === undefined) return void res.writeHead(202).end();
    const results: Record<string, unknown> = {
      initialize: {
        protocolVersion: msg.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "postman", version: "0" },
      },
      "tools/list": {
        tools: [
          { name: "getAuthenticatedUser", description: "Who am I", inputSchema: { type: "object", properties: {} } },
        ],
      },
      "tools/call": { content: [{ type: "text", text: "user: ada" }] },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: results[msg.method] ?? {} }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const pluginDir = fileURLToPath(new URL("..", import.meta.url));

test("postman: skills, the mandate in the prompt, and its MCP server reached through codemode with the API key", async (t) => {
  const postman = await fakePostman();
  t.after(postman.close);
  t.after(
    await tempHome({
      plugins: { postman: pluginDir },
      secrets: {
        scripted: { type: "scripted", apiKey: "scripted" },
        postman: { type: "postman", apiKey: "PMAK-test", endpoint: postman.url },
      },
    }),
  );
  const provider = scripted([
    {
      toolCalls: [
        { id: "1", name: "codemode", input: { code: "return await tools.mcp__postman__getAuthenticatedUser({})" } },
      ],
    },
    { text: "done" },
  ]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  t.after(() => agent.close());
  await agent.run("who am I in Postman?");

  const system = provider.requests[0]?.system ?? "";
  assert.match(system, /<name>api-engineer<\/name>/);
  assert.match(system, /<name>postman-mcp-server<\/name>/);
  assert.match(system, /<postman>\n[\s\S]*load the `api-engineer` skill[\s\S]*<\/postman>/);
  assert.doesNotMatch(system, /`postman:/);
  assert.match(JSON.stringify(provider.requests[1]?.messages.at(-1)), /user: ada/);
  assert.equal(postman.seen[0]?.authorization, "Bearer PMAK-test");
  assert.equal(postman.seen[0]?.["x-source"], "postman-pi-plugin");
});

test("postman: mcp.json's own postman server wins; no mandate once api-engineer is removed", async (t) => {
  const postman = await fakePostman();
  t.after(postman.close);
  t.after(
    await tempHome({
      plugins: { postman: pluginDir },
      secrets: {
        scripted: { type: "scripted", apiKey: "scripted" },
        postman: { type: "postman", apiKey: "PMAK-test", endpoint: "http://127.0.0.1:1/unused" },
      },
      mcp: { mcpServers: { postman: { url: postman.url, headers: { Authorization: "Bearer mine" } } } },
    }),
  );
  const provider = scripted([{ text: "done" }]);
  const dropEntry = {
    on: {
      skills: ({ skills }: { skills: { name: string }[] }) =>
        void skills.splice(0, Infinity, ...skills.filter((s) => s.name !== "api-engineer")),
    },
  };
  const agent = await createAgent({
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider } } },
      { name: "drop", plugin: dropEntry },
    ],
  });
  t.after(() => agent.close());
  await agent.run("hi");
  const system = provider.requests[0]?.system ?? "";
  assert.doesNotMatch(system, /<postman>/);
  assert.match(system, /<name>api-testing<\/name>/);
  assert.equal(postman.seen[0]?.authorization, "Bearer mine");
});

test("postman: without a postman secret, a warning and no server", async (t) => {
  t.after(await tempHome({ plugins: { postman: pluginDir } }));
  const notes: Notify[] = [];
  const provider = scripted([{ text: "done" }]);
  const agent = await createAgent({
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider }, on: { notify: (n) => void notes.push(n) } } },
    ],
  });
  t.after(() => agent.close());
  await agent.run("hi");
  assert.ok(
    notes.some((n) => n.level === "warn" && /API key/.test(n.text)),
    JSON.stringify(notes),
  );
  assert.ok(!agent.ctx.tools.some((t) => t.name.startsWith("mcp__postman__")));
});
