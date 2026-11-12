import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type AssistantMessage,
  type CompletionRequest,
  createAgent,
  hortusDir,
  listSessions,
  type Message,
  openSession,
  type Plugin,
} from "@hortus/core";
import { scripted, tempDir, tempHome } from "@hortus/core/testing";
import type { RegisterRequest, RpcRequest, RunRecord } from "./index.tsx";

const dir = fileURLToPath(new URL("..", import.meta.url));
type Brain = (req: CompletionRequest) => Partial<AssistantMessage> | Promise<Partial<AssistantMessage>>;
/** One provider for parent and children, answering each request by what it is. */
const brain = (fn: Brain) => scripted([...Array(60)].map(() => fn));
const last = (req: CompletionRequest) => req.messages.at(-1) as Message;
const lastUser = (req: CompletionRequest) => req.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
const output = (m: Message | undefined) => (m?.role === "tool" ? (m.results[0]?.output ?? "") : "");

async function setup(fn: Brain, extra: Plugin = {}) {
  const provider = brain(fn);
  const agent = await createAgent({
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider } } },
      { name: "test", plugin: extra },
    ],
  });
  const session = await openSession(null);
  await agent.setSession(session);
  return { provider, agent, session };
}

const rpc = async (agent: Awaited<ReturnType<typeof createAgent>>, method: string, params = {}) => {
  const req: RpcRequest = { version: 1, requestId: method, method, params };
  await agent.ctx.emit("subagents:rpc:v1:request", req);
  assert.ok(req.reply?.success, JSON.stringify(req.reply));
  return req.reply.data as { runs: RunRecord[]; text: string };
};

test("a foreground scout: replaced prompt with project context, its tool allowlist, details, a saved run; resume continues its session", async (t) => {
  t.after(await tempHome({ plugins: { "pi-subagents": dir } }));
  const cwd = await tempDir(t, "pi-subagents-");
  await writeFile(join(cwd, "AGENTS.md"), "Project rule: be terse.");
  const { provider, agent, session } = await setup((req) => {
    if (req.system.includes("scouting subagent")) return { text: `found ${req.messages.length}` };
    if (last(req).role === "tool") return { text: `done: ${output(last(req))}` };
    if (lastUser(req) === "again")
      return { toolCalls: [{ id: "r", name: "subagent", input: { action: "resume", id: runId(), message: "more" } }] };
    return { toolCalls: [{ id: "s", name: "subagent", input: { agent: "scout", task: "find x", cwd } }] };
  });
  const runId = () => Object.keys((session.getState().data["pi-subagents"] as { runs: object }).runs)[0] ?? "";
  await agent.run("go");

  const parent = provider.requests[0];
  assert.deepEqual(
    parent?.tools.map((x) => x.name).filter((n) => n.startsWith("sub")),
    ["subagent", "subagent_supervisor"],
  );
  assert.match(parent?.system ?? "", /<name>pi-subagents<\/name>/);
  const child = provider.requests.find((r) => r.system.includes("scouting subagent"));
  assert.ok(child);
  assert.doesNotMatch(child.system, /You are a coding agent/);
  assert.doesNotMatch(child.system, /available_skills/);
  assert.match(child.system, /Project rule: be terse\./);
  assert.match(child.system, new RegExp(`Working directory: ${cwd}\\.`));
  assert.match(child.system, /You are the "scout" subagent/);
  // scout's allowlist, as far as hortus has those tools, plus the supervisor channel
  assert.deepEqual(child.tools.map((x) => x.name).sort(), ["bash", "contact_supervisor", "read", "write"]);
  assert.deepEqual(child.messages, [{ role: "user", content: "find x" }]);

  const result = session.getState().messages.find((m) => m.role === "tool");
  const r = result?.role === "tool" ? result.results[0] : undefined;
  assert.match(r?.output ?? "", new RegExp(`^found 1\\n\\n\\[subagent scout · run ${runId()} · completed\\]$`));
  const details = r?.details as { results: RunRecord[] };
  assert.equal(details.results[0]?.status, "completed");
  assert.equal(details.results[0]?.turns, 1);
  const saved = (session.getState().data["pi-subagents"] as { runs: Record<string, RunRecord> }).runs[runId()];
  assert.equal(saved?.status, "completed");
  assert.equal((await listSessions({ parent: session.id }))[0]?.id, saved?.session?.id);

  // a new agent on the same session: the run is restored from its entry, and resume continues the child's file
  await agent.close();
  const info = (await listSessions()).find((s) => s.id === session.id);
  const { provider: p2, agent: a2 } = await setup((req) => {
    if (req.system.includes("scouting subagent")) return { text: `resumed ${req.messages.length}` };
    if (last(req).role === "tool") return { text: "ok" };
    return { toolCalls: [{ id: "r", name: "subagent", input: { action: "resume", id: runId(), message: "more" } }] };
  });
  await a2.setSession(await openSession(info?.leafId ?? ""));
  await a2.run("again");
  const resumed = p2.requests.find((x) => x.system.includes("scouting subagent"));
  assert.deepEqual(
    resumed?.messages.map((m) => (m.role === "user" ? m.content : m.role)),
    ["find x", "assistant", "more"],
  );
  assert.match(output(p2.requests.at(-1)?.messages.at(-1)), /^resumed 3\n/);
  await a2.close();
});

