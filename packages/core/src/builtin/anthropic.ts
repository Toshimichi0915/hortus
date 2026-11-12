import { anthropicProvider, type Piece, version } from "../index.ts";

export default {
  name: "builtin:anthropic",
  version,
  plugin: {
    providers: {
      anthropic: {
        // explicit values for what the SDK would otherwise read from the environment (null = none, default base); a
        // keyless entry gets a placeholder key and no authorization header, as no key would mean the SDK's credential
        // chain (ANTHROPIC_PROFILE, config files, which may also set the base URL)
        create: ({ apiKey, endpoint }, { headers, fetch }) =>
          anthropicProvider({
            apiKey: apiKey || "none",
            authToken: null,
            baseURL: endpoint ?? null,
            defaultHeaders: apiKey ? headers : { authorization: null, ...headers },
            fetch,
          }),
      },
    },
  },
} satisfies Piece;
