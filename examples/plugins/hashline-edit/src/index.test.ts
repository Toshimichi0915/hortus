import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type CliPlugin, version } from "@hortus/cli";
import { composeTools } from "@hortus/cli/testing";
import { type CompletionRequest, createAgent, type Message, openSession, type ToolResult } from "@hortus/core";
import { scripted, tempHome } from "@hortus/core/testing";
import { autoReadBudget, registry } from "./index.tsx";

const dir = fileURLToPath(new URL("..", import.meta.url));

/** content -> anchor, from every `anchor│content` (or diff ` anchor│`/`+anchor│`) row of `text` */
const anchors = (text: string) =>
  new Map([...text.matchAll(/^[ +]?([a-z]{5})│(.*)$/gm)].map((m) => [m[2] as string, m[1] as string]));
const results = (req: CompletionRequest) => (req.messages.at(-1) as Extract<Message, { role: "tool" }>).results;
const out = (req: CompletionRequest, i = 0) => results(req)[i]?.output ?? "";

test("read serves anchors, replace/insert edit by them (stale and unshown ranges refused), write is guarded and re-read", async (t) => {
  t.after(await tempHome({ plugins: { "hashline-edit": dir } }));
  const file = join(homedir(), "a.txt");
  await writeFile(file, "one\ntwo\nthree\n");
  let first = new Map<string, string>();
  const provider = scripted([
    { toolCalls: [{ id: "r1", name: "read", input: { path: file } }] },
    (req) => {
      first = anchors(out(req));
      // two edits from one read: the insert's anchor is untouched by the replace, so it still resolves
      return {
        toolCalls: [
          {
            id: "e1",
            name: "replace",
            input: { remove_from: first.get("two"), remove_to: first.get("two"), text: "TWO\nextra" },
          },
          { id: "e2", name: "insert", input: { anchor: first.get("three"), direction: "after", text: "four\n" } },
        ],
      };
    },
    // the replaced line's anchor is dead now
    () => ({
      toolCalls: [
        { id: "e3", name: "replace", input: { remove_from: first.get("two"), remove_to: first.get("two"), text: "x" } },
      ],
    }),
    (req) => {
      assert.match(out(req), /^\[E_STALE_ANCHOR\] "[a-z]{5}" is stale/);
      return { toolCalls: [{ id: "w1", name: "write", input: { path: file, content: `${first.get("one")}│one\n` } }] };
    },
    (req) => {
      assert.match(out(req), /^\[E_WRITE_HASH_ECHO\] Refused write/);
      return { toolCalls: [{ id: "w2", name: "write", input: { path: file, content: "a\nb\nc\n" } }] };
    },
    (req) => {
      // auto-read after write: fresh anchors, all served
      const rows = anchors(out(req));
      assert.match(out(req), /^Successfully wrote to .*\n\n--- Auto-read \(hashline anchors\) ---\n[a-z]{5}│a\n/);
      return {
        toolCalls: [
          { id: "e4", name: "replace", input: { remove_from: rows.get("a"), remove_to: rows.get("c"), text: "" } },
        ],
      };
    },
    { text: "done" },
  ]);
  const cwd = process.cwd();
  process.chdir(homedir());
  t.after(() => process.chdir(cwd));
  const agent = await createAgent({
    provided: { "@hortus/cli": version },
    extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }],
  });
  const session = await openSession(null);
  await agent.setSession(session);
  const end = await agent.run("edit a.txt");
  assert.equal(end?.error, undefined);

  const [req] = provider.requests;
  const names = req?.tools.map((x) => x.name) ?? [];
  assert.ok(names.includes("replace") && names.includes("insert") && names.includes("read"));
  assert.ok(!names.includes("edit"), "builtin:edit is replaced");
  assert.match(req?.system ?? "", /`read`, `replace`, `insert`/);

  const edits = results(provider.requests[2] as CompletionRequest);
  const [e1, e2] = edits as [ToolResult, ToolResult];
  // the diff: dead `-` anchor, fresh `+` anchors, context rows keep theirs
  const a = (s: string) => first.get(s) as string;
  assert.match(
    e1.output,
    new RegExp(`^ ${a("one")}│one\n-${a("two")}│two\n\\+[a-z]{5}│TWO\n\\+[a-z]{5}│extra\n ${a("three")}│three$`),
  );
  assert.match(e2.output, new RegExp(`^ \\.\\.\\.\n ${a("three")}│three\n\\+[a-z]{5}│four$`));
  const msgs = end?.messages ?? [];
  const res = msgs.flatMap((m) => (m.role === "tool" ? m.results : []));
  // details stay out of requests: from the run's history
  assert.deepEqual(
    (res.find((r) => r.id === "e1")?.details as { numbers: unknown } | undefined)?.numbers,
    [1, 2, 2, 3, 4],
  );
  // all deleted at the end
  assert.equal(await readFile(file, "utf8"), "");
  assert.match(out(provider.requests[6] as CompletionRequest), /^-[a-z]{5}│a\n-[a-z]{5}│b\n-[a-z]{5}│c\n\+[a-z]{5}│$/);

  // the anchors are session entries: resuming restores them
  const resumed = await openSession(session.leafId);
  await agent.setSession(resumed, "resume");
  assert.deepEqual(registry(resumed.getState()), registry(session.getState()));
  assert.equal(Object.keys(registry(resumed.getState()).files).length, 1);

  // blocks: the edit's diff with line numbers; the read's rows with line numbers
  const tools = composeTools(
    agent.plugins.map((p) => p.plugin as CliPlugin),
    undefined,
    assert.fail,
  );
  const calls = msgs.flatMap((m) => (m.role === "assistant" ? m.toolCalls : []));
  const view = (id: string) => {
    const call = calls.find((c) => c.id === id);
    const result = res.find((r) => r.id === id);
    assert.ok(call && result);
    return { call, result, details: result.details, width: 80 };
  };
  assert.match(tools("replace").text(view("e1")), /^replace a\.txt [a-z]{5}\.\.[a-z]{5}\n\n1 │ {2}[a-z]{5}│one\n2 │ -/);
  assert.match(
    tools("read").text(view("r1")),
    /^read .*a\.txt\n\n1 │ [a-z]{5}│one\n2 │ [a-z]{5}│two\n3 │ [a-z]{5}│three$/,
  );
});

