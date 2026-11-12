import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { createAgent } from "./agent.ts";
import { hortusDir } from "./config.ts";
import type { Ctx, Events, Message, Plugin, ProviderDef, Tool, ToolResult } from "./llm.ts";
import { tool } from "./llm.ts";
import type { LoadOptions, Named } from "./plugins.ts";
import { memorySession, openSession, type PluginEntry } from "./session.ts";
import { record, scripted, type Turn, tempDir, tempHome, untimed, until } from "./testing.ts";
import { withToolLock } from "./tools.ts";

declare module "./llm.ts" {
  interface Events {
    "x:y": { log: string[] };
  }
}

const user = "hi";
const history: Message[] = [{ role: "user", content: user }];
const echo = tool({
  name: "echo",
  description: "Echoes",
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => text,
});

/** An agent on a scripted provider with `turns`, then `plugins`, a recorder, and `opts.extra`. */
async function setup(
  t: { after: (fn: () => Promise<void>) => void },
  turns: Turn[],
  plugins: Named[] = [],
  opts: LoadOptions = {},
) {
  t.after(await tempHome());
  const provider = scripted(turns);
  const rec = record();
  const agent = await createAgent({
    ...opts,
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider }, tools: [echo] } },
      ...plugins,
      { name: "rec", plugin: rec },
      ...(opts.extra ?? []),
    ],
  });
  const names = () =>
    rec.events.map((e) => e.name).filter((n) => n !== "skills" && n !== "init" && n !== "ready" && n !== "mcp_servers");
  const payloads = <E extends keyof Events>(name: E) =>
    rec.events.filter((e) => e.name === name).map((e) => e.payload as Events[E]);
  return { agent, provider, rec, names, payloads };
}

const call = (id: string, name: string, input: unknown = {}) => ({ id, name, input });
/** `m` without its `entryId` (core sets it on every message it saves). */
const plain = (m?: Message) => {
  const { entryId: _, ...rest } = m ?? ({} as Message);
  return rest;
};
/** The last message's text, if it is the assistant's. */
const text = (messages: Message[] = []) => {
  const m = messages.at(-1);
  return m?.role === "assistant" ? m.text : undefined;
};
const lastResults = (req?: { messages: Message[] }) => {
  const m = req?.messages.at(-1);
  return m?.role === "tool" ? m.results : [];
};

test("event order: no tools, two parallel tools, a provider throw, aborts mid-stream and mid-tool", async (t) => {
  {
    const { agent, names, payloads } = await setup(t, [{ text: "hi" }]);
    await agent.run(user);
    assert.deepEqual(names(), [
      ...[
        "input",
        "message",
        "run_start",
        "prompt",
        "turn_start",
        "request",
        "text",
        "response",
        "message",
        "turn_end",
      ],
      ...["run_end", "idle"],
    ]);
    assert.equal(payloads("run_end").length, 1);
  }
  {
    const { agent, names } = await setup(t, [
      { toolCalls: [call("1", "echo", { text: "a" }), call("2", "echo", { text: "b" })] },
      {},
    ]);
    await agent.run(user);
    assert.deepEqual(names(), [
      ...["input", "message", "run_start", "prompt", "turn_start", "request", "response", "message"],
      ...["tool_call", "tool_gate", "tool_call", "tool_gate", "tool_result", "tool_result", "message", "turn_end"],
      ...["turn_start", "request", "response", "message", "turn_end", "run_end", "idle"],
    ]);
  }
  {
    const { agent, names, payloads } = await setup(t, []);
    await assert.rejects(agent.run(user), /no turn left/);
    assert.deepEqual(names(), [
      ...["input", "message", "run_start", "prompt", "turn_start", "request", "response", "run_end", "idle"],
    ]);
    assert.match(String(payloads("response")[0]?.error), /no turn left/);
    assert.match(String(payloads("run_end")[0]?.error), /no turn left/);
  }
  {
    const abort = new AbortController();
    const { agent, names, payloads } = await setup(t, [
      async (req, _, callbacks) => {
        callbacks?.text?.("partial");
        abort.abort();
        req.signal?.throwIfAborted();
        return {};
      },
    ]);
    const end = await agent.run(user, { signal: abort.signal });
    assert.deepEqual(names(), [
      ...["input", "message", "run_start", "prompt", "turn_start", "request", "text", "response", "run_end", "idle"],
    ]);
    assert.deepEqual(end?.aborted, { by: "user" });
    assert.deepEqual(payloads("run_end")[0]?.aborted, { by: "user" });
  }
  {
    // a long-running tool ends when the run is aborted (ctx.signal)
    const abort = new AbortController();
    const wait = tool({
      name: "wait",
      description: "",
      inputSchema: z.object({}),
      execute: (_, ctx) =>
        new Promise((_, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("stopped")));
          abort.abort();
        }),
    });
    const { agent, names, payloads } = await setup(
      t,
      [{ toolCalls: [call("1", "wait")] }],
      [{ name: "w", plugin: { tools: [wait] } }],
    );
    const end = await agent.run(user, { signal: abort.signal });
    assert.deepEqual(names(), [
      ...["input", "message", "run_start", "prompt", "turn_start", "request", "response", "message"],
      ...["tool_call", "tool_gate", "tool_result", "message", "turn_end", "run_end", "idle"],
    ]);
    assert.deepEqual(untimed(payloads("tool_result")[0]?.result), { id: "1", output: "stopped", isError: true });
    assert.deepEqual(end?.aborted, { by: "user" });
  }
});

