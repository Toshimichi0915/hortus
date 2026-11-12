import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderApp, startCli } from "@hortus/cli/testing";
import { createAgent, hortusDir, type Message, openSession } from "@hortus/core";
import { record, scripted, tempDir, tempHome, until } from "@hortus/core/testing";
import { saved } from "./index.tsx";

/**
 * A fake language server: every line with BAD is an error ("bad: <line>"), with WARN a warning; `function <name>`
 * lines are symbols (to the next `}`); definition/references/hover/rename work on the word `foo`.
 */
const FAKE_LSP = `
const docs = new Map();
let buf = Buffer.alloc(0);
const send = (m) => { const b = JSON.stringify({ jsonrpc: "2.0", ...m }); process.stdout.write("Content-Length: " + Buffer.byteLength(b) + "\\r\\n\\r\\n" + b); };
const loc = (uri, line, ch = 0) => ({ uri, range: { start: { line, character: ch }, end: { line, character: ch + 3 } } });
const symbols = (uri) => { const lines = docs.get(uri).split("\\n"); const out = [];
  lines.forEach((l, i) => { const m = /function (\\w+)/.exec(l); if (!m) return; let end = i; while (end < lines.length - 1 && !lines[end].startsWith("}")) end++;
    out.push({ name: m[1], kind: 12, range: { start: { line: i, character: 0 }, end: { line: end, character: 1 } }, selectionRange: loc(uri, i).range }); });
  return out; };
const publish = (uri) => send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: docs.get(uri).split("\\n").flatMap((l, i) =>
  /BAD/.test(l) ? [{ range: loc(uri, i).range, severity: 1, source: "fake-ts", message: "bad: " + l.trim() }] :
  /WARN/.test(l) ? [{ range: loc(uri, i).range, severity: 2, source: "fake-ts", message: "warn: " + l.trim() }] : []) } });
const handle = (m) => {
  const p = m.params;
  switch (m.method) {
    case "initialize": return send({ id: m.id, result: { capabilities: {} } });
    case "shutdown": return send({ id: m.id, result: null });
    case "exit": return process.exit(0);
    case "textDocument/didOpen": docs.set(p.textDocument.uri, p.textDocument.text); return publish(p.textDocument.uri);
    case "textDocument/didChange": docs.set(p.textDocument.uri, p.contentChanges[0].text); return publish(p.textDocument.uri);
    case "textDocument/documentSymbol": return send({ id: m.id, result: symbols(p.textDocument.uri) });
    case "workspace/symbol": return send({ id: m.id, result: [...docs.keys()].flatMap((u) => symbols(u).filter((s) => s.name.includes(p.query)).map((s) => ({ name: s.name, kind: 12, location: { uri: u, range: s.range } }))) });
    case "textDocument/definition": { const u = p.textDocument.uri; const i = docs.get(u).split("\\n").findIndex((l) => l.includes("function foo")); return send({ id: m.id, result: loc(u, i, 9) }); }
    case "textDocument/references": { const u = p.textDocument.uri; return send({ id: m.id, result: docs.get(u).split("\\n").flatMap((l, i) => l.includes("foo") ? [loc(u, i, l.indexOf("foo"))] : []) }); }
    case "textDocument/hover": return send({ id: m.id, result: { contents: { kind: "markdown", value: "function foo(): number" } } });
    case "textDocument/rename": { const u = p.textDocument.uri; return send({ id: m.id, result: { changes: { [u]: docs.get(u).split("\\n").flatMap((l, i) => l.includes("foo") ? [{ range: loc(u, i, l.indexOf("foo")).range, newText: p.newName }] : []) } } }); }
    default: if (m.id !== undefined) send({ id: m.id, result: null });
  }
};
process.stdin.on("data", (d) => { buf = Buffer.concat([buf, d]);
  for (;;) { const e = buf.indexOf("\\r\\n\\r\\n"); if (e < 0) return; const n = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, e).toString())[1]);
    if (buf.length < e + 4 + n) return; const m = JSON.parse(buf.subarray(e + 4, e + 4 + n).toString()); buf = buf.subarray(e + 4 + n); handle(m); } });
`;
/** a fake linter: `<file>:<n>:1: warning: lint: …` for each line with LINT */
const FAKE_LINT = `
const f = process.argv[2]; require("node:fs").readFileSync(f, "utf8").split("\\n").forEach((l, i) => { if (l.includes("LINT")) console.log(f + ":" + (i + 1) + ":1: warning: lint: " + l.trim()); });
`;
/** a fake formatter: collapses ";;" */
const FAKE_FMT = `
const fs = require("node:fs"); const f = process.argv[2]; fs.writeFileSync(f, fs.readFileSync(f, "utf8").replaceAll(";;", ";"));
`;
/** a fake ast-grep: one match per line containing the pattern's head */
const FAKE_SG = `
const a = process.argv.slice(2); const pat = a[a.indexOf("--pattern") + 1].split("(")[0]; const rw = a.includes("--rewrite") ? a[a.indexOf("--rewrite") + 1] : undefined;
const fs = require("node:fs"); const out = [];
for (const f of fs.readdirSync(".").filter((f) => f.endsWith(".ts"))) fs.readFileSync(f, "utf8").split("\\n").forEach((l, i) => { if (l.includes(pat)) out.push({ file: f, text: l.trim(), range: { start: { line: i, column: l.indexOf(pat) } }, ...(rw ? { replacement: rw } : {}) }); });
if (a.includes("--update-all")) for (const m of out) fs.writeFileSync(m.file, fs.readFileSync(m.file, "utf8").replaceAll(m.text, rw));
console.log(JSON.stringify(out));
`;

