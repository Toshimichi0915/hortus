import type { z } from "zod";

export type ToolCall = { id: string; name: string; input: unknown };
/** Base64 image; return `{ type: "image", ... }` from a tool's execute to send it to the model. */
export type Image = { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string };
export type ToolResult = { id: string; output: string; image?: Image; isError?: boolean };

export type Message =
  | { role: "user"; content: string }
  // raw: provider-native content replayed as-is to the same provider (e.g. Anthropic thinking blocks)
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: { provider: string; content: unknown } }
  | { role: "tool"; results: ToolResult[] };

export type AssistantMessage = Extract<Message, { role: "assistant" }>;

export type Tool = {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  execute: (input: never) => Promise<unknown>;
};

export const tool = <S extends z.ZodObject>(t: {
  name: string;
  description: string;
  inputSchema: S;
  execute: (input: z.infer<S>) => Promise<unknown>;
}): Tool => t;

export type CompletionRequest = { model: string; system: string; messages: Message[]; tools: Tool[] };

export interface Provider {
  /** Streams one assistant turn, calling onText / onThinking for each text / reasoning delta. */
  complete(
    req: CompletionRequest,
    onText: (text: string) => void,
    onThinking: (text: string) => void,
  ): Promise<AssistantMessage>;
  /** Model ids usable as CompletionRequest.model. */
  listModels(): Promise<string[]>;
}

export type ProviderDef = { create: (apiKey: string) => Provider; defaultModel: string };

/** Payload of each event; handlers may mutate it (e.g. push to `system`). */
export type Events = {
  /** fired at the start of every agent run; parts are joined into the system prompt */
  session_start: { system: string[] };
  /** streamed assistant text delta */
  text: string;
  /** streamed reasoning delta, when the provider exposes it */
  thinking: string;
  tool_call: ToolCall;
  /** a new message to append to the history */
  message: Message;
};

export type Handlers = { [E in keyof Events]?: (payload: Events[E]) => void | Promise<void> };

/** Default export of a plugin module listed in config.plugins. */
export type Plugin = { providers?: Record<string, ProviderDef>; tools?: Tool[]; on?: Handlers };
