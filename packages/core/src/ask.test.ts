import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { createAgent } from "./agent.ts";
import { hortusDir } from "./config.ts";
import { type Answered, type AskEvent, type Ctx, type Plugin, tool } from "./llm.ts";
import { memorySession } from "./session.ts";
import { record, scripted, tempHome, until } from "./testing.ts";

const provider = (turns: Parameters<typeof scripted>[0]) => ({
  name: "scripted",
  plugin: { providers: { scripted: scripted(turns) } },
});

test("a handler resolving synchronously answers at once; later handlers see it and `answered` settle", async (t) => {
  t.after(await tempHome());
  const seen: unknown[] = [];
  const agent = await createAgent({
    extra: [
      { name: "policy", plugin: { on: { ask: (p) => p.resolve("yes") } } },
      {
        name: "late",
        plugin: {
          on: {
            ask: async (p) => {
              seen.push(p.signal.aborted);
              seen.push(await p.answered);
            },
          },
        },
      },
    ],
  });
  assert.equal(await agent.ctx.ask({ question: "ok?" }), "yes");
  assert.deepEqual(seen, [true, { answer: "yes", by: "policy", reason: "answered" }]);
});

test("ctx.ask(req, { detailed: true }) tells who answered, why, and a dialog's structured value", async (t) => {
  t.after(await tempHome());
  let reply: (p: AskEvent) => void = () => {};
  const agent = await createAgent({
    extra: [{ name: "dialog", plugin: { on: { ask: (p) => reply(p) } } }],
  });
  const ask = () => agent.ctx.ask({ question: "q?" }, { detailed: true });
  reply = (p) => p.resolve("summary", { value: { picked: [1, 2] } });
  assert.deepEqual(await ask(), { answer: "summary", value: { picked: [1, 2] }, by: "dialog", reason: "answered" });
  reply = (p) => p.resolve(undefined);
  assert.deepEqual(await ask(), { by: "dialog", reason: "dismissed" });
  reply = (p) => p.resolve(undefined, { reason: "timeout" });
  assert.deepEqual(await ask(), { by: "dialog", reason: "timeout" });
  reply = () => {};
  assert.deepEqual(await ask(), { reason: "unanswered" });
  // the plain form is just the answer
  reply = (p) => p.resolve("summary", { value: 1 });
  assert.equal(await agent.ctx.ask({ question: "q?" }), "summary");
});

test("show() and engage() settle `shown` and `engaged` for every handler: a countdown starts when shown, a key stops it", async (t) => {
  t.after(await tempHome());
  const log: string[] = [];
  const countdown: Plugin = {
    on: {
      ask: async (p) => {
        await p.shown;
        log.push("shown");
        // the countdown under test: a real timer
        const timer = sleep(30).then(() => "timer");
        const why = await Promise.race([timer, p.engaged.then(() => "engaged")]);
        log.push(why);
        if (why === "timer") p.resolve(undefined, { reason: "timeout" });
      },
    },
  };
  const ui: Plugin = {
    on: {
      ask: async (p) => {
        p.show();
        if (p.question === "engage") {
          p.engage();
          // answer only once the countdown has seen the key (else its timer would win)
          await until(() => log.includes("engaged"));
          p.resolve("human");
        }
        await p.answered;
      },
    },
  };
  const agent = await createAgent({
    extra: [
      { name: "countdown", plugin: countdown },
      { name: "ui", plugin: ui },
    ],
  });
  assert.deepEqual(await agent.ctx.ask({ question: "wait" }, { detailed: true }), {
    by: "countdown",
    reason: "timeout",
  });
  assert.deepEqual(log, ["shown", "timer"]);
  log.length = 0;
  assert.equal(await agent.ctx.ask({ question: "engage" }), "human");
  assert.deepEqual(log, ["shown", "engaged"]);
});

test("a handler reading `shown` still keeps the ask open until it settles, and may answer", async (t) => {
  t.after(await tempHome());
  const remote: Plugin = {
    on: {
      ask: async (p) => {
        void p.shown.then(() => {});
        await new Promise(setImmediate);
        p.resolve("yes");
      },
    },
  };
  const agent = await createAgent({ extra: [{ name: "remote", plugin: remote }] });
  assert.deepEqual(await agent.ctx.ask({ question: "q?" }, { detailed: true }), {
    answer: "yes",
    by: "remote",
    reason: "answered",
  });
});