async function setup(t: Parameters<typeof tempDir>[0], config: Record<string, unknown> = {}) {
  t.after(await tempHome({ plugins: { lens: fileURLToPath(new URL("..", import.meta.url)) } }));
  const bin = await tempDir(t, "lens-bin-");
  const exe = async (name: string, src: string) => {
    const p = join(bin, name);
    await writeFile(p, `#!${process.execPath}\n${src}`);
    await chmod(p, 0o755);
    return p;
  };
  const cfg = {
    lsp: { waitMs: 2000, servers: { typescript: { command: await exe("fake-lsp", FAKE_LSP), extensions: [".ts"] } } },
    runners: { fakelint: { command: await exe("fake-lint", FAKE_LINT), extensions: [".ts"] } },
    formatters: { fakefmt: { command: await exe("fake-fmt", FAKE_FMT), extensions: [".ts"], severity: "info" } },
    astGrep: { command: await exe("fake-sg", FAKE_SG) },
    turnSummary: { enabled: true },
    ...config,
  };
  await mkdir(hortusDir(), { recursive: true });
  await writeFile(join(hortusDir(), "lens.json"), JSON.stringify(cfg));
  const cwd = await tempDir(t, "lens-proj-");
  return { cwd, file: join(cwd, "a.ts") };
}

const call = (id: string, name: string, input: unknown) => ({ toolCalls: [{ id, name, input }] });
const outputs = (messages: readonly Message[]) =>
  messages.flatMap((m) => (m.role === "tool" ? m.results.map((r) => r.output) : []));
