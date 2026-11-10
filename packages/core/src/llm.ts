import type { z } from "zod";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}
/** Base64 image; return `{ type: "image", ... }` from a tool's execute to send it to the model. */
export interface Image {
  type: "image";
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
  /** text sent along with the image, e.g. a codemode script's output */
  text?: string;
  /** where the image is on disk; a result's image without one is saved to a temp file */
  path?: string;
}
export interface ToolResult {
  id: string;
  output: string;
  image?: Image;
  isError?: boolean;
  /** for the host's renderer, never sent to the model: the last value the call passed to `ToolContext.update` */
  details?: unknown;
}

/** What a tool's `execute` gets besides its input. */
export interface ToolContext {
  /**
   * Reports progress to the host as a `tool_update` event (e.g. for a progress bar); never sent to the model. The last
   * value passed becomes the result's `details`, saved with it, so pass what the finished call's block should show last.
   */
  update(details: unknown): void;
}

/** Token counts of one completion; `input` includes `cacheRead` and `cacheWrite`. */
export interface Usage {
  input: number;
  output: number;
  /** read from the prompt cache */
  cacheRead: number;
  /** written to the prompt cache, which costs more than input; only where the provider reports it */
  cacheWrite?: number;
}

export type Message =
  | { role: "user"; content: string }
  // raw: provider-native content replayed as-is to the same provider (e.g. Anthropic thinking blocks)
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      raw?: { provider: string; content: unknown };
      usage?: Usage;
    }
  | { role: "tool"; results: ToolResult[] };

export type AssistantMessage = Extract<Message, { role: "assistant" }>;

export interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  execute: (input: never, ctx: ToolContext) => Promise<unknown>;
}

export const tool = <S extends z.ZodObject>(t: {
  name: string;
  description: string;
  inputSchema: S;
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}): Tool => t;

/** Thinking effort; "off" disables thinking. Unset means the provider's default. */
export const EFFORTS = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface CompletionRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: Tool[];
  effort?: Effort;
  /** aborts the stream; the provider rejects */
  signal?: AbortSignal;
}

export interface Provider {
  /** Streams one assistant turn, calling onText / onThinking for each text / reasoning delta. */
  complete(
    req: CompletionRequest,
    onText: (text: string) => void,
    onThinking: (text: string) => void,
  ): Promise<AssistantMessage>;
  /** Model ids usable as CompletionRequest.model. */
  listModels(): Promise<string[]>;
  /** Input context window of `model` in tokens, when the API reports it. */
  contextWindow?(model: string): Promise<number | undefined>;
  /** Efforts `model` accepts, when the API reports them; otherwise every one is offered. */
  efforts?(model: string): Promise<Effort[] | undefined>;
}

export interface ProviderDef {
  create: (secret: { apiKey: string; endpoint?: string }) => Provider;
}

/** An Agent Skills (agentskills.io) skill: the model is told its name and description, and reads `path` when it applies. */
export interface Skill {
  name: string;
  description: string;
  /** its SKILL.md; relative paths in it resolve against its directory */
  path: string;
}

/** Payload of each event; handlers may mutate it (e.g. push to `system`). */
export interface Events {
  /**
   * fired whenever the skills are listed (every run, and by hosts): builtin pushes those found on disk, later plugins may
   * push, remove or replace any; one per name, the last one wins
   */
  skills: { skills: Skill[] };
  /** fired at the start of every agent run, after `skills`; parts are joined into the system prompt */
  session_start: { system: string[]; skills: Skill[] };
  /** streamed assistant text delta */
  text: string;
  /** streamed reasoning delta, when the provider exposes it */
  thinking: string;
  tool_call: ToolCall;
  /** a running tool call's progress, from its `ToolContext.update`; not saved, except the last as the result's `details` */
  tool_update: { id: string; details: unknown };
  /** a new message to append to the history */
  message: Message;
}

export type Handlers = { [E in keyof Events]?: (payload: Events[E]) => void | Promise<void> };

/** Default export of a plugin's entrypoint (see `hortus.json` in plugins.ts). */
export interface Plugin {
  providers?: Record<string, ProviderDef>;
  tools?: Tool[];
  on?: Handlers;
}
