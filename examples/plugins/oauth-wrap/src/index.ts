import type { Plugin, ProviderDef, Secret } from "@hortus/core";

/** A secrets.json entry logged in with OAuth: loose fields next to `type`, no `apiKey`. */
interface OAuth extends Secret {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expires: number;
  tokenUrl: string;
}

const isOAuth = (e: Secret): e is OAuth => typeof e.refreshToken === "string";

/** `entry` with a fresh access token if it expired (or `force`), from its token endpoint. */
async function fresh(entry: Secret, fetch: typeof globalThis.fetch, force = false): Promise<Secret> {
  if (!isOAuth(entry) || (!force && entry.expires > Date.now())) return entry;
  const res = await fetch(entry.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: entry.refreshToken }),
  });
  if (!res.ok) throw new Error(`OAuth refresh failed: ${res.status} ${await res.text()}`);
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  return {
    ...entry,
    accessToken: t.access_token,
    // rotated: the old one stops working, which is why it's saved under secrets.json's lock
    refreshToken: t.refresh_token ?? entry.refreshToken,
    expires: Date.now() + t.expires_in * 1000,
  };
}

/**
 * Wraps `anthropic` so an entry with OAuth tokens authenticates with a bearer token instead of an API key. The token is
 * set on every request in `fetch`, which first refreshes it once it expires (long runs outlive a token) through
 * `opts.auth`: hortus's one refresh path, which calls `auth` below under the secrets.json lock and saves the result.
 */
export default {
  providers: {
    anthropic: {
      wrap: (Default): ProviderDef => ({
        ...Default,
        auth: (entry, opts) =>
          isOAuth(entry)
            ? fresh(entry, opts.fetch, opts.refresh)
            : (Default.auth?.(entry, opts) ?? Promise.resolve(entry)),
        create(entry, opts) {
          if (!isOAuth(entry)) return Default.create(entry, opts);
          const base = opts.fetch ?? globalThis.fetch;
          let current: Secret = entry;
          return Default.create(
            { ...entry, apiKey: undefined },
            {
              ...opts,
              // the SDK wants a credential before it calls fetch, which then sets the current one
              headers: { ...opts.headers, authorization: `Bearer ${entry.accessToken}` },
              fetch: async (url, init) => {
                // re-read under the lock: another process may have refreshed (and rotated) it already
                if (isOAuth(current) && current.expires <= Date.now()) current = (await opts.auth?.()) ?? current;
                const headers = new Headers(init?.headers);
                headers.set("authorization", `Bearer ${(current as OAuth).accessToken}`);
                return base(url, { ...init, headers });
              },
            },
          );
        },
      }),
    },
  },
} satisfies Plugin;