const lastUser = (msgs: readonly Message[]) => [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";

test("lens: read guard, delta errors in the result, warnings and deferred formats in the next request, turn summary, status", async (t) => {
  const { cwd, file } = await setup(t);
  await writeFile(file, "export function foo() {\n  return 1;\n}\nconst x = BAD_OLD;\n");
  const provider = scripted([
    call("1", "edit", { path: "a.ts", edits: [{ oldText: "return 1;", newText: "return 2;" }] }),
    call("2", "read", { path: "a.ts" }),
    call("3", "edit", { path: "a.ts", edits: [{ oldText: "return 1;", newText: "return BAD_NEW;;\n  // LINT WARN" }] }),
    { text: "done" },
    { text: "ok" },
  ]);
  const rec = record();
  const agent = await createAgent({
    extra: [
      { name: "scripted", plugin: { providers: { scripted: provider } } },
      { name: "rec", plugin: rec },
    ],
  });
  t.after(() => agent.close());
  const session = await openSession(null);
  await agent.setSession(session);
  await agent.run("fix a.ts", { cwd });

  const out = outputs(session.getState().messages);
  assert.match(out[0] ?? "", /Blocked by lens: pi-lens read guard: read a\.ts before editing it/);
  // only the error the edit introduced; the old one is the baseline
  assert.match(
    out[2] ?? "",
    /🔴 pi-lens: 1 error\(s\) in a\.ts[\s\S]*a\.ts:2:1 error: bad: return BAD_NEW;; \[fake-ts\]\n\(1 pre-existing not shown\)$/,
  );
  assert.doesNotMatch(out[2] ?? "", /BAD_OLD/);
  // warnings (the linter's and the server's) reach the model with its next request, once
  const warned = lastUser(provider.requests[3]?.messages ?? []);
  assert.match(
    warned,
    /pi-lens warnings in files you changed:\n {2}a\.ts:3:1 warning: lint: \/\/ LINT WARN \[fakelint\]\n {2}a\.ts:3:1 warning: warn: \/\/ LINT WARN \[fake-ts\]$/,
  );
  // deferred format ran at the run's end; the turn summary is a displayed plugin message
  assert.equal(
    await readFile(file, "utf8"),
    "export function foo() {\n  return BAD_NEW;\n  // LINT WARN\n}\nconst x = BAD_OLD;\n",
  );
  const summary = session.getState().messages.at(-1);
  assert.equal(summary?.role, "user");
  assert.deepEqual(summary?.role === "user" && summary.meta && { ...summary.meta, details: undefined }, {
    plugin: "lens",
    type: "turn-summary",
    details: undefined,
    display: true,
  });
  assert.match(summary?.role === "user" ? summary.content : "", /^pi-lens: 4 diagnostics · 1 reformatted$/);
  // the LSP state is a status, active servers in green
  const statuses = rec.events
    .filter((e) => e.name === "status")
    .map((e) => e.payload as { text?: string; color?: string });
  assert.ok(
    statuses.some((p) => p.text === "LSP Active: typescript" && p.color === "green"),
    JSON.stringify(statuses),
  );
  // the next run hears about the format
  await agent.run("next", { cwd });
  assert.match(
    JSON.stringify(provider.requests[4]?.messages),
    /pi-lens formatted after your last turn: a\.ts\. Re-read before editing them\./,
  );
  const health = await agent
    .commands()
    .find((c) => c.name === "lens-health")
    ?.run("");
  assert.match(health ?? "", /Checks run: 2[\s\S]*Unresolved errors: 2[\s\S]*✓ typescript/);
});

test("lens: situational tools activate per session and survive a resume; LSP navigation, ast-grep, marks and the git guard", async (t) => {
  const { cwd, file } = await setup(t, { guard: { enabled: true }, format: { enabled: false } });
  await writeFile(file, "export function foo() {\n  return 1;\n}\nconst y = foo();\n");
  const provider = scripted([
    call("1", "lsp_navigation", { operation: "definition", path: "a.ts", line: 4, character: 11 }),
    call("2", "pi_lens_activate_tools", { tools: ["lsp_navigation", "ast_grep_replace", "lens_diagnostic_mark"] }),
    call("3", "lsp_navigation", { operation: "definition", path: "a.ts", line: 4, character: 11 }),
    call("4", "lsp_navigation", { operation: "references", path: "a.ts", line: 1, character: 17 }),
    call("5", "read_symbol", { path: "a.ts", symbol: "foo" }),
    call("6", "lsp_navigation", { operation: "hover", path: "a.ts", line: 1, character: 17 }),
    call("7", "symbol_search", { query: "fo", path: "a.ts" }),
    call("8", "ast_grep_replace", { pattern: "y = foo()", rewrite: "y = bar()", apply: false }),
    call("9", "read", { path: "a.ts" }),
    call("10", "write", { path: "a.ts", content: "export function foo() {\n  return BAD;\n}\n" }),
    call("11", "bash", { command: "git commit -m wip" }),
    call("12", "lens_diagnostic_mark", { path: "a.ts", match: "BAD", disposition: "false-positive" }),
    call("13", "lens_diagnostics", {}),
    call("14", "lsp_navigation", { operation: "rename", path: "a.ts", line: 1, character: 17, newName: "baz" }),
    { text: "done" },
    { text: "resumed" },
  ]);
  const agent = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  t.after(() => agent.close());
  const session = await openSession(null);
  await agent.setSession(session);
  const declared = (i: number) => provider.requests[i]?.tools?.map((x) => x.name) ?? [];
  await agent.run("navigate", { cwd });

  assert.ok(!declared(0).includes("lsp_navigation") && declared(0).includes("pi_lens_activate_tools"));
  assert.match(provider.requests[0]?.system ?? "", /Situational tools[\s\S]*- lsp_navigation: IDE-style/);
  assert.ok(declared(2).includes("lsp_navigation") && declared(2).includes("ast_grep_replace"));
  assert.ok(!declared(2).includes("ast_grep_search"));
  const out = outputs(session.getState().messages);
  assert.match(out[0] ?? "", /Unknown tool/);
  assert.equal(
    out[1],
    "Activated: lsp_navigation, ast_grep_replace, lens_diagnostic_mark. Available starting next turn.",
  );
  assert.equal(out[2], "a.ts:1:10");
  assert.equal(out[3], "a.ts:1:17\na.ts:4:11");
  assert.equal(out[4], "1\texport function foo() {\n2\t  return 1;\n3\t}");
  assert.equal(out[5], "function foo(): number");
  assert.equal(out[6], "foo a.ts:1:1");
  assert.match(out[7] ?? "", /^Would apply 1 rewrite\(s\):\na\.ts:4:7: const y = foo\(\);\n {4}→ y = bar\(\)$/);
  assert.match(out[9] ?? "", /🔴 pi-lens: 1 error\(s\)/);
  assert.match(out[10] ?? "", /Blocked by lens: pi-lens guard: 1 unresolved error\(s\)/);
  assert.equal(out[12], "No diagnostics");
  assert.equal(out[13], "Renamed in a.ts");
  assert.equal(await readFile(file, "utf8"), "export function baz() {\n  return BAD;\n}\n");
  assert.deepEqual(saved(session.getState()).active, ["lsp_navigation", "ast_grep_replace", "lens_diagnostic_mark"]);

  // resumed (a new agent): the marks and the activated tools come back from the session's entries
  const agent2 = await createAgent({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  t.after(() => agent2.close());
  const resumed = await openSession(session.leafId);
  await agent2.setSession(resumed, "resume");
  assert.equal(saved(resumed.getState()).marks[0]?.disposition, "false-positive");
  await agent2.run("again", { cwd });
  assert.ok(declared(15).includes("lsp_navigation"));
  const tools = await agent2
    .commands()
    .find((c) => c.name === "lens-tools")
    ?.run("");
  assert.match(tools ?? "", /✓ typescript \(lsp: [^)]*fake-lsp\)/);
});

test("lens: the TUI shows the findings panel and the turn summary line", async (t) => {
  const { cwd, file } = await setup(t);
  await writeFile(file, "const a = 1;\n");
  const provider = scripted([call("1", "write", { path: file, content: "const a = BAD;\n" }), { text: "written" }]);
  const cli = await startCli({ extra: [{ name: "scripted", plugin: { providers: { scripted: provider } } }] });
  t.after(() => cli.close());
  await cli.ui.getState().session.setCwd(cwd);
  const ui = renderApp(cli, { columns: 80, rows: 24 });
  t.after(() => ui.app.unmount());
  await until(() => ui.screen().includes("╭"));
  // a new file needs no read; an existing one does: allow this one edit
  assert.match(
    (await cli.agent
      .commands()
      .find((c) => c.name === "lens-allow-edit")
      ?.run(file)) ?? "",
    /armed/,
  );
  cli.submit("write it");
  await until(() => /lens · 1 error\(s\) · 0 warning\(s\)\n.*a\.ts {2}1E 0W/.test(ui.screen()), 8000);
  await until(() => ui.screen().includes("pi-lens: 1 diagnostic"), 8000);
  assert.match(ui.screen(), /LSP Active: typescript/);
});
