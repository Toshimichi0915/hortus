import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AssistantMessage, CompletionRequest, Message, Provider } from "../llm.ts";

// Anthropic only accepts [a-zA-Z0-9_-] ids; other providers' ids (e.g. "functions.bash:0") are mapped deterministically
const toolId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

function toAnthropic(m: Message): Anthropic.MessageParam[] {
  switch (m.role) {
    case "user":
      return [m];
    case "assistant": {
      if (m.raw?.provider === "anthropic")
        return [{ role: "assistant", content: m.raw.content as Anthropic.ContentBlockParam[] }];
      const content: Anthropic.ContentBlockParam[] = [
        ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
        ...m.toolCalls.map((c) => ({
          type: "tool_use" as const,
          id: toolId(c.id),
          name: c.name,
          // unparseable arguments from another provider; the tool result already reports the error
          input: typeof c.input === "object" && c.input !== null ? c.input : {},
        })),
      ];
      // empty assistant turns (possible from other providers) are rejected by the API
      return content.length ? [{ role: "assistant", content }] : [];
    }
    case "tool":
      return [
        {
          role: "user",
          content: m.results.map((r) => ({
            type: "tool_result",
            tool_use_id: toolId(r.id),
            content: r.output,
            is_error: r.isError,
          })),
        },
      ];
  }
}

export function anthropicProvider(options?: ConstructorParameters<typeof Anthropic>[0]): Provider {
  const client = new Anthropic(options);
  return {
    async listModels() {
      const ids: string[] = [];
      for await (const m of client.models.list()) ids.push(m.id);
      return ids;
    },
    async complete(
      { model, system, messages, tools }: CompletionRequest,
      onText,
      onThinking,
    ): Promise<AssistantMessage> {
      const stream = client.messages.stream({
        model,
        max_tokens: 64000,
        // ponytail: adaptive only, pre-4.6 models (e.g. Haiku 4.5) reject it; pick per model if they matter
        thinking: { type: "adaptive", display: "summarized" },
        system,
        messages: messages.flatMap(toAnthropic),
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: z.toJSONSchema(t.inputSchema) as Anthropic.Tool.InputSchema,
        })),
      });
      for await (const event of stream) {
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta") onText(event.delta.text);
        else if (event.delta.type === "thinking_delta") onThinking(event.delta.thinking);
      }
      const message = await stream.finalMessage();
      const toolCalls = message.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [],
      );
      if (message.stop_reason === "max_tokens" && toolCalls.length)
        throw new Error("Tool input truncated by max_tokens");
      if (message.stop_reason === "refusal")
        throw new Error(`Model refused: ${message.stop_details?.explanation ?? "no details"}`);
      return {
        role: "assistant",
        text: message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
        toolCalls,
        raw: { provider: "anthropic", content: message.content },
      };
    },
  };
}