test("no handler answers (headless): ctx.ask resolves undefined; ctx.host is headless unless the host says", async (t) => {
  t.after(await tempHome());
  const agent = await createAgent({ extra: [{ name: "watch", plugin: { on: { ask: () => {} } } }] });
  assert.equal(await agent.ctx.ask({ question: "ok?" }), undefined);
  assert.deepEqual(agent.ctx.host, { kind: "headless", interactive: false });
  const tui = await createAgent({ host: { kind: "tui", interactive: true } });
  assert.deepEqual(tui.ctxOf("x").host, { kind: "tui", interactive: true });
});

test("asks race: the first answer wins and aborts the others' signal", async (t) => {
  t.after(await tempHome());
  const aborted: string[] = [];
  // a dialog that only gives up when another answers
  const dialog: Plugin = {
    on: {
      ask: (p) =>
        new Promise<void>((resolve) =>
          p.signal.addEventListener("abort", () => {
            aborted.push("dialog");
            resolve();
          }),
        ),
    },
  };
  let remoteAnswered = false;
  const remote: Plugin = {
    on: {
      ask: async (p) => {
        await new Promise(setImmediate);
        remoteAnswered = true;
        p.resolve(["a", "b"]);
      },
    },
  };
  const agent = await createAgent({
    extra: [
      { name: "dialog", plugin: dialog },
      { name: "remote", plugin: remote },
    ],
  });
  assert.deepEqual(await agent.ctx.ask({ question: "which?", multi: true }), ["a", "b"]);
  assert.ok(remoteAnswered);
  assert.deepEqual(aborted, ["dialog"]);
});

test("aborting the run while an ask is pending resolves it undefined, and the tool finishes", async (t) => {
  t.after(await tempHome());
  let answer: Answered | "unset" = "unset";
  const asker = tool({
    name: "asker",
    description: "",
    inputSchema: z.object({}),
    execute: async (_, ctx) => {
      answer = await ctx.ask({ question: "go?" }, { detailed: true });
      return "finished";
    },
  });
  const controller = new AbortController();
  const rec = record();
  const agent = await createAgent({
    extra: [
      provider([{ toolCalls: [{ id: "1", name: "asker", input: {} }] }]),
      { name: "tools", plugin: { tools: [asker] } },
      // holds the ask open until it's dismissed
      {
        name: "ui",
        plugin: {
          on: {
            ask: (p) => {
              const dismissed = new Promise<void>((r) => p.signal.addEventListener("abort", () => r()));
              controller.abort();
              return dismissed;
            },
          },
        },
      },
      { name: "rec", plugin: rec },
    ],
  });
  const end = await agent.run("hi", { signal: controller.signal });
  assert.deepEqual(answer, { reason: "aborted" });
  assert.deepEqual(end?.aborted, { by: "user" });
  const result = rec.events.find((e) => e.name === "tool_result")?.payload as { result: { output: string } };
  assert.equal(result.result.output, "finished");
});

test("notify and status reach every plugin; ctx.exit closes through session_close('exit') and close", async (t) => {
  t.after(await tempHome());
  const rec = record();
  const agent = await createAgent({ extra: [{ name: "rec", plugin: rec }] });
  await agent.setSession(memorySession());
  await agent.ctx.notify("hello", "warn");
  await agent.ctx.status("k", "on");
  await agent.ctx.status("k");
  // the default exit is agent.close()
  agent.ctx.exit();
  await agent.close();
  const names = ["notify", "status", "session_close", "close"];
  const seen = rec.events.filter((e) => names.includes(e.name));
  assert.deepEqual(
    seen.map((e) => e.name),
    ["notify", "status", "status", "session_close", "close"],
  );
  assert.deepEqual(
    seen.slice(0, 3).map((e) => e.payload),
    [{ text: "hello", level: "warn" }, { key: "k", text: "on" }, { key: "k" }],
  );
  assert.equal((seen[3]?.payload as { reason: string } | undefined)?.reason, "exit");
  // a host with its own exit path gets it instead
  let exits = 0;
  const hosted = await createAgent({ onExit: () => exits++ });
  hosted.ctx.exit();
  assert.equal(exits, 1);
});

