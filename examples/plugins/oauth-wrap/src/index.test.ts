import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgent, loadSecrets } from "@hortus/core";
import { tempHome } from "@hortus/core/testing";

const sse = (...events: object[]) =>
  new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

test("oauth-wrap refreshes an expired token inside fetch, saves it, and the real anthropic provider sends it", async (t) => {
  const login = {
    type: "anthropic",
    endpoint: "http://api.test",
    accessToken: "old",
    refreshToken: "r1",
    expires: 0,
    tokenUrl: "http://auth.test/token",
  };
  t.after(
    await tempHome({
      secrets: { claude: login },
      plugins: { "oauth-wrap": fileURLToPath(new URL("..", import.meta.url)) },
    }),
  );
  const refreshes: unknown[] = [];
  const sent: { url: string; authorization: string | null; apiKey: string | null }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (String(url) === login.tokenUrl) {
      refreshes.push(JSON.parse(String(init?.body)));
      return Response.json({ access_token: "new", refresh_token: "r2", expires_in: 3600 });
    }
    const headers = new Headers(init?.headers);
    sent.push({ url: String(url), authorization: headers.get("authorization"), apiKey: headers.get("x-api-key") });
    if (String(url).includes("/v1/models/")) return new Response("{}", { status: 404 });
    const usage = { input_tokens: 1, output_tokens: 1 };
    return sse(
      {
        type: "message_start",
        message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    );
  };
  const agent = await createAgent({ fetch });
  // what a run's provider gets, but from the expired entry, so the refresh happens inside its fetch
  const entry = (await loadSecrets()).claude;
  assert.ok(entry);
  const auth = (o?: { refresh?: boolean }) => agent.ctx.secrets.get("claude", o);
  const provider = agent.providers.anthropic?.create(entry, { name: "claude", fetch, auth });
  const reply = await provider?.complete({
    model: "m",
    system: "",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  });
  assert.equal(reply?.text, "hello");
  assert.deepEqual(refreshes, [{ grant_type: "refresh_token", refresh_token: "r1" }]);
  assert.ok(sent.some((s) => s.url === "http://api.test/v1/messages"));
  for (const s of sent) assert.deepEqual([s.authorization, s.apiKey], ["Bearer new", null]);
  const saved = (await loadSecrets()).claude;
  assert.deepEqual(
    { ...saved, expires: undefined },
    { ...login, accessToken: "new", refreshToken: "r2", expires: undefined },
  );
  assert.ok((saved?.expires as number) > Date.now());
  assert.equal((await stat(join(homedir(), ".hortus", "secrets.json"))).mode & 0o777, 0o600);
});
