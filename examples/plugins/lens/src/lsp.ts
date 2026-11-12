import { type ChildProcess, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/** An LSP diagnostic, as `textDocument/publishDiagnostics` sends it (0-based positions; severity 1 error … 4 hint). */
export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

/**
 * A minimal LSP client over stdio (JSON-RPC with `Content-Length` framing): initialize, open/change documents, wait for
 * their published diagnostics, and plain requests for navigation. ponytail: no incremental sync, no server-initiated
 * requests beyond answering them empty (workspace/configuration and the like); add them when a server needs them.
 */
export class LspClient {
  private proc: ChildProcess;
  private buf = Buffer.alloc(0);
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private versions = new Map<string, number>();
  private waiters = new Map<string, (() => void)[]>();
  readonly diagnostics = new Map<string, LspDiagnostic[]>();
  alive = true;
  ready: Promise<unknown>;

  constructor(
    readonly id: string,
    command: string,
    args: string[],
    readonly root: string,
  ) {
    this.proc = spawn(command, args, { cwd: root, stdio: ["pipe", "pipe", "ignore"] });
    this.proc.on("error", (e) => this.fail(e));
    this.proc.on("exit", () => this.fail(new Error(`${id} exited`)));
    this.proc.stdout?.on("data", (d: Buffer) => this.read(d));
    this.ready = this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: root }],
      capabilities: {
        textDocument: { publishDiagnostics: {}, synchronization: {}, hover: {}, definition: {}, references: {} },
      },
    }).then(() => this.notify("initialized", {}));
  }

  private fail(e: Error) {
    this.alive = false;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private read(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const end = this.buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(this.buf.subarray(0, end).toString())?.[1]);
      if (this.buf.length < end + 4 + len) return;
      const msg = JSON.parse(this.buf.subarray(end + 4, end + 4 + len).toString());
      this.buf = this.buf.subarray(end + 4 + len);
      this.handle(msg);
    }
  }

  private handle(msg: {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { message: string };
  }) {
    if (msg.method === "textDocument/publishDiagnostics") {
      const { uri, diagnostics } = msg.params as { uri: string; diagnostics: LspDiagnostic[] };
      this.diagnostics.set(uri, diagnostics);
      for (const w of this.waiters.get(uri) ?? []) w();
      this.waiters.delete(uri);
    } else if (msg.method !== undefined && msg.id !== undefined) {
      this.write({ jsonrpc: "2.0", id: msg.id, result: null });
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
    }
  }

  private write(msg: unknown) {
    const body = JSON.stringify(msg);
    this.proc.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error(`${this.id} is not running`));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Opens (or replaces the text of) `path`, so position requests on it see `text`. */
  async sync(path: string, text: string, languageId: string) {
    await this.ready;
    const uri = pathToFileURL(path).href;
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    if (version === 1) this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
    else this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    return uri;
  }

  /** Syncs `text` and resolves with the diagnostics the server publishes next (the last known ones after `waitMs`). */
  async check(path: string, text: string, languageId: string, waitMs: number): Promise<LspDiagnostic[]> {
    await this.ready;
    const uri = pathToFileURL(path).href;
    const published = new Promise<void>((resolve) => {
      this.waiters.set(uri, [...(this.waiters.get(uri) ?? []), resolve]);
      setTimeout(resolve, waitMs).unref();
    });
    await this.sync(path, text, languageId);
    await published;
    return this.diagnostics.get(uri) ?? [];
  }

  async stop() {
    if (!this.alive) return;
    await Promise.race([this.request("shutdown", null).catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
    this.notify("exit", null);
    this.alive = false;
    this.proc.kill();
  }
}