test("project agents, parallel tasks, a chain and a workflow script; advertised agents reach the parent prompt", async (t) => {
  t.after(await tempHome({ plugins: { "pi-subagents": dir } }));
  const cwd = await tempDir(t, "pi-subagents-");
  await mkdir(join(cwd, ".hortus", "agents"), { recursive: true });
  await writeFile(
    join(cwd, ".hortus", "agents", "echo.md"),
    "---\nname: echo\ndescription: Echoes its task\naliases: parrot\ntools:\n  - read\nsystemPromptMode: append\nadvertise: true\n---\n\nYou echo.\n",
  );
  const script =
    'const r = await runs.all([{ key: "a", agent: "echo", task: "A" }, { key: "b", agent: "parrot", task: "B" }]);\nconst c = await runs.run("c", { agent: "echo", task: r.map((x) => x.output).join("+") });\nreturn c.output + " n=" + args.n;';
  const { provider, agent, session } = await setup((req) => {
    if (req.system.includes("You echo.")) return { text: `echo:${lastUser(req)}` };
    if (last(req).role === "tool") return { text: "ok" };
    const input =
      lastUser(req) === "par"
        ? {
            tasks: [
              { agent: "echo", task: "A" },
              { agent: "echo", task: "B" },
            ],
          }
        : lastUser(req) === "chain"
          ? {
              chain: [
                { agent: "echo", task: "one" },
                { agent: "echo", task: "two <{previous}> of {task}" },
              ],
              task: "T",
            }
          : { workflow: true, args: { n: 3 } };
    return {
      text: lastUser(req) === "wf" ? `Plan:\n\`\`\`js workflow\n${script}\n\`\`\`` : "",
      toolCalls: [{ id: lastUser(req), name: "subagent", input: { ...input, cwd } }],
    };
  });
  const results = () => session.getState().messages.flatMap((m) => (m.role === "tool" ? m.results : []));
  // agents are found from the session's directory
  await session.setCwd(cwd);

  await agent.run("par");
  assert.match(
    results()[0]?.output ?? "",
    /## 1\. echo \(\w+\) completed\n\necho:A\n\n## 2\. echo \(\w+\) completed\n\necho:B/,
  );
  const parent = provider.requests[0];
  assert.match(parent?.system ?? "", /<advertised_subagents>[\s\S]*- echo: Echoes its task/);
  const child = provider.requests.find((r) => r.system.includes("You echo."));
  // append mode keeps hortus's prompt
  assert.match(child?.system ?? "", /You are a coding agent[\s\S]*You echo\./);
  assert.deepEqual(child?.tools.map((x) => x.name).sort(), ["contact_supervisor", "read"]);

  await agent.run("chain");
  assert.match(
    results()[1]?.output ?? "",
    /^echo:two <echo:one> of T\n\n\[chain: echo \(\w+\) completed → echo \(\w+\) completed\]$/,
  );

  await agent.run("wf");
  assert.equal(results()[2]?.output, "Return:\necho:echo:A+echo:B n=3");
  assert.equal((results()[2]?.details as { results: RunRecord[] } | undefined)?.results.length, 3);
  await agent.close();
});

