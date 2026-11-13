import { randomUUID } from "node:crypto";
import type { RunnerRequest } from "@armada/agent-runtime";
import {
  type EventPage,
  type EventsRequest,
  type GitHubRuntimeConfiguration,
  type ModelChoice,
  type PromptReceipt,
  type PromptRequest,
  type PromptState,
  ProviderError,
  type ProviderErrorCode,
  resolveModelChoice,
} from "@armada/core";
import type { createRuntimeCommands } from "./runtime-commands.ts";

const errors: Record<string, ProviderErrorCode> = {
  not_found: "not_found",
  invalid_request: "invalid_request",
  invalid_cursor: "invalid_request",
  invalid_cwd: "invalid_request",
  unsupported_fast_model: "invalid_request",
  invalid_effort: "invalid_request",
  unselected_runtime_harness: "invalid_request",
  conversation_harness_mismatch: "invalid_request",
  conversation_busy: "conflict",
  checkpoint_in_progress: "sandbox_not_ready",
  request_outcome_unknown: "conflict",
};
function refusal(code: ProviderErrorCode, requestId?: string): ProviderError {
  return new ProviderError({
    provider: "boat",
    code,
    message: "Armada runtime operation refused.",
    retryable: false,
    ...(requestId ? { details: { runtimeRequestId: requestId, runtimeOutcome: "unknown" } } : {}),
  });
}

/** Agent operations only, NOT a complete Provider. Never wraps/falls back to native Boat APIs.
 * Launch admission must select this bridge explicitly and supply trusted persisted binding.
 */
export function createRuntimeAgent(
  commands: Pick<ReturnType<typeof createRuntimeCommands>, "call">,
  binding: {
    ownerId: string;
    sandboxId: string;
    providerSandboxId: string;
    cwd: string;
    defaults: ModelChoice;
  },
) {
  const { ownerId, sandboxId, providerSandboxId, cwd } = binding;
  const defaults = { ...binding.defaults };
  function target(id: string) {
    if (id !== providerSandboxId) throw refusal("invalid_request");
  }
  async function invoke<T>(command: RunnerRequest, signal?: AbortSignal, expectedEpoch?: string): Promise<T> {
    let reply: Awaited<ReturnType<typeof commands.call>>;
    try {
      reply = await commands.call(ownerId, command, {
        ...(signal ? { signal } : {}),
        ...(expectedEpoch !== undefined ? { expectedEpoch } : {}),
      });
    } catch {
      // A lost wait is not proof of non-execution. Preserve the exact identity for
      // reconciliation; never include transport errors or private payloads.
      throw refusal("conflict", command.requestId);
    }
    const body = reply.body;
    const identified = body.version !== undefined || body.requestId !== undefined;
    if (identified && (body.version !== 1 || body.requestId !== command.requestId))
      throw refusal("unavailable", command.requestId);
    if (body.error && (identified || reply.status === 409)) {
      const name = typeof body.error === "string" ? body.error : undefined;
      const code = name && Object.hasOwn(errors, name) ? errors[name] : undefined;
      throw refusal(code ?? "unknown", name === "request_outcome_unknown" || !code ? command.requestId : undefined);
    }
    if (reply.status < 200 || reply.status >= 300 || !identified || !("result" in body))
      throw refusal("unavailable", command.requestId);
    return body.result as T;
  }
  const identity = (requestId: string = randomUUID()) => ({ version: 1 as const, sandboxId, requestId });
  return {
    /** The launcher must first await enrolment; no native readiness/resume is implied. */
    async health(
      signal?: AbortSignal,
      expectedRestore?: { epoch: string; watermark: number; conversationId: string },
    ): Promise<{ runtime: "armada"; epoch: string }> {
      const command = { ...identity(), op: "health" as const };
      // Retain epoch alongside the result for provenance validation.
      let reply: Awaited<ReturnType<typeof commands.call>>;
      try {
        reply = await commands.call(ownerId, command, signal ? { signal } : {});
      } catch {
        throw refusal("sandbox_not_ready");
      }
      const body = reply.body;
      const result = body.result as
        | {
            ready?: unknown;
            generation?: unknown;
            restoredFrom?: { epoch?: unknown; watermark?: unknown; conversationId?: unknown };
          }
        | undefined;
      if (
        reply.status !== 200 ||
        body.version !== 1 ||
        body.requestId !== command.requestId ||
        body.error !== undefined ||
        !result ||
        result.ready !== true ||
        result.generation !== reply.epoch ||
        (expectedRestore &&
          (result.restoredFrom?.epoch !== expectedRestore.epoch ||
            result.restoredFrom.watermark !== expectedRestore.watermark ||
            result.restoredFrom.conversationId !== expectedRestore.conversationId))
      )
        throw refusal("sandbox_not_ready");
      return { runtime: "armada", epoch: reply.epoch };
    },
    async configureGitHub(configuration: GitHubRuntimeConfiguration, requestId: string): Promise<void> {
      const result = await invoke<{ acknowledged?: boolean }>({
        ...identity(requestId),
        op: "configureGitHub",
        configuration,
      });
      if (result?.acknowledged !== true) throw refusal("unavailable", requestId);
    },
    /** Supply the same requestId to reconcile an uncertain prompt admission. */
    async prompt(
      request: PromptRequest,
      requestId: string = randomUUID(),
      expectedEpoch?: string,
    ): Promise<PromptReceipt> {
      target(request.sandboxId);
      if (request.harness !== "codex" || !request.text.trim()) throw refusal("invalid_request");
      const choice = resolveModelChoice("codex", request, defaults);
      return invoke(
        {
          ...identity(requestId),
          op: "prompt",
          input: {
            sandboxId,
            harness: "codex",
            text: request.text,
            ...choice,
            cwd,
            ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
            ...(request.fast === undefined ? {} : { fast: request.fast }),
          },
        },
        request.signal,
        expectedEpoch,
      );
    },
    async getPrompt(request: { sandboxId: string; promptId: string; signal?: AbortSignal }): Promise<PromptState> {
      target(request.sandboxId);
      return invoke({ ...identity(), op: "getPrompt", promptId: request.promptId }, request.signal);
    },
    async events(request: EventsRequest): Promise<EventPage> {
      target(request.sandboxId);
      // Runtime RPC currently offers forward raw journal pages only. Do not silently
      // pretend it supports the richer stored-history projection contract.
      if (
        request.direction === "backward" ||
        request.maxBytes !== undefined ||
        request.coalesce ||
        (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 1000))
      )
        throw refusal("invalid_request");
      return invoke(
        {
          ...identity(),
          op: "events",
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
        },
        request.signal,
      );
    },
  };
}
