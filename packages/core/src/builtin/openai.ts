import {
  type CreateOptions,
  openaiProvider,
  openaiResponsesProvider,
  type Piece,
  type Secret,
  version,
} from "../index.ts";

// explicit values (null = none) for every option the SDK would otherwise read from the environment; a keyless entry
// (a local server) gets a placeholder key, which the SDK requires, and no authorization header
const options = ({ apiKey, endpoint }: Secret, { headers, fetch }: CreateOptions) => ({
  apiKey: apiKey || "none",
  defaultHeaders: apiKey ? headers : { authorization: null, ...headers },
  baseURL: endpoint ?? null,
  organization: null,
  project: null,
  adminAPIKey: null,
  fetch,
});

export default {
  name: "builtin:openai",
  version,
  plugin: {
    providers: {
      openai: { create: (entry, ctx) => openaiProvider(options(entry, ctx)) },
      "openai-responses": { create: (entry, ctx) => openaiResponsesProvider(options(entry, ctx)) },
    },
  },
} satisfies Piece;
