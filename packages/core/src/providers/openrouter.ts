import type OpenAI from "openai";
import type { Provider } from "../llm.ts";
import { openaiProvider } from "./openai.ts";

// OpenRouter is OpenAI-compatible
export function openrouterProvider(options?: ConstructorParameters<typeof OpenAI>[0]): Provider {
  return openaiProvider({ baseURL: "https://openrouter.ai/api/v1", ...options });
}
