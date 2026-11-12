import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "@hortus/cli";
import { createAgent, loadSecrets, type Message } from "@hortus/core";
import { tempHome } from "@hortus/core/testing";

const sse = (...events: object[]) =>
  new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

const reply = () =>
  sse(
    {
      type: "message_start",
      message: {
        id: "m",
        type: "message",
        role: "assistant",
        model: "m",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  );

test("anthropic-auth refreshes an OAuth login, sends it as a bearer token, and reports the account", async (t) => {
  const login = {
    type: "anthropic",
    endpoint: "http://api.test",
    accessToken: "sk-ant-oat01-old",
    refreshToken: "r1",
    expires: 0,
    tokenUrl: "http://auth.test/token",
    clientId: "cid",
  };
  t.after(
    await tempHome({
      config: { provider: "claude", model: "m" },
      secrets: {
        claude: login,
        key: { type: "anthropic", endpoint: "http://api.test", apiKey: "sk-ant-api03-key" },
        pasted: { type: "anthropic", endpoint: "http://api.test", apiKey: "sk-ant-oat01-pasted" },
      },
      plugins: { "anthropic-auth": fileURLToPath(new URL("..", import.meta.url)) },
    }),
  );
  const refreshes: unknown[] = [];
  const sent: { url: string; authorization: string | null; apiKey: string | null; beta: string | null }[] = [];
  // the SDK, `auth` and the status command all use the agent's fetch
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (String(url) === login.tokenUrl) {
      refreshes.push(JSON.parse(String(init?.body)));
      return Response.json({ access_token: "sk-ant-oat01-new", refresh_token: "r2", expires_in: 3600 });
    }
    const h = new Headers(init?.headers);
    const s = {
      url: String(url),
      authorization: h.get("authorization"),
      apiKey: h.get("x-api-key"),
      beta: h.get("anthropic-beta"),
    };
    sent.push(s);
    if (s.url.endsWith("/api/oauth/profile"))
      return s.authorization === "Bearer sk-ant-oat01-new"
        ? Response.json({
            account: { email: "a@example.com" },
            organization: { name: "Org", organization_type: "claude_max", has_extra_usage_enabled: false },
          })
        : new Response("", { status: 401 });
    if (s.url.includes("/v1/models/")) return new Response("{}", { status: 404 });
    return reply();
  };

  const messages: Message[] = [];
  const observer = { name: "observer", plugin: { on: { message: (m: Message) => void messages.push(m) } } };
  const agent = await createAgent({ provided: { "@hortus/cli": version }, extra: [observer], fetch });
  await agent.run("hi");
  assert.equal((messages.at(-1) as Extract<Message, { role: "assistant" }>).text, "hello");
  // refreshed once, by `auth` when the run resolved the provider, and saved with the rotated refresh token
  assert.deepEqual(refreshes, [{ grant_type: "refresh_token", refresh_token: "r1", client_id: "cid" }]);
  const saved = (await loadSecrets()).claude;
  assert.deepEqual(
    { ...saved, expires: 0 },
    { ...login, accessToken: "sk-ant-oat01-new", refreshToken: "r2", expires: 0 },
  );
  assert.ok((saved?.expires as number) > Date.now());
  assert.ok(sent.some((s) => s.url === "http://api.test/v1/messages"));
  for (const s of sent) assert.deepEqual([s.authorization, s.apiKey], ["Bearer sk-ant-oat01-new", null]);
  for (const s of sent) assert.match(s.beta ?? "", /oauth-2025-04-20/);

  // a provider created from an expired copy re-reads the entry through opts.auth: already refreshed, so no second refresh
  const complete = (name: string, entry: object) =>
    agent.providers.anthropic
      ?.create({ type: "anthropic", ...entry }, { name, fetch, auth: (o) => agent.ctx.secrets.get(name, o) })
      .complete({ model: "m", system: "", messages: [{ role: "user", content: "hi" }], tools: [] });
  sent.length = 0;
  await complete("claude", login);
  assert.equal(refreshes.length, 1);
  assert.equal(sent.at(-1)?.authorization, "Bearer sk-ant-oat01-new");
  // an sk-ant-oat token stored as apiKey is an OAuth token too; an API key passes through untouched
  await complete("pasted", { endpoint: "http://api.test", apiKey: "sk-ant-oat01-pasted" });
  assert.deepEqual([sent.at(-1)?.authorization, sent.at(-1)?.apiKey], ["Bearer sk-ant-oat01-pasted", null]);
  await complete("key", { endpoint: "http://api.test", apiKey: "sk-ant-api03-key" });
  const plain = sent.at(-1);
  // (this SDK sends an API key as a bearer token too; what tells them apart is the OAuth beta)
  assert.deepEqual([plain?.authorization, plain?.beta], ["Bearer sk-ant-api03-key", null]);

  const status = agent.commands().find((c) => c.name === "anthropic-auth:status");
  assert.equal(
    await status?.run(""),
    [
      "anthropic accounts:",
      "  claude: claude_max, extra usage off",
      "  key: no OAuth login",
      "  pasted: unavailable (HTTP 401)",
    ].join("\n"),
  );
  assert.match(String(await status?.run("--account")), /claude: a@example\.com \(Org\), claude_max/);
});
