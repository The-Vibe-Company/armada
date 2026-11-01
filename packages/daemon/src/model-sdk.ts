import { randomUUID } from "node:crypto";
import type { ReportedUsage } from "@armada/protocol";
import type { AssistantMessage, Message, Model, StreamFunction } from "@earendil-works/pi-ai";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
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
import { modelUsage, normalizeUsage } from "./usage.ts";

export interface ModelUsageReport {
  id: string;
  providerSession: string | undefined;
  model: string;
  provider: string;
  usage: ReportedUsage;
}
const sdkModels = new WeakSet<object>();
const metered = new WeakMap<Models, Models>();
const usageObservers = new WeakMap<object, Set<(report: ModelUsageReport) => boolean>>();
/** Each project only accepts reports for provider-session identities in its own durable pi log. */
export function observeModelUsage(models: object, observe: (report: ModelUsageReport) => boolean) {
  const listeners = usageObservers.get(models) ?? new Set<(report: ModelUsageReport) => boolean>();
  usageObservers.set(models, listeners);
  listeners.add(observe);
  return () => {
    listeners?.delete(observe);
  };
}

/** Meter native pi results as well as SDK results; compaction does not retain the response itself. */
export function meteredModels(models: Models): Models {
  if (sdkModels.has(models)) return models; // SDK reports its explicit counter availability directly.
  const cached = metered.get(models);
  if (cached) return cached;
  const record = (message: AssistantMessage, sessionId: string | undefined, id: string) => {
    if (message.stopReason === "deferred" || message.stopReason === "pending") return;
    const usage = modelUsage(message);
    for (const observe of usageObservers.get(models) ?? [])
      if (observe({ id, providerSession: sessionId, model: message.model, provider: message.provider, usage }))
        Object.assign(message, { armadaUsage: usage, armadaUsageId: id });
  };
  const failed = (model: Model<string>): AssistantMessage => ({
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    timestamp: Date.now(),
    stopReason: "error",
    errorMessage: "Model usage unavailable",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const streamSimple: Models["streamSimple"] = (...args) => {
    const source = models.streamSimple(...args);
    const output = createAssistantMessageEventStream();
    const id = `pi:${randomUUID()}`;
    void (async () => {
      let last: AssistantMessage | undefined;
      try {
        for await (const event of source) {
          if (event.type === "done" || event.type === "error") {
            last = event.type === "done" ? event.message : event.error;
            record(last, args[2]?.sessionId, id);
          }
          output.push(event);
        }
        const final = await source.result();
        if (!last) record(final, args[2]?.sessionId, id);
        output.end(final);
      } catch {
        // Recording errors cannot turn a paid model request into a successful unmetered turn.
        const final = last ?? failed(args[0]);
        const error: AssistantMessage = {
          ...final,
          content: [],
          stopReason: "error",
          errorMessage: "Could not record model usage",
        };
        try {
          record(error, args[2]?.sessionId, id);
        } catch {
          /* Store failure remains a failed turn. */
        }
        output.push({ type: "error", reason: "error", error });
        output.end(error);
      }
    })();
    return output;
  };
  const completeSimple: Models["completeSimple"] = async (...args) => {
    const id = `pi:${randomUUID()}`;
    let message: AssistantMessage | undefined;
    try {
      message = await models.completeSimple(...args);
      record(message, args[2]?.sessionId, id);
      return message;
    } catch (error) {
      record(message ?? failed(args[0]), args[2]?.sessionId, id);
      throw error;
    }
  };
  const proxy = new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple") return streamSimple;
      if (key === "completeSimple") return completeSimple;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  metered.set(models, proxy);
  return proxy;
}

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
    const message: AssistantMessage & { armadaUsage: ReportedUsage; armadaUsageId?: string } = {
      role: "assistant",
      armadaUsage: "unknown",
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
    const usageId = `sdk:${randomUUID()}`;
    const report = () => {
      for (const observe of usageObservers.get(models) ?? [])
        if (
          observe({
            id: usageId,
            providerSession: options?.sessionId,
            model: requested.id,
            provider: kind,
            usage: message.armadaUsage,
          })
        )
          message.armadaUsageId = usageId;
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
        const details = result.usage.inputTokenDetails;
        const read = details.cacheReadTokens;
        const write = details.cacheWriteTokens;
        // AI SDK inputTokens includes cache tokens; pi input excludes them. Missing splits stay unknown publicly.
        const input =
          details.noCacheTokens ??
          (result.usage.inputTokens !== undefined && read !== undefined && write !== undefined
            ? Math.max(0, result.usage.inputTokens - read - write)
            : undefined);
        message.armadaUsage = normalizeUsage(
          { input, output: result.usage.outputTokens, cacheRead: read, cacheWrite: write },
          requested.id,
          kind,
        );
        // Pi's own usage document requires numeric counters. Preserve availability on the immutable response.
        message.usage.input = input ?? 0;
        message.usage.output = result.usage.outputTokens ?? 0;
        message.usage.cacheRead = read ?? 0;
        message.usage.cacheWrite = write ?? 0;
        message.usage.totalTokens = result.usage.totalTokens ?? 0;
        report();
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
        message.stopReason = result.toolCalls.length ? "toolUse" : result.finishReason === "length" ? "length" : "stop";
        events.push({ type: "done", reason: message.stopReason, message });
      } catch {
        if (!message.armadaUsageId) report();
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
  usageObservers.set(models, new Set());
  sdkModels.add(models);
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
