import { randomUUID } from "node:crypto";
import type { RunnerRequest } from "@armada/agent-runtime";
import {
  type EventPage,
  type EventsRequest,
  type ExecRequest,
  type ExecResult,
  type GitHubRuntimeConfiguration,
  type Harness,
  type InterruptRequest,
  type ModelChoice,
  type PromptReceipt,
  type PromptRequest,
  type PromptState,
  ProviderError,
  type ProviderErrorCode,
  resolveModelChoice,
  type SandboxRecord,
  type SkillReceipt,
  type SteerReceipt,
  type SteerRequest,
} from "@armada/core";
import { PRIVATE_SKILL_FAILURES, PrivateSkillError } from "../../core/src/private-skill-error.ts";
import type { createRuntimeCommands } from "./runtime-commands.ts";

const errors: Record<string, ProviderErrorCode> = {
  not_found: "not_found",
  no_running_turn: "no_running_turn",
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
function runtimeRefusal(
  provider: "boat" | "modal" | "docker",
  code: ProviderErrorCode,
  requestId?: string,
): ProviderError {
  return new ProviderError({
    provider,
    code,
    message: "Armada runtime operation refused.",
    retryable: false,
    ...(requestId ? { details: { runtimeRequestId: requestId, runtimeOutcome: "unknown" } } : {}),
  });
}

type RuntimeRestore = { epoch: string; watermark: number; conversationId: string };
/** Shared enrolled readiness and retained-session proof; transports keep envelope authorization. */
export function runtimeHealthMatches(value: unknown, epoch: string, expected?: RuntimeRestore) {
  const health = value as Record<string, unknown> | undefined;
  const restored = health?.restoredFrom as Record<string, unknown> | undefined;
  return (
    health?.ready === true &&
    health.generation === epoch &&
    (!expected || (["epoch", "watermark", "conversationId"] as const).every((key) => restored?.[key] === expected[key]))
  );
}

/** Build the bridge from persisted identity; callers retain owner/defaults and any authoritative cwd. */
export function runtimeAgentFor(
  commands: Parameters<typeof createRuntimeAgent>[0],
  ownerId: string,
  sandbox: Pick<SandboxRecord, "id" | "harness" | "providerSandboxId" | "repositoryDir"> & {
    provider: "boat" | "modal" | "docker";
  },
  defaults: ModelChoice,
  cwd = sandbox.repositoryDir ? `/home/user/${sandbox.repositoryDir}` : "/home/user",
) {
  return createRuntimeAgent(commands, {
    provider: sandbox.provider,
    harness: sandbox.harness,
    ownerId,
    sandboxId: sandbox.id,
    providerSandboxId: sandbox.providerSandboxId,
    cwd,
    defaults,
  });
}

/** Agent operations only, NOT a complete Provider. Never wraps/falls back to native Boat APIs.
 * Launch admission must select this bridge explicitly and supply trusted persisted binding.
 */
export function createRuntimeAgent(
  commands: Pick<ReturnType<typeof createRuntimeCommands>, "call">,
  binding: {
    provider?: "boat" | "modal" | "docker";
    harness: Harness;
    ownerId: string;
    sandboxId: string;
    providerSandboxId: string;
    cwd: string;
    defaults: ModelChoice;
  },
) {
  const { ownerId, sandboxId, providerSandboxId, cwd } = binding;
  const refusal = (code: ProviderErrorCode, requestId?: string) =>
    runtimeRefusal(binding.provider ?? "boat", code, requestId);
  const defaults = { ...binding.defaults };
  function target(id: string) {
    if (id !== providerSandboxId) throw refusal("invalid_request");
  }
  async function invoke<T>(
    command: RunnerRequest,
    signal?: AbortSignal,
    expectedEpoch?: string,
    timeoutMs?: number,
  ): Promise<T> {
    let reply: Awaited<ReturnType<typeof commands.call>>;
    try {
      reply = await commands.call(ownerId, command, {
        ...(signal ? { signal } : {}),
        ...(command.op === "workspaceExec" ? { timeoutMs: 610_000 } : timeoutMs ? { timeoutMs } : {}),
        ...(expectedEpoch !== undefined ? { expectedEpoch } : {}),
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
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
      expectedRestore?: RuntimeRestore,
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
      if (
        reply.status !== 200 ||
        body.version !== 1 ||
        body.requestId !== command.requestId ||
        body.error !== undefined ||
        !runtimeHealthMatches(body.result, reply.epoch, expectedRestore)
      )
        throw refusal("sandbox_not_ready");
      return { runtime: "armada", epoch: reply.epoch };
    },
    async workspaceHealth(epoch: string, signal?: AbortSignal) {
      const health = await invoke<{ ready?: unknown; generation?: unknown; workspaceVersion?: unknown }>(
        { ...identity(), op: "health" },
        signal,
        epoch,
      );
      if (health.ready !== true || health.generation !== epoch || health.workspaceVersion !== 1)
        throw new Error("Runtime workspace setup requires updated runtime artifacts; no native fallback.");
    },
    async workspaceExec(
      request: import("@armada/core").ExecRequest,
      step: { phase: "repository" | "init"; index: number; attempt: number },
      epoch: string,
      signal?: AbortSignal,
    ) {
      target(request.sandboxId);
      if (request.detached) throw refusal("invalid_request");
      const result = await invoke<import("@armada/core").ExecResult>(
        {
          ...identity(`workspace_${epoch}_${step.phase}_${step.index}_${step.attempt}`),
          op: "workspaceExec",
          input: {
            command: request.command,
            cwd: request.cwd ?? "/home/user",
            timeoutSeconds: request.timeoutSeconds ?? 600,
            ...step,
          },
        },
        signal,
        epoch,
      );
      if (
        !result ||
        result.detached !== false ||
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string" ||
        !(result.exitCode === null || Number.isInteger(result.exitCode))
      )
        throw refusal("unavailable");
      return result;
    },
    async installSkills(
      references: string[],
      key: string | null,
      epoch: string,
      signal?: AbortSignal,
    ): Promise<SkillReceipt[]> {
      const health = await invoke<{ ready?: unknown; generation?: unknown; skillsVersion?: unknown }>(
        { ...identity(), op: "health" },
        signal,
        epoch,
      );
      if (health.ready !== true || health.generation !== epoch || health.skillsVersion !== 1)
        throw new PrivateSkillError("skillpack_transport_failed", "transport");
      const result = await invoke<{ receipts?: SkillReceipt[]; failure?: { reason?: unknown } }>(
        {
          ...identity(`skills_${sandboxId}`),
          op: "installSkills",
          input: { harness: binding.harness, references, cwd, ...(key ? { key } : {}) },
        },
        signal,
        epoch,
      );
      if (result?.failure) {
        const reason = result.failure.reason;
        if (
          typeof reason === "string" &&
          [
            ...PRIVATE_SKILL_FAILURES,
            "skillpack_credential_missing",
            "skillpack_credential_refused",
            "skillpack_skill_unavailable",
          ].includes(reason as never)
        )
          throw new PrivateSkillError(reason as ConstructorParameters<typeof PrivateSkillError>[0], "install");
        throw new PrivateSkillError("skillpack_install_state_invalid", "install");
      }
      if (!Array.isArray(result?.receipts) || result.receipts.length !== references.length)
        throw new PrivateSkillError("skillpack_receipt_invalid", "receipt");
      for (const [i, receipt] of result.receipts.entries()) {
        const reference = references[i],
          version = reference?.split("@")[1];
        if (
          !receipt ||
          receipt.reference !== reference ||
          receipt.version !== version ||
          typeof receipt.checksum !== "string" ||
          !/^sha256:[a-f0-9]{64}$/.test(receipt.checksum) ||
          typeof receipt.skillId !== "string" ||
          !/^[a-f0-9-]{36}$/.test(receipt.skillId) ||
          receipt.origin !== "https://skillpack.app/v1" ||
          (!reference?.includes("/") &&
            (typeof receipt.workspaceId !== "string" ||
              !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(receipt.workspaceId)))
        )
          throw new PrivateSkillError("skillpack_receipt_invalid", "receipt");
      }
      return result.receipts.map(({ reference, version, skillId, checksum, origin, workspaceId }) => ({
        reference,
        version,
        skillId,
        checksum,
        origin,
        ...(!reference.includes("/") && workspaceId ? { workspaceId } : {}),
      }));
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
      if (request.harness !== binding.harness || !request.text.trim()) throw refusal("invalid_request");
      const choice = resolveModelChoice(binding.harness, request, defaults);
      return invoke(
        {
          ...identity(requestId),
          op: "prompt",
          input: {
            sandboxId,
            harness: binding.harness,
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
    async steer(request: SteerRequest, requestId: string = randomUUID()): Promise<SteerReceipt> {
      target(request.sandboxId);
      if (!request.conversationId || !request.text.trim() || Buffer.byteLength(request.text) > 262144)
        throw refusal("invalid_request");
      const receipt = await invoke<SteerReceipt>({
        ...identity(requestId),
        op: "steer",
        conversationId: request.conversationId,
        text: request.text,
      });
      if (
        !receipt ||
        receipt.conversationId !== request.conversationId ||
        typeof receipt.promptId !== "string" ||
        !receipt.promptId
      )
        throw refusal("unavailable", requestId);
      return {
        conversationId: receipt.conversationId,
        promptId: receipt.promptId,
        ...(typeof receipt.mode === "string" ? { mode: receipt.mode } : {}),
      };
    },
    async interrupt(request: InterruptRequest, requestId: string = randomUUID()): Promise<void> {
      target(request.sandboxId);
      await invoke({
        ...identity(requestId),
        op: "interrupt",
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      });
    },
    async exec(request: ExecRequest, requestId: string = randomUUID()): Promise<ExecResult> {
      target(request.sandboxId);
      if (
        !request.command.trim() ||
        Buffer.byteLength(request.command) > 262144 ||
        request.detached ||
        (request.timeoutSeconds !== undefined &&
          (!Number.isInteger(request.timeoutSeconds) || request.timeoutSeconds < 1 || request.timeoutSeconds > 600))
      )
        throw refusal("invalid_request");
      const { signal, ...input } = request;
      const result = await invoke<ExecResult>(
        {
          ...identity(requestId),
          op: "exec",
          input: {
            ...input,
            sandboxId,
            command: request.command,
            cwd: request.cwd ?? cwd,
            timeoutSeconds: request.timeoutSeconds ?? 120,
          },
        },
        signal,
        undefined,
        ((request.timeoutSeconds ?? 120) + 30) * 1000,
      );
      if (
        result?.detached !== false ||
        (result.exitCode !== null && !Number.isInteger(result.exitCode)) ||
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string" ||
        typeof result.timedOut !== "boolean" ||
        typeof result.truncated !== "boolean"
      )
        throw refusal("unavailable", requestId);
      return {
        detached: false,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 65536),
        stderr: result.stderr.slice(0, 65536),
        timedOut: result.timedOut,
        truncated: result.truncated || result.stdout.length > 65536 || result.stderr.length > 65536,
      };
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