test("run_start shapes the run: a removed tool is undeclared and unknown, model and effort reach the provider, prompt sees it", async (t) => {
  const plugin: Plugin = {
    on: {
      run_start: (p) => {
        p.tools = p.tools.filter((t) => t.name !== "echo" && t.name !== "edit");
        p.model = "m2";
        p.effort = "high";
      },
      prompt: ({ system, tools }) => {
        if (tools.some((t) => t.name === "edit")) system.push("Prefer the edit tool.");
      },
    },
  };
  const { agent, provider } = await setup(
    t,
    [{ toolCalls: [call("1", "echo", { text: "a" })] }, {}],
    [{ name: "p", plugin }],
  );
  await agent.run(user);
  const [req] = provider.requests;
  assert.ok(!req?.tools.some((t) => t.name === "echo" || t.name === "edit"));
  assert.deepEqual([req?.model, req?.effort], ["m2", "high"]);
  assert.doesNotMatch(req?.system ?? "", /Prefer the edit tool/);
  assert.deepEqual(lastResults(provider.requests[1]), [{ id: "1", output: "Unknown tool: echo", isError: true }]);
});

test("request edits apply to that call only; its messages are a copy; codemode tools can be declared for one call", async (t) => {
  const hidden = tool({
    name: "hidden",
    description: "",
    inputSchema: z.object({}),
    exposure: "codemode",
    execute: async () => "ran",
  });
  let n = 0;
  const plugin: Plugin = {
    tools: [hidden],
    on: {
      request: (r, ctx) => {
        if (n++) return;
        r.system += "\nONCE-ONLY";
        (r.messages[0] as { content: string }).content += " [once]";
        r.messages.push({ role: "user", content: "injected" });
        r.tools.push(ctx.tools.find((t) => t.name === "hidden") as Tool);
      },
    },
  };
  const { agent, provider } = await setup(
    t,
    [{ toolCalls: [call("1", "hidden")] }, { toolCalls: [call("2", "hidden")] }, {}],
    [{ name: "p", plugin }],
  );
  const end = await agent.run(user);
  const [first, second] = provider.requests;
  assert.match(first?.system ?? "", /ONCE-ONLY$/);
  assert.deepEqual(first?.messages.at(-1), { role: "user", content: "injected" });
  assert.ok(first?.tools.some((t) => t.name === "hidden"));
  assert.doesNotMatch(second?.system ?? "", /ONCE-ONLY/);
  assert.ok(!second?.tools.some((t) => t.name === "hidden"));
  assert.ok(!end?.messages.some((m) => m.role === "user" && m.content === "injected"));
  // in-place edits stay in that request too: not in the next one, the run's history or the caller's
  assert.equal(first?.messages[0]?.role === "user" && first.messages[0].content, "hi [once]");
  assert.deepEqual(second?.messages[0], { role: "user", content: "hi" });
  assert.deepEqual(plain(end?.messages[0]), { role: "user", content: "hi" });
  // declared in that request: it ran; not declared in the next: unknown, with a hint
  assert.deepEqual(lastResults(second), [{ id: "1", output: "ran" }]);
  assert.match(lastResults(provider.requests[2])[0]?.output ?? "", /only reachable from codemode/);
});

test("response pairs with request by id (ctx.complete's too, with its plugin as source); response.request is what was sent", async (t) => {
  const sub = tool({
    name: "sub",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => (await ctx.complete({ messages: [{ role: "user", content: "inner" }] })).text,
  });
  const seen: [string, string, string | undefined][] = [];
  const responded: (string | undefined)[] = [];
  const observer: Plugin = {
    tools: [sub],
    on: {
      request: (r, ctx) => void seen.push([r.source, r.id, ctx.callId]),
      response: (_, ctx) => void responded.push(ctx.callId),
    },
  };
  // loaded after the recorder: its edit is in what was sent
  const late: Named = {
    name: "late",
    plugin: {
      on: {
        request: (r) => {
          r.system = "edited";
        },
      },
    },
  };
  const { agent, provider, payloads } = await setup(
    t,
    [{ toolCalls: [call("c1", "sub")] }, { text: "from inner" }, {}],
    [{ name: "obs", plugin: observer }],
    { extra: [late] },
  );
  await agent.run(user);
  const requests = payloads("request");
  const responses = payloads("response");
  assert.deepEqual(
    responses.map((r) => r.id),
    requests.map((r) => r.id),
  );
  assert.deepEqual(
    seen.map(([source, , callId]) => [source, callId]),
    [
      ["run", undefined],
      ["obs", "c1"],
      ["run", undefined],
    ],
  );
  assert.deepEqual(responded, [undefined, "c1", undefined]);
  assert.deepEqual(lastResults(provider.requests[2]), [{ id: "c1", output: "from inner" }]);
  for (const [i, r] of responses.entries()) {
    assert.equal(r.request.system, provider.requests[i]?.system);
    assert.equal(r.request.system, "edited");
  }
});