test("a range with lines never shown is refused with fresh anchors, which a retry can use", async (t) => {
  t.after(await tempHome({ plugins: { "hashline-edit": dir } }));
  const file = join(homedir(), "b.txt");
  await writeFile(file, "1\n2\n3\n4\n");
  let rows = new Map<string, string>();
  const provider = scripted([
    {
      toolCalls: [
        { id: "r1", name: "read", input: { path: file, limit: 1 } },
        { id: "r2", name: "read", input: { path: file, offset: 3, limit: 1 } },
      ],
    },
    (req) => {
      assert.match(out(req), /\[Showing lines 1-1 of 4\. Use offset=[a-z]{5} to continue\.\]$/);
      rows = new Map([...anchors(out(req, 0)), ...anchors(out(req, 1))]);
      return {
        toolCalls: [
          { id: "e1", name: "replace", input: { remove_from: rows.get("1"), remove_to: rows.get("3"), text: "x" } },
        ],
      };
    },
    (req) => {
      assert.match(out(req), /^\[E_RANGE_STALE\] Line 2 of the replaced range \(lines 1-3\) in b\.txt was never shown/);
      return {
        toolCalls: [
          {
            id: "e2",
            name: "replace",
            input: { path: file, remove_from: rows.get("1"), remove_to: rows.get("3"), text: "x" },
          },
        ],
      };
    },
    { text: "done" },
  ]);
  const cwd = process.cwd();
  process.chdir(homedir());
  t.after(() => process.chdir(cwd));
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  await agent.run("edit b.txt");
  assert.equal(await readFile(file, "utf8"), "x\n4\n");
});

test("auto-read-all attaches the project before the session's first request, once", async (t) => {
  t.after(await tempHome({ plugins: { "hashline-edit": dir } }));
  await writeFile(join(homedir(), ".hortus", "hashline-edit.json"), JSON.stringify({ autoReadAll: "full" }));
  const repo = join(homedir(), "repo");
  await mkdir(repo);
  await writeFile(join(repo, "c.txt"), "alpha\nbeta\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const cwd = process.cwd();
  process.chdir(repo);
  t.after(() => process.chdir(cwd));
  const provider = scripted([
    (req) => {
      const attached = req.messages.find((m) => m.role === "user" && m.meta?.type === "auto-read-all");
      assert.ok(attached?.role === "user");
      assert.ok(req.messages.some((m) => m.role === "user" && m.content === "hi"));
      assert.match(attached.content, /=== c\.txt ===\n[a-z]{5}│alpha\n[a-z]{5}│beta/);
      // attached rows are served: edit straight from them
      const beta = anchors(attached.content).get("beta");
      return {
        toolCalls: [{ id: "e1", name: "replace", input: { remove_from: beta, remove_to: beta, text: "gamma" } }],
      };
    },
    {},
    (req) => {
      assert.equal(req.messages.filter((m) => m.role === "user" && m.meta).length, 1);
      return {};
    },
  ]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  const session = await openSession(null);
  await agent.setSession(session);
  await agent.run("hi");
  assert.equal(await readFile(join(repo, "c.txt"), "utf8"), "alpha\ngamma\n");
  await agent.run("again");
  // the budget follows the run's context window (ctx.run.info), within pi's bounds
  assert.deepEqual(
    [autoReadBudget(), autoReadBudget(400_000), autoReadBudget(5_000_000)],
    [200_000, 600_000, 2_000_000],
  );
});
