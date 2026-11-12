import Anthropic from "@anthropic-ai/sdk";
import {
  type AssistantMessage,
  type CompletionRequest,
  EFFORTS,
  type Message,
  type ModelInfo,
  type Provider,
  toolSchema,
} from "../llm.ts";

// Anthropic only accepts [a-zA-Z0-9_-] ids; other providers' ids (e.g. "functions.bash:0") are mapped deterministically
const toolId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

/** `key` is the `raw.provider` this endpoint and model write, the only one replayed to them. */
function toAnthropic(m: Message, key: string): Anthropic.MessageParam[] {
  switch (m.role) {
    case "user":
      // rebuilt, so `entryId`/`meta` never reach the API; a plugin's message is plain text to the model
      return [
        {
          role: "user",
          content: m.images?.length
            ? [
                ...m.images.map((i) => ({
                  type: "image" as const,
                  source: { type: "base64" as const, media_type: i.mediaType, data: i.data },
                })),
                { type: "text" as const, text: m.content },
              ]
            : m.content,
        },
      ];
    case "assistant": {
      const content: Anthropic.ContentBlockParam[] =
        m.raw?.provider === key
          ? (m.raw.content as Anthropic.ContentBlockParam[])
          : [
              ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
              ...m.toolCalls
                .filter((c) => !c.result)
                .map((c) => ({
                  type: "tool_use" as const,
                  id: toolId(c.id),
                  name: c.name,
                  // unparseable arguments from another provider; the tool result already reports the error
                  input: typeof c.input === "object" && c.input !== null ? c.input : {},
                })),
            ];
      // empty assistant turns (an empty end_turn reply, or from other providers) are rejected by the API
      return content.length ? [{ role: "assistant", content }] : [];
    }
    case "tool":
      return [
        {
          role: "user",
          content: m.results.map((r) => ({
            type: "tool_result",
            tool_use_id: toolId(r.id),
            content: r.images?.length
              ? [
                  ...(r.output ? [{ type: "text" as const, text: r.output }] : []),
                  ...r.images.map((i) => ({
                    type: "image" as const,
                    source: { type: "base64" as const, media_type: i.mediaType, data: i.data },
                  })),
                ]
              : r.output,
            is_error: r.isError,
          })),
        },
      ];
  }
}

const blocks = (c: Anthropic.MessageParam["content"]): Anthropic.ContentBlockParam[] =>
  typeof c === "string" ? [{ type: "text", text: c }] : c;

/**
 * `messages` with consecutive user turns (a tool message and a plugin's message after it, two user messages) merged
 * into one, in order, as the API takes alternating turns (it merges them itself, proxies may not)
 */
function alternate(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    const last = out.at(-1);
    if (last?.role === "user" && m.role === "user")
      out[out.length - 1] = { role: "user", content: [...blocks(last.content), ...blocks(m.content)] };
    else out.push(m);
  }
  return out;
}

export function anthropicProvider(options?: ConstructorParameters<typeof Anthropic>[0]): Provider {
  const client = new Anthropic(options);
  // ponytail: per provider instance (one per run), so each run retrieves it once; cache across runs if that shows up
  const infos = new Map<string, Promise<ModelInfo>>();
  const info = (model: string) => {
    let i = infos.get(model);
    if (!i) {
      i = client.models.retrieve(model).then(
        (m): ModelInfo => {
          const c = m.capabilities;
          return {
            contextWindow: m.max_input_tokens ?? undefined,
            maxOutput: m.max_tokens ?? undefined,
            efforts: c
              ? EFFORTS.filter((e) =>
                  e === "off" ? c.thinking.types.disabled.supported : c.effort.supported && c.effort[e]?.supported,
                )
              : undefined,
            images: c?.image_input.supported,
          };
        },
        // kept like a success, so an endpoint that doesn't report models (a proxy) isn't asked again every turn
        (): ModelInfo => ({}),
      );
      infos.set(model, i);
    }
    return i;
  };
  return {
    async listModels() {
      const ids: string[] = [];
      for await (const m of client.models.list()) ids.push(m.id);
      return ids;
    },
    info,
    async complete(
      { model, system, messages, tools, effort, maxTokens, temperature, headers, signal }: CompletionRequest,
      cb = {},
    ): Promise<AssistantMessage> {
      // thinking blocks go back only to the same endpoint and model, so a proxy's never reach the API or the reverse
      const key = `anthropic ${client.baseURL} ${model}`;
      // the request's (a routing wrapper's), else the most the model allows; endpoints that report neither get 64000
      const maxOutput = maxTokens ?? (await info(model)).maxOutput ?? 64000;
      const params: Anthropic.MessageStreamParams = {
        model,
        max_tokens: maxOutput,
        ...(temperature !== undefined && { temperature }),
        // automatic caching: marks the last cacheable block, so each turn reads the previous turn's prefix
        cache_control: { type: "ephemeral" },
        // ponytail: adaptive only, pre-4.6 models (e.g. Haiku 4.5) reject it; pick per model if they matter
        thinking: effort === "off" ? { type: "disabled" } : { type: "adaptive", display: "summarized" },
        ...(effort && effort !== "off" && { output_config: { effort } }),
        system,
        messages: alternate(messages.flatMap((m) => toAnthropic(m, key))),
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: toolSchema(t) as Anthropic.Tool.InputSchema,
          ...t.providerOptions?.anthropic,
        })),
      };
      cb.payload?.(params);
      const stream = client.messages.stream(params, { signal, headers });
      // tool_use blocks by index, for their input deltas
      const calls = new Map<number, { id: string; name: string }>();
      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "tool_use")
          calls.set(event.index, { id: event.content_block.id, name: event.content_block.name });
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta") cb.text?.(event.delta.text);
        else if (event.delta.type === "thinking_delta") cb.thinking?.(event.delta.thinking);
        else if (event.delta.type === "input_json_delta") {
          const call = calls.get(event.index);
          if (call) cb.toolInput?.({ ...call, partial: event.delta.partial_json });
        }
      }
      const message = await stream.finalMessage();
      const reason = message.stop_reason;
      cb.meta?.({
        stopReason: reason === "end_turn" || reason === "stop_sequence" ? "end" : (reason ?? undefined),
        responseId: message.id,
        model: message.model,
        status: stream.response?.status,
        headers: stream.response ? Object.fromEntries(stream.response.headers) : undefined,
      });
      const toolCalls = message.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [],
      );
      if (message.stop_reason === "max_tokens" && toolCalls.length)
        throw new Error("Tool input truncated by max_tokens");
      if (message.stop_reason === "refusal")
        throw new Error(`Model refused: ${message.stop_details?.explanation ?? "no details"}`);
      const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = message.usage;
      return {
        role: "assistant",
        text: message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
        toolCalls,
        raw: { provider: key, content: message.content },
        usage: {
          input: input_tokens + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0),
          output: output_tokens,
          cacheRead: cache_read_input_tokens ?? 0,
          cacheWrite: cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