test("tool_call: a result set skips execution and is final; input edits run but aren't saved; invalid edits fail", async (t) => {
  let ran = 0;
  const count = tool({
    name: "count",
    description: "",
    inputSchema: z.object({}),
    execute: async () => String(++ran),
  });
  const after: unknown[] = [];
  const first: Plugin = {
    tools: [count],
    on: {
      tool_call: (p) => {
        if (p.call.name === "count") p.result = { id: p.call.id, output: "cached" };
        if (p.call.id === "e1") (p.call.input as { text: string }).text = "edited";
        if (p.call.id === "e2") p.call.input = { text: 5 };
      },
    },
  };
  const second: Plugin = {
    on: {
      tool_call: (p) => {
        after.push(p.result?.output);
        p.result = undefined;
      },
    },
  };
  // replacing the first result is undone too
  const third: Plugin = {
    on: {
      tool_call: (p) => {
        if (p.result) p.result = { id: p.call.id, output: "replaced" };
      },
    },
  };
  const { agent, provider, payloads } = await setup(
    t,
    [{ toolCalls: [call("c", "count"), call("e1", "echo", { text: "orig" }), call("e2", "echo", { text: "x" })] }, {}],
    [
      { name: "first", plugin: first },
      { name: "second", plugin: second },
      { name: "third", plugin: third },
    ],
  );
  const end = await agent.run(user);
  assert.equal(ran, 0);
  assert.deepEqual(after, ["cached", undefined, undefined]);
  assert.deepEqual(payloads("tool_result")[0]?.result, { id: "c", output: "cached" });
  const [cached, edited, invalid] = lastResults(provider.requests[1]);
  assert.deepEqual(cached, { id: "c", output: "cached" });
  assert.deepEqual(edited, { id: "e1", output: "edited" });
  assert.match(invalid?.output ?? "", /^Invalid input/);
  assert.equal(payloads("tool_result").length, 3);
  // the model's input is kept in the history, the saved message and what providers get
  const assistant = end?.messages[1];
  assert.deepEqual(assistant?.role === "assistant" && assistant.toolCalls[1]?.input, { text: "orig" });
  assert.deepEqual(provider.requests[1]?.messages[1], plain(assistant));
});

test("response.retry re-sends the turn once", async (t) => {
  const plugin: Plugin = {
    on: {
      response: (r) => {
        r.retry = true;
      },
    },
  };
  const { agent, provider, names } = await setup(
    t,
    [{ text: "a" }, { text: "b" }, { text: "c" }],
    [{ name: "p", plugin }],
  );
  const end = await agent.run(user);
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(plain(end?.messages.at(-1)), { role: "assistant", text: "b", toolCalls: [] });
  assert.equal(names().filter((n) => n === "request").length, 2);
});

test("ctx.preview returns the request a run would send and sends nothing", async (t) => {
  const { agent, provider, names, payloads } = await setup(t, [{ text: "hi" }]);
  const session = await openSession(null);
  await session.append(history);
  const before = await readFile(session.path ?? "", "utf8");
  const req = await agent.ctx.preview(history, { session });
  assert.equal(req.source, "preview");
  assert.match(req.system, /coding agent/);
  assert.deepEqual(req.messages, history);
  assert.ok(req.tools.some((t) => t.name === "echo"));
  assert.equal(provider.requests.length, 0);
  assert.equal(await readFile(session.path ?? "", "utf8"), before);
  // run_end fires too, so per-run state is cleaned up
  assert.deepEqual(names(), ["run_start", "prompt", "request", "run_end"]);
  assert.deepEqual(payloads("run_end"), [{ source: "preview", messages: history }]);
});

test("ctx.preview also returns the context files and skills a run would load", async (t) => {
  const plugin: Plugin = {
    on: {
      skills: (p) => void p.skills.push({ name: "s", description: "d", path: "/s/SKILL.md" }),
      run_start: (p) => void p.context.push({ path: "/x/AGENTS.md", content: "x" }),
    },
  };
  const { agent } = await setup(t, [], [{ name: "p", plugin }]);
  const req = await agent.ctx.preview(history);
  assert.deepEqual(req.context.at(-1), { path: "/x/AGENTS.md", content: "x" });
  assert.ok(req.skills?.some((s) => s.name === "s"));
});

test("CompleteRequest.signal aborts that call, like the run's signal", async (t) => {
  const { agent, provider } = await setup(t, [
    (req) =>
      new Promise((_, reject) =>
        req.signal?.addEventListener("abort", () => reject(req.signal?.reason), { once: true }),
      ),
  ]);
  const c = new AbortController();
  const done = agent.ctx.complete({ messages: history, signal: c.signal });
  await until(() => provider.requests.length === 1);
  c.abort(new Error("too slow"));
  await assert.rejects(done, /too slow/);
  assert.equal(provider.requests.length, 1);
});

test("request names its provider; declared tools' prompts follow their declaration; run_start.context is the AGENTS.md", async (t) => {
  const promptful = tool({
    name: "promptful",
    description: "",
    prompt: "Use promptful for everything.",
    inputSchema: z.object({}),
    execute: async () => "",
  });
  const seen: string[] = [];
  const plugin: Plugin = {
    tools: [promptful],
    on: {
      run_start: (p) => {
        p.context = p.context.map((f) => ({ ...f, content: f.content.toUpperCase() }));
      },
      // undeclared in the second request: its prompt goes with it
      request: (r) => {
        seen.push(r.system);
        if (r.messages.length > 1) r.tools = r.tools.filter((t) => t.name !== "promptful");
      },
    },
  };
  const { agent, provider, payloads } = await setup(
    t,
    [{ toolCalls: [call("1", "echo", { text: "a" })] }, {}, {}, {}],
    [{ name: "p", plugin }],
  );
  await writeFile(join(hortusDir(), "AGENTS.md"), "be brief");
  await agent.run(user);
  const [first, second] = provider.requests;
  // a sent system reused with the same tools doesn't get their prompts twice
  await agent.ctx.complete({ system: first?.system ?? "", messages: history, tools: [promptful] });
  assert.equal(provider.requests[2]?.system, first?.system);
  // quoted inside a longer paragraph, it isn't the appended block: still appended
  const quoting = "Never say Use promptful for everything. to users";
  await agent.ctx.complete({ system: quoting, messages: history, tools: [promptful] });
  assert.equal(provider.requests[3]?.system, `${quoting}\n\nUse promptful for everything.`);
  assert.match(first?.system ?? "", /BE BRIEF[\s\S]*\n\nUse promptful for everything\.$/);
  assert.doesNotMatch(second?.system ?? "", /promptful/);
  assert.deepEqual(payloads("prompt")[0]?.context[0], { path: join(hortusDir(), "AGENTS.md"), content: "BE BRIEF" });
  // the request handlers saw it before the tools' prompts; response.request is what was sent
  assert.doesNotMatch(seen[0] ?? "", /promptful/);
  assert.equal(payloads("response")[0]?.request.system, first?.system);
  for (const r of payloads("request")) assert.deepEqual([r.provider, r.type], ["scripted", "scripted"]);
  assert.ok(!("provider" in (first ?? {})));
});

