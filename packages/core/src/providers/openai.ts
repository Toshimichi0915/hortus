import OpenAI from "openai";
import { z } from "zod";
import type { AssistantMessage, CompletionRequest, Message, Provider } from "../llm.ts";

function toOpenAI(m: Message): OpenAI.ChatCompletionMessageParam[] {
  switch (m.role) {
    case "user":
      return [m];
    case "assistant":
      return [
        {
          role: "assistant",
          content: m.text || null,
          tool_calls: m.toolCalls.length
            ? m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.input) },
              }))
            : undefined,
        },
      ];
    case "tool": {
      // tool messages are text-only in Chat Completions, so images follow as a user message
      const images = m.results.flatMap((r) =>
        r.image
          ? [{ type: "image_url" as const, image_url: { url: `data:${r.image.mediaType};base64,${r.image.data}` } }]
          : [],
      );
      return [
        ...m.results.map((r) => ({
          role: "tool" as const,
          tool_call_id: r.id,
          content: r.image ? "Image attached in the next message." : r.output,
        })),
        ...(images.length ? [{ role: "user" as const, content: images }] : []),
      ];
    }
  }
}

/** Chat Completions API, so it also works with OpenAI-compatible endpoints (e.g. OpenRouter via a secrets.json `endpoint`). */
export function openaiProvider(options?: ConstructorParameters<typeof OpenAI>[0]): Provider {
  const client = new OpenAI(options);
  return {
    async listModels() {
      const ids: string[] = [];
      for await (const m of client.models.list()) ids.push(m.id);
      return ids;
    },
    async complete(
      { model, system, messages, tools, signal }: CompletionRequest,
      onText,
      onThinking,
    ): Promise<AssistantMessage> {
      const stream = client.chat.completions.stream(
        {
          model,
          messages: [{ role: "system", content: system }, ...messages.flatMap(toOpenAI)],
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.inputSchema) },
          })),
        },
        { signal },
      );
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        // `reasoning` is OpenRouter's extension; plain OpenAI chat completions doesn't stream reasoning
        const reasoning = (delta as { reasoning?: string } | undefined)?.reasoning;
        if (reasoning) onThinking(reasoning);
        if (delta?.content) onText(delta.content);
      }
      const message = (await stream.finalChatCompletion()).choices[0]?.message;
      return {
        role: "assistant",
        text: message?.content ?? "",
        toolCalls: (message?.tool_calls ?? []).flatMap((c) => {
          if (c.type !== "function") return [];
          let input: unknown;
          try {
            input = JSON.parse(c.function.arguments || "{}");
          } catch {
            input = c.function.arguments; // fails schema validation and is reported back to the model
          }
          return [{ id: c.id, name: c.function.name, input }];
        }),
      };
    },
  };
}
