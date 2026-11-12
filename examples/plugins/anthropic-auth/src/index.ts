import type { Plugin, ProviderDef, Secret } from "@hortus/core";

const OAUTH_BETA = "oauth-2025-04-20";
/** refreshed this long before it expires, so a request never goes out with a token about to lapse */
const MARGIN = 5 * 60_000;

/** An anthropic secrets.json entry logged in with OAuth: loose fields next to `type`, no `apiKey`. */
interface Login extends Secret {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expires: number;
  tokenUrl: string;
  clientId: string;
}

const isLogin = (e: Secret): e is Login => typeof e.refreshToken === "string";

/** The entry's OAuth bearer token: its login's, or an `sk-ant-oat` token stored as `apiKey`; else it's an API key. */
const tokenOf = (e: Secret) => (isLogin(e) ? e.accessToken : e.apiKey?.includes("sk-ant-oat") ? e.apiKey : undefined);

/** `entry` with a fresh access token if it (nearly) expired, or `force`. */
async function fresh(entry: Secret, fetch: typeof globalThis.fetch, force = false): Promise<Secret> {
  if (!isLogin(entry) || (!force && entry.expires > Date.now())) return entry;
  const res = await fetch(entry.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: entry.refreshToken, client_id: entry.clientId }),
  });
  if (!res.ok) throw new Error(`Anthropic OAuth refresh failed: ${res.status} ${await res.text()}`);
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  return {
    ...entry,
    accessToken: t.access_token,
    // rotated: the old one stops working, which is why it's saved under secrets.json's lock
    refreshToken: t.refresh_token ?? entry.refreshToken,
    expires: Date.now() + t.expires_in * 1000 - MARGIN,
  };
}

type Fields = Record<string, string | boolean | undefined>;

/** One line about the account behind `entry`'s OAuth login, from Anthropic's (undocumented) profile endpoint. */
async function account(entry: Secret, identity: boolean, fetch: typeof globalThis.fetch): Promise<string> {
  const token = tokenOf(entry);
  if (!token) return "no OAuth login";
  const res = await fetch(`${entry.endpoint ?? "https://api.anthropic.com"}/api/oauth/profile`, {
    headers: { authorization: `Bearer ${token}`, "anthropic-beta": OAUTH_BETA },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return `unavailable (HTTP ${res.status})`;
  const { account: a = {}, organization: o = {} } = (await res.json()) as { account?: Fields; organization?: Fields };
  const extra = o.has_extra_usage_enabled;
  const parts = [
    // identifying (a personal organization is named after its email), so only on request
    identity && [a.email, o.name && `(${o.name})`].filter(Boolean).join(" "),
    o.organization_type,
    o.seat_tier && `seat ${o.seat_tier}`,
    o.rate_limit_tier && `rate limit ${o.rate_limit_tier}`,
    o.subscription_status && `subscription ${o.subscription_status}`,
    typeof extra === "boolean" && `extra usage ${extra ? "on" : "off"}`,
  ].filter(Boolean);
  return parts.join(", ") || "no plan details";
}

/**
 * Wraps `anthropic` so an entry holding an OAuth token (a login's, or an `sk-ant-oat` token as `apiKey`) authenticates
 * with it as a bearer token and the OAuth beta header, refreshing (and saving) it once it expires; API-key entries pass
 * through untouched. `/anthropic-auth:status` shows the account behind each anthropic entry.
 */
export default {
  providers: {
    anthropic: {
      wrap: (Default): ProviderDef => ({
        ...Default,
        auth: async (entry, opts) =>
          isLogin(entry) ? fresh(entry, opts.fetch, opts.refresh) : ((await Default.auth?.(entry, opts)) ?? entry),
        create(entry, opts) {
          const token = tokenOf(entry);
          if (!token) return Default.create(entry, opts);
          const base = opts.fetch ?? globalThis.fetch;
          let current: Secret = entry;
          return Default.create(
            { ...entry, apiKey: undefined },
            {
              ...opts,
              // the SDK wants a credential before it calls fetch, which then sets the current one
              headers: { ...opts.headers, authorization: `Bearer ${token}` },
              fetch: async (url, init) => {
                // a run outlives a token: hortus re-reads it under the lock (another process may have refreshed and
                // rotated it) and passes it through `auth` above
                if (isLogin(current) && current.expires <= Date.now()) current = (await opts.auth?.()) ?? current;
                const headers = new Headers(init?.headers);
                headers.set("authorization", `Bearer ${tokenOf(current)}`);
                headers.delete("x-api-key");
                const beta = headers.get("anthropic-beta");
                headers.set("anthropic-beta", beta ? `${beta},${OAUTH_BETA}` : OAUTH_BETA);
                return base(url, { ...init, headers });
              },
            },
          );
        },
      }),
    },
  },
  commands: [
    {
      name: "anthropic-auth:status",
      args: "[--account]",
      description: "Show the Anthropic account behind each anthropic login (--account adds email and organization)",
      complete: () => [{ value: "--account", description: "Also show each account's email and organization name" }],
      run: async (arg, ctx) => {
        const identity = arg.split(/\s+/).includes("--account");
        const { secrets, fetch } = ctx;
        const lines = await Promise.all(
          (await secrets.find("anthropic")).map(async ({ name }) => {
            try {
              // through auth, so an expired login is refreshed first
              const entry = await secrets.get(name);
              return `  ${name}: ${entry ? await account(entry, identity, fetch) : "no entry"}`;
            } catch (e) {
              return `  ${name}: unavailable (${e instanceof Error ? e.message : String(e)})`;
            }
          }),
        );
        return ["anthropic accounts:", ...lines].join("\n");
      },
    },
  ],
} satisfies Plugin;