test("tool_update carries its call, and its handlers' edits are saved; a replaced tool_result result is what's used", async (t) => {
  const updating = tool({
    name: "updating",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      ctx.update({ raw: "\x1b[1mx" });
      return "out";
    },
  });
  const plugin: Plugin = {
    tools: [updating],
    on: {
      tool_update: (p) => {
        if (p.call.name === "updating") p.details = { clean: "x" };
      },
      tool_result: (p) => {
        p.result = { ...p.result, output: `${p.result.output}!` };
      },
    },
  };
  const { agent, provider, payloads } = await setup(
    t,
    [{ toolCalls: [call("1", "updating")] }, {}],
    [{ name: "p", plugin }],
  );
  const end = await agent.run(user);
  assert.deepEqual(payloads("tool_update")[0]?.call, call("1", "updating"));
  assert.deepEqual(untimed(plain(end?.messages[2])), {
    role: "tool",
    results: [{ id: "1", output: "out!", details: { clean: "x" } }],
  });
  assert.deepEqual(lastResults(provider.requests[1]), [{ id: "1", output: "out!" }]);
});

test("every run tool has its plugin: the one that provided it, even when wrapped", async (t) => {
  const wrapper: Plugin = { tools: [{ name: "read", wrap: (d) => ({ ...d, description: "wrapped" }) }] };
  const { agent, payloads } = await setup(t, [{}], [{ name: "w", plugin: wrapper }]);
  await agent.run(user);
  const tools = payloads("run_start")[0]?.tools ?? [];
  assert.ok(tools.length > 0 && tools.every((t) => t.plugin));
  assert.equal(tools.find((t) => t.name === "read")?.plugin, "builtin:read");
  assert.equal(tools.find((t) => t.name === "bash")?.plugin, "builtin:bash");
  assert.equal(tools.find((t) => t.name === "echo")?.plugin, "scripted");
});

test("a provider wrapper sends ctx.session's id as a header; concurrent runs send their own", async (t) => {
  // the turn checks it got its own run's session id
  const own: Turn = (req, ctx) => ({ text: String(req.headers?.["x-session"] === ctx?.session?.id) });
  const wrap: Plugin = {
    providers: {
      scripted: {
        wrap: (D): ProviderDef => ({
          ...D,
          create: (entry, opts) => {
            const p = D.create(entry, opts);
            return {
              ...p,
              complete: (req, cb, ctx) =>
                p.complete({ ...req, headers: { ...req.headers, "x-session": ctx?.session?.id ?? "" } }, cb, ctx),
            };
          },
        }),
      },
    },
  };
  const { agent, provider } = await setup(t, [own, own], [{ name: "wrap", plugin: wrap }]);
  const [a, b] = [await openSession(null), await openSession(null)];
  const ends = await Promise.all([agent.run(user, { session: a }), agent.run(user, { session: b })]);
  assert.deepEqual(provider.requests.map((r) => r.headers?.["x-session"]).sort(), [a.id, b.id].sort());
  for (const end of ends) assert.equal(text(end?.messages), "true");
});

test("a call the provider ran itself is shown, not run or answered, and alone doesn't continue the run", async (t) => {
  const result: ToolResult = { id: "s1", output: "found" };
  const { agent, provider, payloads } = await setup(t, [
    { text: "searched", toolCalls: [{ id: "s1", name: "web_search", input: { q: "x" }, result }] },
  ]);
  const end = await agent.run(user);
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(payloads("tool_call")[0]?.result, result);
  assert.deepEqual(payloads("tool_result")[0]?.result, result);
  assert.deepEqual(
    end?.messages.map((m) => m.role),
    ["user", "assistant"],
  );
});

test("a replaced tool_result keeps its call's id; one that isn't a result is ignored", async (t) => {
  const plugin: Plugin = {
    on: {
      tool_result: (p) => {
        if (p.call.id === "1") p.result = { output: "replaced" } as ToolResult;
        if (p.call.id === "2") p.result = null as unknown as ToolResult;
      },
    },
  };
  const { agent, provider } = await setup(
    t,
    [{ toolCalls: [call("1", "echo", { text: "a" }), call("2", "echo", { text: "b" })] }, {}],
    [{ name: "p", plugin }],
  );
  await agent.run(user);
  assert.deepEqual(lastResults(provider.requests[1]), [
    { id: "1", output: "replaced" },
    { id: "2", output: "b" },
  ]);
});

test("a provider-run call's replaced tool_result is in the message that carries it", async (t) => {
  const plugin: Plugin = {
    on: {
      tool_result: (p) => {
        p.result = { ...p.result, output: "edited" };
      },
    },
  };
  const { agent, names } = await setup(
    t,
    [{ toolCalls: [{ id: "s1", name: "web_search", input: {}, result: { id: "s1", output: "found" } }] }],
    [{ name: "p", plugin }],
  );
  const end = await agent.run(user);
  const assistant = end?.messages[1];
  assert.equal(assistant?.role === "assistant" && assistant.toolCalls[0]?.result?.output, "edited");
  // reported before the message that carries it
  assert.deepEqual(names().slice(names().indexOf("response") + 1, -3), ["tool_call", "tool_result", "message"]);
});

