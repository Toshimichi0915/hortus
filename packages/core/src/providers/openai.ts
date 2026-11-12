import { randomUUID } from "node:crypto";
import OpenAI, { APIUserAbortError } from "openai";
import { type AssistantMessage, type CompletionRequest, type Message, type Provider, toolSchema } from "../llm.ts";

/** Provider-executed calls (with a `result`) are the provider's own; rebuilt history leaves them out. */
const ownCalls = (m: Extract<Message, { role: "assistant" }>) => m.toolCalls.filter((c) => !c.result);

function toOpenAI(m: Message): OpenAI.ChatCompletionMessageParam[] {
  switch (m.role) {
    case "user":
      // rebuilt, so `entryId`/`meta` never reach the API; a plugin's message is plain text to the model
      return [
        {
          role: "user",
          content: m.images?.length
            ? [
                ...m.images.map((i) => ({
                  type: "image_url" as const,
                  image_url: { url: `data:${i.mediaType};base64,${i.data}` },
                })),
                { type: "text" as const, text: m.content },
              ]
            : m.content,
        },
      ];
    case "assistant": {
      const calls = ownCalls(m);
      // an empty reply (e.g. from Anthropic) has neither content nor tool calls, which the API rejects
      if (!m.text && !calls.length) return [];
      return [
        {
          role: "assistant",
          content: m.text || null,
          tool_calls: calls.length
            ? calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.input) },
              }))
            : undefined,
        },
      ];
    }
    case "tool": {
      // tool messages are text-only in Chat Completions, so images follow as a user message
      const images = m.results.flatMap((r) =>
        (r.images ?? []).map((i) => ({
          type: "image_url" as const,
          image_url: { url: `data:${i.mediaType};base64,${i.data}` },
        })),
      );
      return [
        ...m.results.map((r) => ({
          role: "tool" as const,
          tool_call_id: r.id,
          content: r.images?.length
            ? `${r.output ? `${r.output}\n\n` : ""}${r.images.length > 1 ? "Images" : "Image"} attached in the next message.`
            : r.output,
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
    async info(model) {
      // `context_length` is OpenRouter's extension; OpenAI's model list doesn't report it
      for await (const m of client.models.list())
        if (m.id === model) return { contextWindow: (m as { context_length?: number }).context_length };
      return {};
    },
    async complete(
      { model, system, messages, tools, effort, temperature, headers, signal }: CompletionRequest,
      cb = {},
    ): Promise<AssistantMessage> {
      const params: OpenAI.ChatCompletionCreateParamsStreaming = {
        model,
        messages: [{ role: "system", content: system }, ...messages.flatMap(toOpenAI)],
        tools: tools.map(
          (t) =>
            ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: toolSchema(t) },
              ...t.providerOptions?.openai,
            }) as OpenAI.ChatCompletionTool,
        ),
        stream: true,
        stream_options: { include_usage: true },
        ...(temperature !== undefined && { temperature }),
        // only when set: non-reasoning models reject the parameter
        ...(effort && { reasoning_effort: effort === "off" ? "none" : effort }),
      };
      cb.payload?.(params);
      // the raw response first, for its status and headers. Chunks are accumulated here: the SDK's accumulator treats
      // a changed chunk `id` (some compatible endpoints vary it) as a new request
      const { data: stream, response } = await client.chat.completions
        .create(params, { signal, headers })
        .withResponse();
      let id: string | undefined;
      let served: string | undefined;
      let finish: string | null | undefined;
      let usage: OpenAI.CompletionUsage | undefined;
      let text = "";
      // tool calls by index. Endpoints differ: id and name may come in the first delta, a later one, or every one;
      // arguments are always appended. `sent` is how much of `args` went to toolInput, which waits for the name
      const calls = new Map<number, { id?: string; name?: string; args: string; sent: number }>();
      for await (const chunk of stream) {
        id ??= chunk.id;
        served ??= chunk.model;
        usage = chunk.usage ?? usage;
        const choice = chunk.choices[0];
        finish = choice?.finish_reason ?? finish;
        const delta = choice?.delta;
        // `reasoning` is OpenRouter's extension; plain OpenAI chat completions doesn't stream reasoning
        const reasoning = (delta as { reasoning?: string } | undefined)?.reasoning;
        if (reasoning) cb.thinking?.(reasoning);
        if (delta?.content) {
          text += delta.content;
          cb.text?.(delta.content);
        }
        for (const t of delta?.tool_calls ?? []) {
          const call = calls.get(t.index) ?? { args: "", sent: 0 };
          calls.set(t.index, call);
          // the first id wins, so one generated for toolInput isn't replaced by a late real one
          if (t.id) call.id ??= t.id;
          if (t.function?.name) call.name = t.function.name;
          call.args += t.function?.arguments ?? "";
          if (call.name && call.args.length > call.sent) {
            call.id ??= `call_${randomUUID()}`;
            cb.toolInput?.({ id: call.id, name: call.name, partial: call.args.slice(call.sent) });
            call.sent = call.args.length;
          }
        }
      }
      // the SDK's stream just ends when aborted
      if (signal?.aborted) throw new APIUserAbortError();
      if (!finish) throw new Error("Chat completion stream ended without a finish_reason");
      cb.meta?.({
        stopReason:
          finish === "stop"
            ? "end"
            : finish === "tool_calls"
              ? "tool_use"
              : finish === "length"
                ? "max_tokens"
                : finish,
        responseId: id,
        model: served,
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
      return {
        role: "assistant",
        usage: usage && {
          input: usage.prompt_tokens,
          output: usage.completion_tokens,
          cacheRead: usage.prompt_tokens_details?.cached_tokens ?? 0,
        },
        text,
        toolCalls: [...calls.entries()].map(([index, c]) => {
          if (!c.name) throw new Error(`Chat completion tool call ${index} ended without a name`);
          return { id: c.id ?? `call_${randomUUID()}`, name: c.name, input: parseArguments(c.args) };
        }),
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
      // rebuilt, so `entryId`/`meta` never reach the API; a plugin's message is plain text to the model
      return [
        {
          role: "user",
          content: m.images?.length
            ? [
                ...m.images.map((i) => ({
                  type: "input_image" as const,
                  image_url: `data:${i.mediaType};base64,${i.data}`,
                  detail: "auto" as const,
                })),
                { type: "input_text" as const, text: m.content },
              ]
            : m.content,
        },
      ];
    case "assistant":
      if (m.raw?.provider === key) return m.raw.content as OpenAI.Responses.ResponseInputItem[];
      return [
        ...(m.text ? [{ role: "assistant" as const, content: m.text }] : []),
        ...ownCalls(m).map((c) => ({
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
        output: r.images?.length
          ? [
              ...(r.output ? [{ type: "input_text" as const, text: r.output }] : []),
              ...r.images.map((i) => ({
                type: "input_image" as const,
                image_url: `data:${i.mediaType};base64,${i.data}`,
              })),
            ]
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
      { model, system, messages, tools, effort, temperature, headers, signal }: CompletionRequest,
      cb = {},
    ): Promise<AssistantMessage> {
      // raw output goes back only to the same endpoint and model: reasoning is encrypted per account, and models
      // without reasoning reject it
      const key = `openai-responses ${client.baseURL} ${model}`;
      const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
        model,
        instructions: system,
        input: messages.flatMap((m) => toResponses(m, key)),
        tools: tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: toolSchema(t),
          // strict, the default here, requires every property to be required; optional zod fields aren't
          strict: false,
          ...t.providerOptions?.["openai-responses"],
        })) as OpenAI.Responses.Tool[],
        // every request carries the whole history, so nothing needs storing; reasoning comes back encrypted instead
        store: false,
        stream: true,
        ...(temperature !== undefined && { temperature }),
        // only when set: models without reasoning reject these
        // ponytail: so auto effort gets no summaries or replayable reasoning; fix per model once we know which reason
        ...(effort &&
          (effort === "off"
            ? { reasoning: { effort: "none" } }
            : { reasoning: { effort, summary: "auto" }, include: ["reasoning.encrypted_content"] })),
      };
      cb.payload?.(params);
      const { data: stream, response: http } = await client.responses
        .create(params, { signal, headers })
        .withResponse();
      cb.meta?.({ status: http.status, headers: Object.fromEntries(http.headers) });
      let response: OpenAI.Responses.Response | undefined;
      // function calls by item id, for their argument deltas
      const calls = new Map<string, { id: string; name: string }>();
      for await (const event of stream) {
        switch (event.type) {
          case "response.output_text.delta":
            cb.text?.(event.delta);
            break;
          // OpenAI streams reasoning summaries; others (e.g. Claude on OpenRouter) the reasoning itself
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta":
            cb.thinking?.(event.delta);
            break;
          case "response.output_item.added":
            if (event.item.type === "function_call" && event.item.id)
              calls.set(event.item.id, { id: event.item.call_id, name: event.item.name });
            break;
          case "response.function_call_arguments.delta": {
            const call = calls.get(event.item_id);
            if (call) cb.toolInput?.({ ...call, partial: event.delta });
            break;
          }
          case "response.completed":
          case "response.incomplete":
          case "response.failed":
            response = event.response;
        }
      }
      if (!response || response.error) throw new Error(response?.error?.message ?? "Response stream ended early");
      const { output, usage } = response;
      const called = output.some((i) => i.type === "function_call");
      cb.meta?.({
        stopReason:
          response.incomplete_details?.reason === "max_output_tokens"
            ? "max_tokens"
            : (response.incomplete_details?.reason ?? (called ? "tool_use" : "end")),
        responseId: response.id,
        model: response.model,
      });
      return {
        role: "assistant",
        usage: usage && {
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: usage.input_tokens_details?.cached_tokens ?? 0,
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
