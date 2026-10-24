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
    async contextWindow(model) {
      // `context_length` is OpenRouter's extension; OpenAI's model list doesn't report it
      for await (const m of client.models.list())
        if (m.id === model) return (m as { context_length?: number }).context_length;
    },
    async complete(
      { model, system, messages, tools, effort, signal }: CompletionRequest,
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
          stream_options: { include_usage: true },
          // only when set: non-reasoning models reject the parameter
          ...(effort && { reasoning_effort: effort === "off" ? "none" : effort }),
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
      const { choices, usage } = await stream.finalChatCompletion();
      const message = choices[0]?.message;
      return {
        role: "assistant",
        usage: usage && {
          input: usage.prompt_tokens,
          output: usage.completion_tokens,
          cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
        },
        text: message?.content ?? "",
        toolCalls: (message?.tool_calls ?? []).flatMap((c) =>
          c.type === "function"
            ? [{ id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) }]
            : [],
        ),
      };
    },
  };
}

function parseArguments(args: string): unknown {
  try {
    return JSON.parse(args || "{}");
  } catch {
    return args; // fails schema validation and is reported back to the model
  }
}

function toResponses(m: Message, key: string): OpenAI.Responses.ResponseInputItem[] {
  switch (m.role) {
    case "user":
      return [m];
    case "assistant":
      if (m.raw?.provider === key) return m.raw.content as OpenAI.Responses.ResponseInputItem[];
      return [
        ...(m.text ? [{ role: "assistant" as const, content: m.text }] : []),
        ...m.toolCalls.map((c) => ({
          type: "function_call" as const,
          call_id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.input),
        })),
      ];
    case "tool":
      return m.results.map((r) => ({
        type: "function_call_output" as const,
        call_id: r.id,
        output: r.image
          ? [{ type: "input_image" as const, image_url: `data:${r.image.mediaType};base64,${r.image.data}` }]
          : r.output,
      }));
  }
}

/** Responses API, OpenAI's newer one (some models only serve it); OpenRouter has it too. */
export function openaiResponsesProvider(options?: ConstructorParameters<typeof OpenAI>[0]): Provider {
  const client = new OpenAI(options);
  return {
    ...openaiProvider(options),
    async complete(
      { model, system, messages, tools, effort, signal }: CompletionRequest,
      onText,
      onThinking,
    ): Promise<AssistantMessage> {
      // raw output goes back only to the same endpoint and model: reasoning is encrypted per account, and models
      // without reasoning reject it
      const key = `openai-responses ${client.baseURL} ${model}`;
      const stream = await client.responses.create(
        {
          model,
          instructions: system,
          input: messages.flatMap((m) => toResponses(m, key)),
          tools: tools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: z.toJSONSchema(t.inputSchema),
            // strict, the default here, requires every property to be required; optional zod fields aren't
            strict: false,
          })),
          // every request carries the whole history, so nothing needs storing; reasoning comes back encrypted instead
          store: false,
          stream: true,
          // only when set: models without reasoning reject these
          // ponytail: so auto effort gets no summaries or replayable reasoning; fix per model once we know which reason
          ...(effort &&
            (effort === "off"
              ? { reasoning: { effort: "none" } }
              : { reasoning: { effort, summary: "auto" }, include: ["reasoning.encrypted_content"] })),
        },
        { signal },
      );
      let response: OpenAI.Responses.Response | undefined;
      for await (const event of stream) {
        switch (event.type) {
          case "response.output_text.delta":
            onText(event.delta);
            break;
          // OpenAI streams reasoning summaries; others (e.g. Claude on OpenRouter) the reasoning itself
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta":
            onThinking(event.delta);
            break;
          case "response.completed":
          case "response.incomplete":
          case "response.failed":
            response = event.response;
        }
      }
      if (!response || response.error) throw new Error(response?.error?.message ?? "Response stream ended early");
      const { output, usage } = response;
      return {
        role: "assistant",
        usage: usage && {
          input: usage.input_tokens,
          output: usage.output_tokens,
          cached: usage.input_tokens_details?.cached_tokens ?? 0,
        },
        text: output
          .flatMap((i) => (i.type === "message" ? i.content : []))
          .flatMap((c) => (c.type === "output_text" ? [c.text] : []))
          .join(""),
        toolCalls: output.flatMap((i) =>
          i.type === "function_call" ? [{ id: i.call_id, name: i.name, input: parseArguments(i.arguments) }] : [],
        ),
        raw: {
          provider: key,
          // without ids, since nothing is stored to look them up by, so reasoning needs its encrypted content or text
          content: output
            .filter((i) => i.type !== "reasoning" || i.encrypted_content || i.content?.length)
            .map(({ id, ...i }) => i),
        },
      };
    },
  };
}