test("withToolLock: a plugin tool and builtin:edit on one file in one batch don't interleave", async (t) => {
  const file = join(await tempDir(t, "hortus-lock-"), "f.txt");
  const append = tool({
    name: "append",
    description: "",
    inputSchema: z.object({ path: z.string() }),
    execute: ({ path }) =>
      withToolLock(path, async () => {
        const text = await readFile(path, "utf8");
        // a negative window: an unlocked edit (started alongside) would land in it; nothing to await instead
        await sleep(30);
        await writeFile(path, `${text}\nmore`);
        return "ok";
      }),
  });
  const { agent } = await setup(
    t,
    [
      {
        toolCalls: [
          call("1", "append", { path: file }),
          call("2", "edit", { path: file, edits: [{ oldText: "x", newText: "y" }] }),
        ],
      },
      {},
    ],
    [{ name: "app", plugin: { tools: [append] } }],
  );
  await writeFile(file, "x");
  await agent.run(user);
  // without the lock, edit's write would land while append sleeps, and append's would then undo it
  assert.equal(await readFile(file, "utf8"), "y\nmore");
});

test("withToolLock is re-entrant: a wrapper of edit holding it, and a holder calling edit through ctx.runTool", async (t) => {
  const file = join(await tempDir(t, "hortus-lock-"), "f.txt");
  const edit = (id: string, oldText: string, newText: string) =>
    call(id, "edit", { path: file, edits: [{ oldText, newText }] });
  // holds the file's lock while edit (which takes it too) runs, through ctx.runTool
  const twice = tool({
    name: "twice",
    description: "",
    inputSchema: z.object({}),
    execute: (_, ctx) =>
      withToolLock(file, async () => {
        await ctx.runTool(edit("x", "b", "c"));
        return (await ctx.runTool(edit("y", "c", "d"))).output;
      }),
  });
  const wrapEdit: Plugin = {
    tools: [
      {
        name: "edit",
        wrap: (Default) => ({
          ...Default,
          execute: (input, ctx) => withToolLock((input as { path: string }).path, () => Default.execute(input, ctx)),
        }),
      },
    ],
  };
  const { agent } = await setup(
    t,
    [{ toolCalls: [edit("1", "a", "b")] }, { toolCalls: [call("2", "twice")] }, {}],
    [
      { name: "w", plugin: { tools: [twice] } },
      { name: "wrap", plugin: wrapEdit },
    ],
  );
  await writeFile(file, "a");
  const end = await agent.run(user);
  assert.equal(await readFile(file, "utf8"), "d");
  assert.ok(!end?.messages.some((m) => m.role === "tool" && m.results.some((r) => r.isError)));
});

test("withToolLock: once released, a call from its holder's async context waits its turn", async () => {
  const order: string[] = [];
  let later: Promise<void> | undefined;
  let lateQueued = false;
  let release = () => {};
  const go = new Promise<void>((r) => (release = r));
  await withToolLock("f", async () => {
    // started inside the holder, runs after it has released: it must queue behind the next caller
    later = go.then(() => {
      const p = withToolLock("f", async () => {
        order.push("late");
      });
      lateQueued = true;
      return p;
    });
  });
  const next = withToolLock("f", async () => {
    release();
    await until(() => lateQueued);
    order.push("next");
  });
  await Promise.all([later, next]);
  assert.deepEqual(order, ["next", "late"]);
});

test("a tool returning two images sends both", async (t) => {
  const img = (data: string) => ({ type: "image" as const, mediaType: "image/png" as const, data });
  const shots = tool({
    name: "shots",
    description: "",
    inputSchema: z.object({}),
    execute: async () => [img("AA=="), img("BB==")],
  });
  const { agent, provider } = await setup(
    t,
    [{ toolCalls: [call("1", "shots")] }, {}],
    [{ name: "s", plugin: { tools: [shots] } }],
  );
  await agent.run(user);
  const [r] = lastResults(provider.requests[1]);
  assert.deepEqual(
    r?.images?.map((i) => i.data),
    ["AA==", "BB=="],
  );
  const saved = [...(r?.output ?? "").matchAll(/Image saved to (\S+)\]/g)].map((m) => m[1] as string);
  assert.equal(saved.length, 2);
  await Promise.all(saved.map((p) => rm(p)));
});

test("handler errors: a throwing tool_call blocks the call; throwing tool_result and run_start are reported", async (t) => {
  let ran = false;
  const probe = tool({
    name: "probe",
    description: "",
    inputSchema: z.object({}),
    execute: async () => {
      ran = true;
      return "ran";
    },
  });
  const errors: string[] = [];
  const thrower: Plugin = {
    tools: [probe],
    on: {
      tool_call: () => {
        throw new Error("not allowed");
      },
      tool_result: () => {
        throw new Error("observer broke");
      },
      run_start: () => {
        throw new Error("start broke");
      },
    },
  };
  const { agent, provider } = await setup(
    t,
    [{ toolCalls: [call("1", "probe")] }, { text: "done" }],
    [{ name: "thrower", plugin: thrower }],
    { onError: (plugin, e) => errors.push(`${plugin}: ${e.message}`) },
  );
  const end = await agent.run(user);
  assert.equal(ran, false);
  assert.deepEqual(lastResults(provider.requests[1]), [
    { id: "1", output: "Blocked by thrower: not allowed", isError: true },
  ]);
  assert.deepEqual(errors, [
    "thrower: Plugin thrower's run_start handler failed: start broke",
    "thrower: Plugin thrower's tool_result handler failed: observer broke",
  ]);
  assert.equal(text(end?.messages), "done");
});

