import type { z } from "zod";

export type ToolCall = { id: string; name: string; input: unknown };
export type ToolResult = { id: string; output: string; isError?: boolean };

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
  /** Streams one assistant turn, calling onText for each text delta. */
  complete(req: CompletionRequest, onText: (text: string) => void): Promise<AssistantMessage>;
  /** Model ids usable as CompletionRequest.model. */
  listModels(): Promise<string[]>;
}
