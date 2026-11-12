import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type CompletionRequest, createAgent, type Message, openSession, type ToolResult } from "@hortus/core";
import { scripted, tempDir, tempHome } from "@hortus/core/testing";
import { blockReason } from "./index.ts";

const dir = fileURLToPath(new URL("..", import.meta.url));
const last = (req: CompletionRequest | undefined) => {
  const m = req?.messages.at(-1);
  return m?.role === "user" ? m.content : "";
};
const results = (req: CompletionRequest | undefined): ToolResult[] =>
  ((req?.messages ?? []).filter((m) => m.role === "tool") as Extract<Message, { role: "tool" }>[]).at(-1)?.results ??
  [];

test("context-mode: large output stays out of context, is searchable, and the session survives a compaction", async (t) => {
  t.after(await tempHome({ plugins: { "context-mode": dir } }));
  const cwd = await tempDir(t);
  await writeFile(join(cwd, "AGENTS.md"), "Use tabs.\n");
  // 400 log lines, one of them the error we're after
  const log = Array.from({ length: 400 }, (_, i) =>
    i === 321 ? "ERROR worker 7: connection timeout to db-primary" : `INFO request ${i} served in ${i % 17}ms`,
  ).join("\\n");
  const provider = scripted([
    {
      toolCalls: [
        { id: "1", name: "bash", input: { command: "curl https://example.com/api" } },
        {
          id: "2",
          name: "ctx_execute",
          input: { language: "javascript", code: `console.log("${log}")`, intent: "connection timeout" },
        },
        { id: "3", name: "read", input: { path: "AGENTS.md" } },
      ],
    },
    { toolCalls: [{ id: "4", name: "ctx_search", input: { queries: ["timeout db-primary"] } }] },
    { text: "worker 7 timed out" },
    // /compact's summary
    { text: "SUMMARY" },
    { text: "continuing" },
    { text: "still here" },
  ]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  t.after(() => agent.close());
  const session = await openSession(null);
  await session.setCwd(cwd);
  await agent.setSession(session);
  const command = (name: string) =>
    agent
      .commands()
      .find((c) => c.name === name)
      ?.run("");

  await agent.run("goal: find why the workers fail");
  const [first, second, third] = provider.requests;
  // the routing anchor rides on ctx_execute's prompt; active memory is appended to the run's first request only
  assert.match(first?.system ?? "", /context-mode active\. Hierarchy: ctx_batch_execute/);
  assert.match(last(first), /^<active_memory>[\s\S]*category="goal">find why the workers fail<\/event>/);
  assert.doesNotMatch(JSON.stringify(second?.messages), /active_memory/);
  const [curl, exec] = results(second);
  assert.equal(curl?.isError, true);
  assert.match(curl?.output ?? "", /^Blocked by context-mode: .*curl\/wget/);
  // ~10 KB of output, but only the matching section's title and first line come back
  assert.match(exec?.output ?? "", /Indexed \d+ sections from "execute:javascript"/);
  assert.match(exec?.output ?? "", /sections matched "connection timeout"/);
  assert.ok((exec?.output.length ?? 0) < 4000, `returned ${exec?.output.length} chars`);
  assert.doesNotMatch(exec?.output ?? "", /request 200 served/);
  assert.match(results(third)[0]?.output ?? "", /ERROR worker 7: connection timeout to db-primary/);

  assert.equal(await command("compact"), undefined);
  await agent.run("go on");
  const resumed = provider.requests[4];
  // the snapshot built at `compact` comes after the compaction, with the goal, files and how to search them
  assert.match(last(resumed), /<session_resume events="\d+" compact_count="1"/);
  assert.match(last(resumed), /<session_goal>[\s\S]*find why the workers fail/);
  assert.match(last(resumed), /<files count="1">\n {4}AGENTS\.md \(read×1\)/);
  assert.match(last(resumed), /<rules count="1">/);
  assert.match(last(resumed), /source: "session-events"/);
  // once only, and never saved to the session
  await agent.run("and?");
  assert.doesNotMatch(last(provider.requests[5]), /session_resume/);
  assert.doesNotMatch(JSON.stringify(session.getState().messages), /session_resume|active_memory/);

  // events and the compaction count replay from the session file
  const reopened = await openSession(session.leafId);
  await agent.setSession(reopened);
  const stats = (await command("ctx-stats")) ?? "";
  assert.match(stats, /- Compactions: 1/);
  assert.match(stats, /- file: 1/);
  assert.match(stats, /- goal: 1/);
  assert.match(stats, /- Knowledge base: 1 sources/);
});

test("context-mode: fetch_and_index, execute_file and batch_execute index what they gather", async (t) => {
  t.after(await tempHome({ plugins: { "context-mode": dir } }));
  const cwd = await tempDir(t);
  await writeFile(join(cwd, "data.csv"), "id,name\n1,a\n2,b\n3,c\n");
  const page = `<html><head><title>x</title><script>var a</script></head><body>
    <h1>Hooks</h1><p>Intro</p><h2>useEffect</h2><p>Cleanup runs before the next effect &amp; on unmount.</p>
    <h2>useMemo</h2><p>Caches a value.</p></body></html>`;
  const fetched: string[] = [];
  const fetch = (async (url: string) => {
    fetched.push(url);
    return new Response(page, { headers: { "content-type": "text/html" } });
  }) as typeof globalThis.fetch;
  const provider = scripted([
    {
      toolCalls: [
        { id: "1", name: "ctx_fetch_and_index", input: { url: "https://react.dev/hooks", source: "react" } },
        {
          id: "2",
          name: "ctx_execute_file",
          input: { path: "data.csv", language: "python", code: "print(len(FILE_CONTENT.splitlines()) - 1, 'rows')" },
        },
        {
          id: "3",
          name: "ctx_execute_file",
          input: { path: "../outside.txt", language: "shell", code: "echo $FILE_CONTENT" },
        },
        {
          id: "4",
          name: "ctx_batch_execute",
          input: {
            commands: [
              { label: "greeting", command: "echo hello from the batch" },
              { label: "files", command: "ls" },
            ],
            queries: ["data.csv"],
            concurrency: 2,
          },
        },
      ],
    },
    { toolCalls: [{ id: "5", name: "ctx_search", input: { queries: ["cleanup unmount"], source: "react" } }] },
    { text: "done" },
  ]);
  const agent = await createAgent({
    fetch,
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }],
  });
  t.after(() => agent.close());
  const session = await openSession(null);
  await session.setCwd(cwd);
  await agent.setSession(session);
  await agent.run("research");
  const [page_, csv, outside, batch] = results(provider.requests[1]);
  assert.deepEqual(fetched, ["https://react.dev/hooks"]);
  assert.match(page_?.output ?? "", /^Fetched and indexed \*\*3 sections\*\*.* from: react/);
  assert.match(csv?.output ?? "", /^path=data\.csv\n```python\n[\s\S]*```\n\n3 rows\n$/);
  assert.equal(outside?.isError, true);
  assert.match(outside?.output ?? "", /outside the project/);
  assert.match(batch?.output ?? "", /^Executed 2 commands .* Searched 1 queries\./);
  assert.match(batch?.output ?? "", /## Indexed Sections\n\n- greeting/);
  assert.match(batch?.output ?? "", /## data\.csv\n\n### files\n# files\n\n\$ ls\n\ndata\.csv/);
  const search = results(provider.requests[2])[0]?.output ?? "";
  assert.match(
    search,
    /\[current-session \| react\] ---\n### Hooks > useEffect\n\n## useEffect\n\nCleanup runs before the next effect & on unmount\./,
  );
});

test("context-mode: blocks HTTP clients in bash unless the body goes to a file", () => {
  assert.match(blockReason("curl https://x.dev") ?? "", /curl\/wget/);
  assert.match(blockReason("python -c 'x'; node -e x && fetch(url)") ?? "", /fetch\/requests/);
  assert.equal(blockReason("curl -s -o /tmp/x.json https://x.dev"), undefined);
  assert.match(blockReason("curl -s -o - https://x.dev") ?? "", /curl/);
  assert.equal(blockReason('gh issue list --search "curl wget"'), undefined);
  assert.equal(blockReason("ls -la"), undefined);
});