test("ctx.runTool from a tool is gated as <parent>/<n> with parentId, and can be blocked", async (t) => {
  let innerRan = false;
  const inner = tool({
    name: "inner",
    description: "",
    inputSchema: z.object({}),
    execute: async () => {
      innerRan = true;
      return "inner";
    },
  });
  const outer = tool({
    name: "outer",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => (await ctx.runTool({ id: "ignored", name: "inner", input: {} })).output,
  });
  const guard: Plugin = {
    tools: [inner, outer],
    on: {
      tool_call: (p) => {
        if (p.call.parentId) p.result = { id: p.call.id, output: "blocked nested call", isError: true };
      },
    },
  };
  const { agent, provider, payloads } = await setup(
    t,
    [{ toolCalls: [call("c1", "outer")] }, {}],
    [{ name: "guard", plugin: guard }],
  );
  await agent.run(user);
  assert.equal(innerRan, false);
  assert.deepEqual(payloads("tool_call")[1]?.call, { id: "c1/1", name: "inner", input: {}, parentId: "c1" });
  assert.equal(payloads("tool_result")[0]?.call.id, "c1/1");
  assert.deepEqual(lastResults(provider.requests[1]), [{ id: "c1", output: "blocked nested call" }]);
});

test("batch gating: every tool_call handler finishes before any tool starts; a sequential tool runs alone, last", async (t) => {
  const log: string[] = [];
  // the parallel calls a and b each wait until both have started (a hang if they ran one by one)
  let bothStarted = () => {};
  const both = new Promise<void>((r) => (bothStarted = r));
  const slow = tool({
    name: "slow",
    description: "",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      log.push(`start ${id}`);
      if (log.includes("start a") && log.includes("start b")) bothStarted();
      await both;
      log.push(`end ${id}`);
      return id;
    },
  });
  const seq = { ...slow, name: "seq", sequential: true };
  const gate: Plugin = {
    tools: [slow, seq],
    on: {
      tool_call: async ({ call }) => {
        await new Promise(setImmediate);
        log.push(`gate ${call.id}`);
      },
    },
  };
  const { agent, provider } = await setup(
    t,
    [
      { toolCalls: [call("s", "seq", { id: "s" }), call("a", "slow", { id: "a" }), call("b", "slow", { id: "b" })] },
      {},
    ],
    [{ name: "g", plugin: gate }],
  );
  await agent.run(user);
  assert.deepEqual(log, ["gate s", "gate a", "gate b", "start a", "start b", "end a", "end b", "start s", "end s"]);
  assert.deepEqual(
    lastResults(provider.requests[1]).map((r) => r.output),
    ["s", "a", "b"],
  );
});

test("turn_end.stop ends the run; ctx.abort from turn_end ends it as aborted by that plugin", async (t) => {
  {
    const stop: Plugin = {
      on: {
        turn_end: (p) => {
          p.stop = true;
        },
      },
    };
    const { agent, provider } = await setup(
      t,
      [{ toolCalls: [call("1", "echo", { text: "a" })] }, {}],
      [{ name: "stop", plugin: stop }],
    );
    const end = await agent.run(user);
    assert.equal(provider.requests.length, 1);
    assert.equal(end?.aborted, undefined);
  }
  {
    const budget: Plugin = { on: { turn_end: (_, ctx) => ctx.abort("budget") } };
    const { agent, provider, payloads } = await setup(
      t,
      [{ toolCalls: [call("1", "echo", { text: "a" })] }, {}],
      [{ name: "budget", plugin: budget }],
    );
    const end = await agent.run(user);
    assert.equal(provider.requests.length, 1);
    assert.deepEqual(end?.aborted, { by: "budget", reason: "budget" });
    assert.deepEqual(payloads("run_end")[0]?.aborted, { by: "budget", reason: "budget" });
  }
});

test("ctx.complete reaches another provider, with its maxOutput as maxTokens; listModels lists every provider", async (t) => {
  t.after(
    await tempHome({
      secrets: { scripted: { type: "scripted", apiKey: "k" }, other: { type: "other", apiKey: "k" } },
    }),
  );
  const main = scripted([]);
  const base = scripted([{ text: "from other" }]);
  const other: ProviderDef = {
    create: (e, o) => ({ ...base.create(e, o), info: async () => ({ maxOutput: 123 }) }),
  };
  const seen: (number | undefined)[] = [];
  const agent = await createAgent({
    extra: [
      { name: "p", plugin: { providers: { scripted: main, other } } },
      { name: "obs", plugin: { on: { request: (r) => void seen.push(r.maxTokens) } } },
    ],
  });
  const reply = await agent.ctx.complete({ provider: "other", model: "m2", messages: history });
  assert.equal(reply.text, "from other");
  assert.equal(main.requests.length, 0);
  assert.deepEqual([base.requests[0]?.model, base.requests[0]?.maxTokens], ["m2", 123]);
  assert.deepEqual(seen, [123]);
  assert.deepEqual(await agent.ctx.listModels(), [
    { provider: "scripted", id: "scripted" },
    { provider: "other", id: "scripted" },
  ]);
});