test("agent.commands() lists plugin commands bound to their plugin's host ctx; a later one replaces by name", async (t) => {
  t.after(await tempHome());
  const ctxs: Ctx[] = [];
  const sp = scripted([{ text: "done" }]);
  const cmd = (plugin: string): Plugin => ({
    commands: [
      {
        name: "hi",
        description: plugin,
        complete: () => [{ value: plugin }],
        run: async (arg, ctx) => {
          ctxs.push(ctx);
          const answer = await ctx.ask({ question: "send?" });
          await ctx.send(`${arg} ${answer}`, { deliver: "steer" });
          return `ran ${plugin}`;
        },
      },
    ],
  });
  const agent = await createAgent({
    extra: [
      { name: "scripted", plugin: { providers: { scripted: sp } } },
      { name: "a", plugin: cmd("a") },
      { name: "b", plugin: cmd("b") },
      { name: "yes", plugin: { on: { ask: (p) => p.resolve("yes") } } },
    ],
  });
  const session = memorySession();
  await agent.setSession(session);
  const commands = agent.commands().filter((c) => !c.plugin.startsWith("builtin:"));
  assert.deepEqual(
    commands.map((c) => [c.name, c.plugin, c.description]),
    [["hi", "b", "b"]],
  );
  assert.deepEqual(await commands[0]?.complete?.(), [{ value: "b" }]);
  assert.equal(await commands[0]?.run("x"), "ran b");
  assert.equal(ctxs[0]?.run, undefined);
  assert.equal(ctxs[0]?.session, session);
  // the steer started a run with the answer, sourced from the command's plugin
  await until(() => session.getState().messages.length === 2);
  assert.deepEqual(
    session.getState().messages.map((m) => (m.role === "user" ? m.content : m.role)),
    ["x yes", "assistant"],
  );
});

test("builtin:name's /name titles the current session, and shows the title without one", async (t) => {
  t.after(await tempHome());
  const agent = await createAgent();
  t.after(() => agent.close());
  const session = memorySession();
  await agent.setSession(session);
  const name = agent.commands().find((c) => c.name === "name");
  assert.equal(name?.plugin, "builtin:name");
  assert.equal(await name.run(""), "The session has no name");
  assert.equal(await name.run("  Bugfix "), "Session named Bugfix");
  assert.equal(session.getState().name, "Bugfix");
  assert.equal(await name.run(""), "Bugfix");
});

test("ctx.ask(req, { signal }) is withdrawn when the caller's signal aborts", async (t) => {
  t.after(await tempHome());
  let handlerSignal: AbortSignal | undefined;
  const agent = await createAgent({
    extra: [
      {
        name: "ui",
        plugin: {
          on: {
            ask: async (p) => {
              handlerSignal = p.signal;
              await new Promise((r) => p.signal.addEventListener("abort", r));
            },
          },
        },
      },
    ],
  });
  const controller = new AbortController();
  const pending = agent.ctx.ask({ question: "q?" }, { signal: controller.signal, detailed: true });
  controller.abort();
  assert.deepEqual(await pending, { reason: "aborted" });
  assert.equal(handlerSignal?.aborted, true);
});

test("ctx.trust asks once per path (kind trust), saves a Trust, keeps a refusal for the agent, and is false headless", async (t) => {
  t.after(await tempHome());
  const project = await mkdtemp(join(tmpdir(), "hortus-trust-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const asked: AskEvent[] = [];
  let answer: string | undefined = "Trust";
  const ui: Plugin = {
    on: {
      ask: (p) => {
        asked.push(p);
        p.resolve(answer);
      },
    },
  };
  // headless: nobody to ask
  const headless = await createAgent({ extra: [{ name: "ui", plugin: ui }] });
  assert.equal(await headless.ctx.trust(project), false);
  assert.equal(asked.length, 0);

  const host = { kind: "tui", interactive: true };
  const agent = await createAgent({ host, extra: [{ name: "ui", plugin: ui }] });
  // two plugins asking at once share one question
  const [a, b] = await Promise.all([agent.ctx.trust(project, { reason: "(mcp servers)" }), agent.ctx.trust(project)]);
  assert.deepEqual([a, b], [true, true]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.kind, "trust");
  assert.deepEqual(asked[0]?.data, { path: await realpath(project) });
  assert.match(asked[0]?.question ?? "", /\(mcp servers\)/);
  // saved: a subdirectory is trusted too, in a new agent, even headless
  await mkdir(join(project, "sub"));
  assert.equal(await headless.ctx.trust(join(project, "sub")), true);
  assert.deepEqual(JSON.parse(await readFile(join(hortusDir(), "trust.json"), "utf8")), {
    trusted: [await realpath(project)],
  });
  // a refusal holds for the agent, without asking again
  answer = "Not now";
  const other = await mkdtemp(join(tmpdir(), "hortus-trust-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  assert.equal(await agent.ctx.trust(other), false);
  assert.equal(await agent.ctx.trust(other), false);
  assert.equal(asked.length, 2);
});
