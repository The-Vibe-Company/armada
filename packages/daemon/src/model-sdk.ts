import type { AssistantMessage, Message, Model, StreamFunction } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
  type AssistantModelMessage,
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";

function messagesOf(messages: Message[]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === "system") return [];
    if (message.role === "user")
      return [
        {
          role: "user",
          content:
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) =>
                  part.type === "text"
                    ? part
                    : {
                        type: "image",
                        image: new Uint8Array(Buffer.from(part.data, "base64")),
                        mediaType: part.mimeType,
                      },
                ),
        },
      ];
    if (message.role === "assistant")
      return [
        {
          role: "assistant",
          content: message.content.flatMap<Exclude<AssistantModelMessage["content"], string>[number]>((part) => {
            if (part.type === "text") return [{ type: "text" as const, text: part.text }];
            if (part.type === "thinking")
              return [
                {
                  type: "reasoning" as const,
                  text: part.thinking,
                  ...(part.thinkingSignature
                    ? { providerOptions: { anthropic: { signature: part.thinkingSignature } } }
                    : {}),
                },
              ];
            if (part.type === "toolCall")
              return [{ type: "tool-call" as const, toolCallId: part.id, toolName: part.name, input: part.arguments }];
            return [];
          }),
        },
      ];
    return [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            output: {
              type: message.isError ? "error-text" : "text",
              value: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n"),
            },
          },
        ],
      },
    ];
  });
}

/** The only SDK translation: plugins own credentials/endpoints, pi owns durable tool execution. */
export function pluginModels(kind: string, modelId: string, sdk: LanguageModel) {
  const model: Model<string> = {
    id: modelId,
    name: modelId,
    provider: kind,
    api: "armada-ai-sdk",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const stream: StreamFunction = (requested, context, options) => {
    const events = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: kind,
      model: requested.id,
      timestamp: Date.now(),
      content: [],
      stopReason: "pending",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    events.push({ type: "start", partial: message });
    void (async () => {
      try {
        const tools: ToolSet = Object.fromEntries(
          getCurrentTools(context.messages).map((tool) => [
            tool.name,
            {
              description: tool.description,
              inputSchema: jsonSchema(tool.parameters),
            },
          ]),
        );
        const result = await generateText({
          model: sdk,
          system: getCurrentSystemPrompt(context.messages),
          messages: messagesOf(context.messages),
          tools,
          maxRetries: 0,
          maxOutputTokens: options?.maxTokens ?? model.maxTokens,
          abortSignal: options?.signal,
        });
        if (!["stop", "length", "tool-calls"].includes(result.finishReason)) throw new Error("Model did not complete");
        if (result.toolCalls.length > 0 !== (result.finishReason === "tool-calls"))
          throw new Error("Incomplete model tool call");
        for (const part of result.reasoning) {
          if (part.type !== "reasoning") continue;
          const signature = part.providerMetadata?.anthropic?.signature;
          message.content.push({
            type: "thinking",
            thinking: part.text,
            ...(typeof signature === "string" ? { thinkingSignature: signature } : {}),
          });
        }
        if (result.text) message.content.push({ type: "text", text: result.text });
        for (const call of result.toolCalls) {
          if (call.invalid || !call.input || typeof call.input !== "object" || Array.isArray(call.input))
            throw new Error("Invalid tool arguments");
          message.content.push({ type: "toolCall", id: call.toolCallId, name: call.toolName, arguments: call.input });
        }
        message.usage.input = result.usage.inputTokens ?? 0;
        message.usage.output = result.usage.outputTokens ?? 0;
        message.usage.totalTokens = result.usage.totalTokens ?? 0;
        message.stopReason = result.toolCalls.length ? "toolUse" : result.finishReason === "length" ? "length" : "stop";
        events.push({ type: "done", reason: message.stopReason, message });
      } catch {
        // SDK errors contain response bodies and request headers. None may reach durable checkpoints.
        message.content = [];
        message.stopReason = options?.signal?.aborted ? "aborted" : "error";
        message.errorMessage = message.stopReason === "aborted" ? "Model request cancelled" : "Model request failed";
        events.push({ type: "error", reason: message.stopReason, error: message });
      }
      events.end(message);
    })();
    return events;
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: kind,
      models: [model],
      auth: { apiKey: { name: "Plugin-managed", resolve: async () => ({ auth: {} }) } },
      api: { stream, streamSimple: stream },
    }),
  );
  return { models, model: { provider: kind, modelId } };
}