test("contact_supervisor asks through ctx.ask; steer and interrupt reach a running foreground child over the bus", async (t) => {
  t.after(await tempHome({ plugins: { "pi-subagents": dir } }));
  const asks: string[] = [];
  let open = () => {};
  const gate = new Promise<void>((r) => (open = r));
  let mode = "ask";
  const { agent, session } = await setup(
    async (req) => {
      const l = last(req);
      if (req.system.includes("delegated agent")) {
        if (mode === "ask")
          return l.role === "tool"
            ? { text: `decided: ${output(l)}` }
            : {
                toolCalls: [
                  { id: "c", name: "contact_supervisor", input: { reason: "need_decision", message: "A or B?" } },
                ],
              };
        if (mode === "steer") {
          if (lastUser(req).includes("focus")) return { text: "final with focus" };
          await gate;
          return { text: "partial" };
        }
        // interrupt: wait for the abort
        await new Promise((r) => req.signal?.addEventListener("abort", r));
        throw new Error("aborted");
      }
      if (l.role === "tool") return { text: "ok" };
      return { toolCalls: [{ id: mode, name: "subagent", input: { agent: "delegate", task: mode } }] };
    },
    {
      on: {
        ask: (p) => {
          asks.push(`${p.kind}: ${p.question}`);
          p.resolve("use B");
        },
      },
    },
  );
  const toolOutput = () =>
    output(
      session
        .getState()
        .messages.filter((m) => m.role === "tool")
        .at(-1),
    );

  await agent.run("go");
  assert.deepEqual(asks, ["pi-subagents:supervisor: delegate asks: A or B?"]);
  assert.match(toolOutput(), /^decided: Supervisor reply: use B\n/);

  mode = "steer";
  const steered = agent.run("go");
  const running = async () => {
    let r: RunRecord | undefined;
    for (let i = 0; i < 100 && !r; i++) {
      r = (await rpc(agent, "status")).runs.find((x) => x.status === "running");
      if (!r) await new Promise((ok) => setTimeout(ok, 20));
    }
    assert.ok(r);
    return r;
  };
  const r1 = await running();
  assert.match((await rpc(agent, "steer", { id: r1.id, message: "focus on auth" })).text, /delivered to delegate/);
  open();
  await steered;
  assert.match(toolOutput(), /^final with focus\n/);

  mode = "interrupt";
  const interrupted = agent.run("go");
  const r2 = await running();
  await rpc(agent, "interrupt", { id: r2.id });
  await interrupted;
  assert.match((await rpc(agent, "status", { id: r2.id })).text, /^‖ \w+ delegate \(foreground\) paused /);
  const res = session
    .getState()
    .messages.filter((m) => m.role === "tool")
    .at(-1);
  assert.equal(res?.role === "tool" && res.results[0]?.isError, true);
  await agent.close();
});

test("fork context: the parent's system prompt and history, without subagent calls; instructions in the task", async (t) => {
  t.after(await tempHome({ plugins: { "pi-subagents": dir } }));
  const { provider, agent } = await setup((req) => {
    if (lastUser(req).startsWith("<subagent_instructions>")) return { text: "consistent" };
    if (last(req).role === "tool") return { text: "ok" };
    if (lastUser(req) === "remember 42") return { text: "noted" };
    return { toolCalls: [{ id: "o", name: "subagent", input: { agent: "oracle", task: "check the plan" } }] };
  });
  await agent.run("remember 42");
  await agent.run("ask the oracle");
  const parent = provider.requests[1];
  const child = provider.requests[2];
  assert.equal(child?.system, parent?.system);
  assert.deepEqual(
    child?.messages.map((m) => (m.role === "user" ? m.content.slice(0, 23) : m.role === "assistant" ? m.text : "")),
    ["remember 42", "noted", "ask the oracle", "<subagent_instructions>"],
  );
  assert.match(lastUser(child as CompletionRequest), /You are the oracle[\s\S]*check the plan$/);
  assert.ok(!child?.tools.some((x) => x.name === "subagent"));
  await agent.close();
});

test("lazy activation, runtime registration over the bus, prompt templates, /subagents and the doctor", async (t) => {
  t.after(await tempHome({ plugins: { "pi-subagents": dir } }));
  await writeFile(join(hortusDir(), "pi-subagents.json"), JSON.stringify({ toolActivation: "lazy" }));
  const { provider, agent } = await setup((req) => {
    if (last(req).role === "tool") return { text: "ok" };
    if (lastUser(req) === "delegate") return { toolCalls: [{ id: "e", name: "subagents_enable", input: {} }] };
    return { text: "plain" };
  });
  const names = (i: number) => provider.requests[i]?.tools.map((x) => x.name).filter((n) => n.startsWith("sub"));

  await agent.run("delegate");
  assert.deepEqual(names(0), ["subagents_enable"]);
  // declared from the next request on, and for the session's later runs
  assert.deepEqual(names(1)?.sort(), ["subagent", "subagent_supervisor", "subagents_enable"]);
  await agent.run("again");
  assert.deepEqual(names(2), ["subagent", "subagent_supervisor"]);

  const req: RegisterRequest = {
    version: 1,
    name: "probe",
    definition: { description: "A runtime agent", systemPrompt: "Say probe." },
  };
  await agent.ctx.emit("pi-subagents:runtime-agent-register:v1", req);
  assert.ok(req.result?.ok);
  const cmd = (name: string) => agent.commands().find((c) => c.name === name);
  assert.match((await cmd("subagents")?.run("")) ?? "", /- probe \[runtime\]: A runtime agent/);
  if (req.result?.ok) req.result.registration.dispose();
  assert.doesNotMatch((await cmd("subagents")?.run("")) ?? "", /probe/);

  await cmd("parallel-review")?.run("focus on auth");
  assert.match(
    lastUser(provider.requests.at(-1) as CompletionRequest),
    /^Launch parallel reviewers[\s\S]*\n\nfocus on auth\n\nIf the invocation/,
  );

  assert.match((await cmd("subagents-doctor")?.run("")) ?? "", /✓ 7 agents: [\s\S]*! host isn't interactive/);
  await agent.close();
});