test("ctx.emit reaches every plugin's handler in load order, with the emitter's ctx", async (t) => {
  t.after(await tempHome());
  const handler =
    (name: string) =>
    (p: { log: string[] }, ctx: Ctx): void =>
      void p.log.push(`${name} ${ctx.busy()}`);
  const agent = await createAgent({
    extra: [
      { name: "a", plugin: { on: { "x:y": handler("a") } } },
      { name: "b", plugin: {} },
      { name: "c", plugin: { on: { "x:y": handler("c") } } },
    ],
  });
  const p = { log: [] as string[] };
  await agent.ctx.emit("x:y", p);
  assert.deepEqual(p.log, ["a false", "c false"]);
});

test("a run aborted while its calls are gated runs none of them", async (t) => {
  const ran: string[] = [];
  const probe = tool({
    name: "probe",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      ran.push(ctx.callId);
      return "ran";
    },
  });
  const marker = join(await tempDir(t, "hortus-"), "ran");
  const stopper: Plugin = {
    tools: [probe],
    on: {
      tool_call: (p, ctx) => {
        if (p.call.id === "3") ctx.abort("enough");
      },
    },
  };
  const { agent, payloads } = await setup(
    t,
    [{ toolCalls: [call("1", "probe"), call("2", "bash", { command: `touch ${marker}` }), call("3", "probe")] }],
    [{ name: "stopper", plugin: stopper }],
  );
  const end = await agent.run(user);
  assert.deepEqual(ran, []);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(
    payloads("tool_result").map((p) => p.result),
    ["1", "2", "3"].map((id) => ({ id, output: "Aborted", isError: true })),
  );
  assert.deepEqual(end?.aborted, { by: "stopper", reason: "enough" });
});

test("handlers of queued events (text, tool_update) can await ctx.complete and ctx.runTool", {
  timeout: 5000,
}, async (t) => {
  const got: string[] = [];
  const updating = tool({
    name: "updating",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      ctx.update("half");
      return "done";
    },
  });
  const plugin: Plugin = {
    tools: [updating],
    on: {
      text: async (d, ctx) => {
        got.push((await ctx.complete({ messages: [{ role: "user", content: d }] })).text);
      },
      tool_update: async (_, ctx) => {
        got.push((await ctx.runTool(call("n", "echo", { text: "nested" }))).output);
      },
    },
  };
  const { agent, provider } = await setup(
    t,
    [{ text: "hello", toolCalls: [call("1", "updating")] }, { text: "classified" }, {}],
    [{ name: "p", plugin }],
  );
  await agent.run(user);
  assert.deepEqual(got, ["classified", "nested"]);
  assert.equal(provider.requests.length, 3);
});

test("outside a run, a queued handler's error reaches only the call it came from", async (t) => {
  let once = true;
  const updating = tool({
    name: "updating",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      ctx.update(1);
      return "done";
    },
  });
  const plugin: Plugin = {
    tools: [updating],
    on: {
      tool_update: () => {
        if (!once) return;
        once = false;
        throw new Error("boom");
      },
    },
  };
  const { agent } = await setup(t, [{ text: "a" }, { text: "b" }], [{ name: "p", plugin }], {
    onError: (_, e) => {
      throw e;
    },
  });
  await assert.rejects(agent.ctx.runTool(call("h1", "updating")), /p's tool_update handler failed: boom/);
  assert.equal((await agent.ctx.complete({ messages: history })).text, "a");
  assert.equal((await agent.ctx.runTool(call("h2", "updating"))).output, "done");
  assert.equal((await agent.ctx.complete({ messages: history })).text, "b");
});

test("handler errors are reported (default: to stderr) and every later handler still runs", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const fail = (event: string) => () => {
    throw new Error(`${event} broke`);
  };
  const thrower: Plugin = {
    on: { request: fail("request"), text: fail("text"), tool_result: fail("tool_result"), run_end: fail("run_end") },
  };
  const { agent, names } = await setup(
    t,
    [{ toolCalls: [call("1", "echo", { text: "a" }), call("2", "echo", { text: "b" })] }, { text: "done" }],
    [{ name: "thrower", plugin: thrower }],
  );
  const end = await agent.run(user);
  assert.equal(text(end?.messages), "done");
  // the recorder, loaded after the thrower, sees every event in order
  assert.deepEqual(names(), [
    ...["input", "message", "run_start", "prompt", "turn_start", "request", "response", "message"],
    ...["tool_call", "tool_gate", "tool_call", "tool_gate", "tool_result", "tool_result", "message", "turn_end"],
    ...["turn_start", "request", "text", "response", "message", "turn_end", "run_end", "idle"],
  ]);
  assert.deepEqual(
    logged.mock.calls.map((c) => c.arguments[0]),
    ["request", "tool_result", "tool_result", "request", "text", "run_end"].map(
      (e) => `Plugin thrower's ${e} handler failed: ${e} broke`,
    ),
  );
});

