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
    case "tool":
      return m.results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.output }));
  }
}

/** Chat Completions API, so it also works with OpenAI-compatible endpoints (e.g. OpenRouter via baseURL). */
export function openaiProvider(options?: ConstructorParameters<typeof OpenAI>[0]): Provider {
  const client = new OpenAI(options);
  return {
    async complete({ model, system, messages, tools }: CompletionRequest, onText): Promise<AssistantMessage> {
      const stream = client.chat.completions.stream({
        model,
        messages: [{ role: "system", content: system }, ...messages.flatMap(toOpenAI)],
        tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.inputSchema) },
        })),
      });
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content;
        if (text) onText(text);
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