test("ctx.runTool's signal aborts that call alone (and its own nested calls, asks and completions); the run goes on", async (t) => {
  const seen: { sleep?: AbortSignal; nested?: AbortSignal; ask?: string; complete?: string } = {};
  const nested = tool({
    name: "nested",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      seen.nested = ctx.signal;
      return "nested";
    },
  });
  const slow = tool({
    name: "slow",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      seen.sleep = ctx.signal;
      await ctx.runTool({ id: "", name: "nested", input: {} });
      // an ask nobody answers and a completion that never ends: both end with the runTool signal
      void ctx.ask({ question: "?" }, { detailed: true }).then((a) => (seen.ask = a.reason));
      void ctx.complete({ messages: [] }).catch((e: Error) => (seen.complete = e.message));
      await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
      throw new Error("cancelled");
    },
  });
  const outer = tool({
    name: "outer",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      const c = new AbortController();
      const running = ctx.runTool({ id: "", name: "slow", input: {} }, { signal: c.signal });
      // once slow's completion is in flight (its ask was made just before)
      await until(() => provider.requests.length === 2);
      c.abort();
      const r = await running;
      return `${r.output}; run aborted: ${ctx.signal.aborted}`;
    },
  });
  const { agent, provider } = await setup(
    t,
    [
      { toolCalls: [call("c1", "outer")] },
      (req) =>
        new Promise((_, reject) =>
          req.signal?.addEventListener("abort", () => reject(new Error("complete aborted")), { once: true }),
        ),
      {},
    ],
    [{ name: "p", plugin: { tools: [nested, slow, outer], on: { ask: () => new Promise(() => {}) } } }],
  );
  await agent.run(user);
  assert.deepEqual(lastResults(provider.requests.at(-1)), [{ id: "c1", output: "cancelled; run aborted: false" }]);
  assert.equal(seen.sleep?.aborted, true);
  assert.equal(seen.nested?.aborted, true);
  assert.deepEqual([seen.ask, seen.complete], ["aborted", "complete aborted"]);
});

test("a wrapped tool's original gets its own plugin's ctx.state, not the wrapper's", async (t) => {
  const states: Record<string, unknown>[] = [];
  const own = tool({
    name: "own",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      states.push(ctx.state);
      return "";
    },
  });
  const wrapper: Plugin = { tools: [{ name: "own", wrap: (d) => d }] };
  const { agent } = await setup(
    t,
    [],
    [
      { name: "o", plugin: { tools: [own] } },
      { name: "w", plugin: wrapper },
    ],
  );
  await agent.ctx.runTool({ id: "x", name: "own", input: {} });
  assert.equal(states.at(-1), agent.ctxOf("o").state);
});

test("ctx.state: one object per plugin and agent, shared by its handlers, tools and commands", async (t) => {
  const states: unknown[] = [];
  const mine: Plugin = {
    tools: [
      tool({
        name: "st",
        description: "",
        inputSchema: z.object({}),
        execute: async (_, ctx) => {
          states.push(ctx.state);
          return "ok";
        },
      }),
    ],
    commands: [{ name: "st", description: "", run: (_, ctx) => void states.push(ctx.state) }],
    on: {
      init: (_, ctx) => {
        ctx.state.n = 1;
        states.push(ctx.state);
      },
      run_start: (_, ctx) => void states.push(ctx.state),
    },
  };
  const other: Plugin = { on: { init: (_, ctx) => void states.push(ctx.state) } };
  const { agent } = await setup(
    t,
    [{ toolCalls: [call("c1", "st")] }, {}],
    [
      { name: "mine", plugin: mine },
      { name: "other", plugin: other },
    ],
  );
  await agent.run(user);
  await agent
    .commands()
    .find((c) => c.name === "st")
    ?.run("");
  const [init, theirs, ...rest] = states;
  assert.deepEqual(init, { n: 1 });
  assert.notEqual(theirs, init);
  assert.equal(rest.length, 3);
  for (const s of rest) assert.equal(s, init);
  // another agent's is its own
  const again = await createAgent({ extra: [{ name: "mine", plugin: mine }] });
  assert.notEqual(states.at(-1), init);
  await again.close();
});

test("ctx.plugin is the name a plugin was loaded under: its entry types and state.data key follow it", async (t) => {
  const seen: string[] = [];
  const mine: Plugin = {
    tools: [
      tool({
        name: "mark",
        description: "",
        inputSchema: z.object({}),
        execute: async (_, ctx) => {
          seen.push(`tool ${ctx.plugin}`);
          await ctx.session?.appendEntry(`${ctx.plugin}:mark`, 1);
          return "ok";
        },
      }),
    ],
    entries: {
      // a reducer may declare its entry's data
      mark: (e: PluginEntry<number>, state, plugin) => {
        state.data[plugin] = e.data;
      },
    },
    commands: [{ name: "mark", description: "", run: (_, ctx) => void seen.push(`command ${ctx.plugin}`) }],
    on: { run_start: (_, ctx) => void seen.push(`run_start ${ctx.plugin}`) },
  };
  const { agent } = await setup(t, [{ toolCalls: [call("c1", "mark")] }, {}], [{ name: "renamed", plugin: mine }]);
  const session = memorySession();
  await agent.setSession(session);
  await agent.run(user);
  await agent
    .commands()
    .find((c) => c.name === "mark")
    ?.run("");
  assert.deepEqual(seen, ["run_start renamed", "tool renamed", "command renamed"]);
  assert.deepEqual(session.getState().data, { renamed: 1 });
  assert.equal(agent.ctx.plugin, "host");
});

test("a tool pushed into the run's ctx.tools mid-run is declared from the next request on", async (t) => {
  const late = tool({ name: "late", description: "", inputSchema: z.object({}), execute: async () => "late" });
  const adder = tool({
    name: "adder",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      ctx.tools.push(late);
      return "added";
    },
  });
  const { agent, provider } = await setup(
    t,
    [{ toolCalls: [call("c1", "adder")] }, { toolCalls: [call("c2", "late")] }, {}],
    [{ name: "p", plugin: { tools: [adder] } }],
  );
  await agent.run(user);
  const names = provider.requests.map((r) => r.tools.some((x) => x.name === "late"));
  assert.deepEqual(names, [false, true, true]);
  assert.deepEqual(lastResults(provider.requests[2]), [{ id: "c2", output: "late" }]);
  // the agent's own tools are untouched
  assert.ok(!agent.ctx.tools.some((x) => x.name === "late"));
});
