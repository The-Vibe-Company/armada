import { sandboxOperations } from "@armada/core/contract";
import {
  LaunchError,
  type MemberRole,
  type Provider,
  ProviderError,
  redact,
  resolveModelChoice,
  type SandboxStatus,
  VaultError,
} from "@armada/core/server";
import { BoatRetentionUnconfirmed } from "@armada/provider-boat";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { CREDENTIAL_BINDING_GUIDANCE } from "./credential-binding.ts";
import type { SandboxView, ServerSandboxPatch } from "./data.ts";
import { mcpLaunchContract, runMcpLaunch } from "./mcp-launch-tool.ts";
import { DEFAULT_WAIT_SECONDS, registerListTool, registerLogsTool, registerStatusTools } from "./mcp-read-tools.ts";
import { runtimeBridgeTarget } from "./provider-runtime-admission.ts";
import { recordOperatorFailure } from "./request-observability.ts";
import { RuntimeCheckpointRejected } from "./runtime-checkpoint.ts";
import { appendConversation, sandboxActivity } from "./sandbox-activity.ts";
import { refuseConversationSelector } from "./sandbox-conversation.ts";

import { ToolError } from "./tool-error.ts";
import { errorResult, publicationFailure, unknownMutationOutcome } from "./tool-failure.ts";
import { createToolRegistration, type ToolBinding } from "./tool-registration.ts";
import type { ToolContext } from "./tools.ts";
import { collectSandboxUsage, latestPrompt, readStatus } from "./turns.ts";
import { stopAndObserve } from "./work-preservation.ts";

const OUTPUT_LIMIT = 20_000;

export function configureTools(
  context: ToolContext,
  surface: "mcp" | "rest",
  server?: McpServer,
  onlyTool?: "list",
  bind?: ToolBinding,
) {
  const { caller, data } = context;

  const visible = async (sandboxId: string) => {
    const found = await data.sandboxes.get(sandboxId);
    if (!found) throw new ToolError("not_found", `No sandbox with id '${sandboxId}' that you can see.`);
    return found;
  };
  const { register, tool } = createToolRegistration(server, context, surface, visible, bind);

  if (onlyTool === "list") {
    registerListTool(context, tool);
    return;
  }

  const live = async (sandboxId: string, allowUnbound = false, known?: SandboxView, runtimeControl = false) => {
    const found = known ?? (await visible(sandboxId));
    if ((found.boatRuntime || found.runtimeTransport === "dialout") && !allowUnbound && !runtimeControl)
      throw new ToolError(
        "unsupported",
        "Experimental runtime supports initial launch, reads and compute stop/delete only.",
      );
    if (found.status === "deleted") throw new ToolError("conflict", `Sandbox '${sandboxId}' is deleted.`);
    if (!allowUnbound && found.provider === "modal" && !found.credentialId)
      throw new VaultError("credential_binding_required", CREDENTIAL_BINDING_GUIDANCE);
    return {
      sandbox: found,
      provider: await context.provider(found),
    };
  };
  const turnCredentials = (found: SandboxView) =>
    context.launchCredentials.resolve(
      { userId: caller.userId, orgId: found.orgId, role: "member" },
      found.harness,
      found.credentialId ?? undefined,
      found.credentialVersion ?? undefined,
    );
  const prepareConnections = (provider: Provider, found: SandboxView, role: MemberRole) =>
    context.connections?.prepare?.(provider, found, { userId: caller.userId, orgId: found.orgId, role });
  const liveControl = async (args: { id: string; request_id?: unknown }) => {
    const target = await live(args.id, false, undefined, true);
    const enrolled = Boolean(target.sandbox.boatRuntime || target.sandbox.runtimeTransport === "dialout");
    if (args.request_id !== undefined && !enrolled)
      throw new ToolError("invalid_request", "request_id is supported only for runtime control.");
    if (enrolled && target.sandbox.ownerId !== caller.userId)
      throw new ToolError("forbidden", "Only the runtime owner may control this sandbox.");
    return { ...target, enrolled };
  };
  const measure: NonNullable<ToolContext["measure"]> = context.measure ?? ((_phase, work) => work());
  tool("launch", mcpLaunchContract, (input) => runMcpLaunch(context, input));

  registerListTool(context, tool);

  const { statusOf, readStatusTool, waitTool } = registerStatusTools(context, tool, visible, measure);

  registerLogsTool(context, tool, visible, surface);

  tool("report", sandboxOperations.reportSandbox.tool, async (args) => {
    const found = await visible(args.id);
    const provider =
      found.status === "deleted" ||
      found.status === "starting" ||
      (found.status === "failed" && found.stoppedAt !== null)
        ? null
        : await context.provider(found);

    const target =
      found.taskPromptId === ""
        ? provider
          ? (await latestPrompt(provider, found.providerSandboxId, true))?.promptId
          : null
        : found.taskPromptId;
    if (!target || target !== args.prompt_id)
      throw new ToolError("conflict", "Report only the latest finished turn, using its prompt id.");
    const report = await readStatus(provider, data.sandboxes, found, { promptId: target, now: context.now() });
    if (report.prompt?.state !== "finished")
      throw new ToolError("conflict", "Report only the latest finished turn, using its prompt id.");
    if (!data.sandboxes.reportTaskOutcome) throw new ToolError("conflict", "Task reporting is unavailable.");
    await data.sandboxes.reportTaskOutcome(args.id, found.taskPromptId!, args.outcome, found.lifecycleGeneration);
    return { id: args.id, taskOutcome: args.outcome };
  });

  async function sendSandbox(args: import("./runtime-followup.ts").RuntimeFollowupInput) {
    if (context.accountTurns) {
      const queued = await context.accountTurns.accept(caller, args);
      if (queued) return queued;
    }
    return dispatchSandbox(args);
  }

  async function dispatchSandbox(args: import("./runtime-followup.ts").RuntimeFollowupInput) {
    const routed = await context.dockerControls?.invoke(caller, "send", { ...args });
    if (routed?.handled) return routed.result as import("@armada/core").PromptReceipt & { id: string };
    const selected = await visible(args.id);
    if (selected.boatRuntime || selected.runtimeTransport === "dialout") {
      if (!context.runtimeSend) throw new ToolError("unsupported", "Runtime follow-up is unavailable.");
      return context.runtimeSend(caller, args);
    }

    if (
      (selected.statusReason === "idle_paused" || selected.statusReason === "work_merged") &&
      (selected.status === "stopping" ||
        !selected.expiresAt ||
        Date.parse(selected.expiresAt) <= context.now().getTime())
    )
      throw new ToolError(
        "conflict",
        "Idle pause or merge stop is still finishing or its original deadline has expired; inspect status before sending.",
      );
    const { sandbox: found, provider } = await live(args.id, false, selected);
    if (args.prompt.trim() === "") throw new ToolError("invalid_request", "The prompt is empty.");
    let pricingContext: unknown;
    if (found.credentialId)
      pricingContext = (await measure("send_credentials", () => turnCredentials(found))).usagePricing ?? null;
    if (data.sandboxes.captureUsagePricingContext)
      pricingContext = (await data.sandboxes.captureUsagePricingContext(found.id)) ?? pricingContext;
    const stored =
      found.model !== null && found.reasoningEffort !== null
        ? { model: found.model, reasoningEffort: found.reasoningEffort }
        : undefined;

    const choice =
      args.model === undefined && args.reasoning_effort === undefined
        ? stored
        : resolveModelChoice(found.harness, { model: args.model, reasoningEffort: args.reasoning_effort }, stored);
    const conversation = found.conversationIds.at(-1);
    const machine = await measure("send_state", () => provider.get(found.providerSandboxId));
    if (provider.id === "boat" && machine.state === "stopped" && machine.retainedSnapshot !== "usable")
      throw new ToolError("conflict", "Boat retained data has not been verified.");
    if (machine.state === "stopped" && found.stoppedAt === null) {
      await data.sandboxes.update(found.id, {
        status: "stopped",
        stoppedAt: (machine.stoppedAt ?? context.now()).toISOString(),
        ...(found.lifecycleGeneration === undefined ? {} : { expectedGeneration: found.lifecycleGeneration }),
        providerObservation: { fromState: found.status, providerRunPlacement: found.providerSandboxId },
      });
    }
    await measure("send_turn_auth", async () =>
      context.launchCredentials.assertTurn?.(
        { userId: found.ownerId, orgId: found.orgId, role: "member" },
        found.id,
        machine.state === "stopped",
      ),
    );
    const generation = found.lifecycleGeneration;
    let acknowledged = false;
    const admission: Pick<ServerSandboxPatch, "nativeResumeAdmission" | "nativeSendAdmission"> =
      machine.state === "stopped"
        ? { nativeResumeAdmission: found.providerSandboxId }
        : { nativeSendAdmission: { fromState: found.status, placement: found.providerSandboxId } };
    return sandboxActivity(
      data.sandboxes,
      found,
      {
        clearTaskOutcome: true,
        ...(args.request_id ? { queueRequestId: args.request_id } : {}),
        renewLifecycle: machine.state === "stopped" && found.statusReason !== "idle_paused",
        stopRequested: false,
        ...admission,
      },
      async (signal, activityToken) => {
        let activationOpened = machine.state === "stopped";
        let admissionFailure: { error: unknown } | undefined;
        const receipt = await measure("send_submit", () =>
          provider
            .prompt({
              sandboxId: found.providerSandboxId,
              harness: found.harness,
              text: args.prompt,
              signal,
              ...(conversation ? { conversationId: conversation } : {}),
              ...(choice ?? {}),
              ...(generation !== undefined
                ? {
                    onResumeStage: async (stage) => {
                      try {
                        if (stage === "accepted") {
                          if (!activationOpened) {
                            await data.sandboxes.update(found.id, {
                              nativeResumeAdmission: found.providerSandboxId,
                              renewActivity: true,
                              activityToken,
                              expectedGeneration: generation + 1,
                            });
                            activationOpened = true;
                          }
                        } else if (activationOpened) {
                          await data.sandboxes.recordLaunchStage?.(found.id, stage, 0, generation + 1);
                        }
                      } catch (error) {
                        if (stage === "accepted") {
                          admissionFailure = { error };
                          throw error;
                        }
                      }
                    },
                  }
                : {}),
            })
            .catch(async (error: unknown) => {
              if (admissionFailure) throw admissionFailure.error;
              if (error instanceof BoatRetentionUnconfirmed && generation !== undefined) {
                await data.sandboxes.update(found.id, {
                  nativeRetentionRefusal: found.providerSandboxId,
                  activityToken,
                  expectedGeneration: generation + 1,
                });
              }
              return unknownMutationOutcome(error);
            }),
        );
        acknowledged = true;
        await data.sandboxes.recordNativePrompt?.(found.id, found.providerSandboxId, receipt.promptId, args.request_id);
        try {
          await data.sandboxes.recordTurnModel?.(found.id, receipt.promptId, choice?.model ?? null, pricingContext);
        } catch (error) {
          recordOperatorFailure("tool.send.turn_model_record", error, {
            sandboxId: found.id,
            ...(context.logError ? { log: context.logError } : {}),
          });
        }
        const conversationIds = appendConversation(found.conversationIds, receipt.conversationId);
        return {
          patch: {
            nativeSendReceipt: {
              fromState: activationOpened ? "starting" : found.status,
              placement: found.providerSandboxId,
              ...(args.request_id ? { requestId: args.request_id } : {}),
            },
            taskPromptId: receipt.promptId,
            statusReason: null,
            conversationIds,
            stoppedAt: null,
            rearmDeadline: receipt.resumed === true && found.statusReason !== "idle_paused",
          } satisfies ServerSandboxPatch,
          result: {
            id: found.id,
            promptId: receipt.promptId,
            conversationId: receipt.conversationId,
            status: receipt.status,
          },
        };
      },
    )
      .catch((error) => publicationFailure(error, acknowledged))
      .finally(() => context.launchCredentials.releaseAdmission?.(found.id));
  }

  const sendTool = tool("send", sandboxOperations.sendPrompt.tool, sendSandbox, true);

  const steerTool = tool(
    "steer",
    sandboxOperations.steerSandbox.tool,
    async (args) => {
      const { sandbox: found, provider, enrolled } = await liveControl(args);
      const delivery = provider.capabilities[found.harness]?.steer ?? "none";
      if (delivery === "none") throw new ToolError("unsupported", `${found.harness} cannot be steered here.`);
      if (!enrolled && delivery === "restart" && found.credentialId) await turnCredentials(found);
      const conversationId = enrolled ? undefined : found.conversationIds.at(-1);
      const dispatchSteer = () =>
        provider
          .steer({
            sandboxId: found.providerSandboxId,
            ...(args.request_id ? { requestId: args.request_id } : {}),
            text: args.text,
            ...(conversationId ? { conversationId } : {}),
          })
          .catch(unknownMutationOutcome);
      if (enrolled) {
        const receipt = await dispatchSteer();
        return { id: found.id, ...receipt, delivery, mode: receipt.mode ?? null };
      }
      const member = caller.orgs.find((entry) => entry.orgId === found.orgId);
      if (!member) throw new ToolError("forbidden", "No current organization membership.");
      let acknowledged = false;
      return sandboxActivity(
        data.sandboxes,
        found,
        { clearTaskOutcome: true },
        async (signal) => {
          await prepareConnections(provider, found, member.role);

          const receipt = await dispatchSteer();
          acknowledged = true;

          const taskPromptId = await steeredRun(provider, found, receipt.promptId, delivery, signal);
          if (taskPromptId) await data.sandboxes.recordNativePrompt?.(found.id, found.providerSandboxId, taskPromptId);
          else await data.sandboxes.recordPendingSteer?.(found.id, found.providerSandboxId, found.taskPromptId || null);
          return {
            patch: {
              nativeSteerReceipt: { fromState: found.status, placement: found.providerSandboxId },
              statusReason: null,
              taskPromptId,
              conversationIds: appendConversation(found.conversationIds, receipt.conversationId),
            } satisfies ServerSandboxPatch,
            result: {
              id: found.id,
              promptId: receipt.promptId,
              conversationId: receipt.conversationId,
              delivery,
              mode: receipt.mode ?? null,
            },
          };
        },
        {
          failurePatch(error) {
            if (
              error instanceof ProviderError &&
              [
                "no_running_turn",
                "invalid_request",
                "unauthorized",
                "forbidden",
                "not_found",
                "provider_not_configured",
                "sandbox_not_ready",
              ].includes(error.code)
            )
              return {};
            throw error;
          },
        },
      ).catch((error) => publicationFailure(error, acknowledged));
    },
    true,
  );

  const interruptTool = tool(
    "interrupt",
    sandboxOperations.interruptSandbox.tool,
    async (args) => {
      const { sandbox: found, provider, enrolled } = await liveControl(args);
      if (!provider.capabilities[found.harness]?.interrupt) {
        throw new ToolError("unsupported", `${found.harness} cannot be interrupted here.`);
      }
      const conversationId = enrolled ? undefined : found.conversationIds.at(-1);
      await provider
        .interrupt({
          sandboxId: found.providerSandboxId,
          ...(args.request_id ? { requestId: args.request_id } : {}),
          ...(conversationId ? { conversationId } : {}),
        })
        .catch(unknownMutationOutcome);
      return { id: found.id, interrupted: true };
    },
    true,
  );

  tool("exec", sandboxOperations.execSandbox.tool, async (args) => {
    const { sandbox: found, provider, enrolled } = await liveControl(args);

    await data.sandboxes.assertExecAllowed?.(found.id);
    const nativeBoat = !enrolled && found.provider === "boat";
    const managedNative =
      !enrolled &&
      (await context.launchCredentials.assertExec?.(
        { userId: found.ownerId, orgId: found.orgId, role: "member" },
        found.id,
      ));
    let acknowledged = false;
    const execute = async (signal?: AbortSignal) => {
      const membership = caller.orgs.find((member) => member.orgId === found.orgId);
      if (!membership) throw new ToolError("forbidden", "No current organization membership.");
      if (!enrolled) await prepareConnections(provider, found, membership.role);
      const nativeActor = { userId: found.ownerId, orgId: found.orgId, role: "member" as const };
      const readNativeSecrets = (phase: "before" | "after") =>
        context.launchCredentials.nativeSecrets?.(nativeActor, found.id, provider, found.providerSandboxId, phase);
      const nativeBefore = (!enrolled && (await readNativeSecrets("before"))) || [];
      signal?.throwIfAborted();
      const result = await provider
        .exec({
          sandboxId: found.providerSandboxId,
          ...(args.request_id ? { requestId: args.request_id } : {}),
          ...(signal ? { signal } : {}),
          command: args.command,
          cwd: args.cwd ?? "/home/user",
          timeoutSeconds: args.timeout_seconds ?? 120,
        })
        .catch(unknownMutationOutcome);
      acknowledged = true;
      if (result.detached)
        throw new ToolError(
          "outcome_unknown",
          "The command started in the background. Check sandbox status before retrying.",
        );
      try {
        const nativeAfter = (!enrolled && (await readNativeSecrets("after"))) || [];
        const secrets = [...(await context.exposedSecrets(found.orgId)), ...nativeBefore, ...nativeAfter];
        const clip = (text: string) => {
          const safe = redact(text, secrets);
          return safe.length <= OUTPUT_LIMIT ? safe : `...${safe.slice(-OUTPUT_LIMIT)}`;
        };
        return {
          id: found.id,
          exitCode: result.exitCode,
          stdout: clip(result.stdout),
          stderr: clip(result.stderr),
          timedOut: result.timedOut,
          truncated: result.truncated || result.stdout.length > OUTPUT_LIMIT || result.stderr.length > OUTPUT_LIMIT,
        };
      } catch (error) {
        throw new LaunchError(
          "outcome_unknown",
          "The command ran but its result could not be safely published. Check sandbox status before retrying.",
          { cause: error },
        );
      }
    };
    if (!nativeBoat && !managedNative) {
      return execute();
    }

    const admission: ServerSandboxPatch = nativeBoat ? { nativeBoatExecAdmission: true } : {};
    return sandboxActivity(
      data.sandboxes,
      found,
      admission,
      async (signal) => {
        signal.throwIfAborted();
        const result = await execute(nativeBoat ? signal : undefined);
        signal.throwIfAborted();
        return { result, patch: {} };
      },
      { deadlineMs: ((args.timeout_seconds ?? 120) + 60) * 1000 },
    ).catch((error) => publicationFailure(error, acknowledged));
  });

  const stopTool = tool(
    "stop",
    sandboxOperations.stopSandbox.tool,
    async (args) => {
      const found = await visible(args.id);
      const canCheckIdle = found.status === "ready" || (found.status === "running" && runtimeBridgeTarget(found));
      if (args.only_if_idle && !canCheckIdle && found.status !== "stopped")
        throw new VaultError(
          "credential_binding_unsafe",
          "Wait for the running turn or lifecycle operation to finish before changing accounts.",
        );
      if (args.only_if_idle && canCheckIdle && !(await statusOf(args.id, undefined)).settled)
        throw new VaultError(
          "credential_binding_unsafe",
          "Wait for the current turn to finish before changing accounts.",
        );

      if (found.stopRequestedAt || ["stopping", "stopped"].includes(found.status))
        return { id: found.id, status: found.status };
      const { provider } = await live(args.id, true, found);
      const needsCheckpoint =
        found.ownerId === caller.userId &&
        runtimeBridgeTarget(found) &&
        ["ready", "running"].includes(found.status) &&
        Date.parse(found.expiresAt ?? "") > context.now().getTime();
      if (needsCheckpoint && !context.runtimeStopCheckpoint)
        throw new VaultError("unavailable", "Runtime stop checkpoint is unavailable.");
      const checkpoint = needsCheckpoint
        ? await context.runtimeStopCheckpoint!(caller, found, args.only_if_idle === true).catch((error) => {
            if (error instanceof RuntimeCheckpointRejected) return null;
            throw error;
          })
        : undefined;
      const stopAdmission: Pick<ServerSandboxPatch, "ownerStop" | "onlyIfIdle"> = {
        ownerStop: true,
        onlyIfIdle: args.only_if_idle === true,
      };
      const retainedGuard: Pick<ServerSandboxPatch, "retainedRuntimeStop"> = checkpoint
        ? { retainedRuntimeStop: checkpoint.requestId }
        : {};
      return sandboxActivity(
        data.sandboxes,
        found,
        {
          ...stopAdmission,
          ...retainedGuard,
          status: found.status === "failed" ? "failed" : "stopping",
          stoppedAt: null,
          stopRequested: true,
          ...(found.statusReason === "expired" ? { statusReason: "expired" } : {}),
        },
        async (signal, token) => {
          signal.throwIfAborted();

          const preservation = await data.sandboxes
            .preserveWork?.(found.id, provider, found.providerSandboxId, {
              kind: "activity",
              token,
              generation: found.lifecycleGeneration === undefined ? undefined : found.lifecycleGeneration + 1,
              signal,
            })
            .catch(() => "pending" as const);
          signal.throwIfAborted();
          if (preservation === "pending")
            return {
              result: {
                id: found.id,
                status: found.status === "failed" ? ("failed" as const) : ("stopping" as const),
              },
              patch: {
                ownerStop: true as const,
                status: found.status === "failed" ? ("failed" as const) : ("stopping" as const),
                stopRequested: true,
              },
            };
          let terminal = false;
          let stoppedAt: Date | undefined;
          let preservationNote =
            checkpoint === null ? "Runtime checkpoint was refused. No resumable checkpoint was recorded." : undefined;
          try {
            if (provider.collectTurnUsage) await collectSandboxUsage(provider, data.sandboxes, found);
            signal.throwIfAborted();
            const observed = await stopAndObserve(
              provider,
              found.id,
              found.providerSandboxId,
              "user_stop",
              signal,
              Boolean(checkpoint),
            );
            terminal =
              observed.state === "stopped" &&
              (provider.id !== "boat" || observed.retainedSnapshot === "usable" || found.status === "failed");
            stoppedAt = observed.stoppedAt;
            preservationNote = observed.stopNote ?? preservationNote;
          } catch (error) {
            if (checkpoint || !(error instanceof ProviderError && error.code === "not_found")) throw error;
            terminal = provider.id !== "boat";
          }
          signal.throwIfAborted();
          const status: SandboxStatus =
            found.status === "failed" || preservationNote === "checkpoint_failed_disk_not_retained"
              ? "failed"
              : terminal
                ? "stopped"
                : "stopping";
          return {
            result: { id: found.id, status, ...(preservationNote ? { preservationNote } : {}) },
            patch: {
              ownerStop: true as const,
              status,
              stopRequested: !terminal,
              ...(status === "failed" || found.statusReason === "expired" ? { statusReason: found.statusReason } : {}),
              ...(terminal
                ? {
                    stoppedAt: (stoppedAt ?? context.now()).toISOString(),
                  }
                : {}),
            },
          };
        },
      );
    },
    true,
  );

  if (surface === "mcp") {
    const { sendPrompt, sandboxStatus, stopSandbox } = sandboxOperations;
    const { mcpBranch: sendBranch } = sendPrompt;
    const { mcpBranch: statusBranch } = sandboxStatus;
    const { mcpBranch: stopBranch } = stopSandbox;
    const branchHandlers = { steerSandbox: steerTool, waitSandbox: waitTool, interruptSandbox: interruptTool };
    const steer = branchHandlers[sendBranch.operation];
    const wait = branchHandlers[statusBranch.operation];
    const interrupt = branchHandlers[stopBranch.operation];
    register(
      "send",
      {
        title: sendTool.title,
        description: sendTool.description,
        input: z.looseObject({
          ...sendTool.input,
          request_id: sendTool.input.request_id.describe(
            "Required for runtime follow-up. Optional for runtime steer. Reuse with identical input after uncertain delivery. " +
              "Native send accepts the field without deduplication. Omit it for native steer.",
          ),
          [sendBranch.flag]: z
            .boolean()
            .optional()
            .describe("Redirect the running turn. Delivery is native or a restart in the same conversation."),
        }),
        output: {
          ...sendTool.output,
          status: sendTool.output.status.optional(),
          delivery: steer.output.delivery.optional(),
          mode: steer.output.mode.optional(),
        },
      },
      async ({ [sendBranch.flag]: shouldSteer, id, prompt, request_id, model, reasoning_effort, ...extra }) => {
        try {
          refuseConversationSelector(extra);
        } catch (error) {
          return errorResult(error, "send", context.logError ?? console.error);
        }
        if (!shouldSteer) return sendTool.invoke({ id, prompt, request_id, model, reasoning_effort });
        if (model !== undefined || reasoning_effort !== undefined)
          return invalidToolInput("send", "Model and effort overrides require a new turn.");
        return steer.invoke({ id, text: prompt, request_id });
      },
    );

    register(
      "status",
      {
        ...readStatusTool,
        input: {
          ...readStatusTool.input,
          timeout_seconds: wait.input.timeout_seconds,
          [statusBranch.flag]: z.boolean().optional().describe("Wait for settlement. Default timeout: 60 seconds."),
        },
        output: { ...readStatusTool.output, timedOut: wait.output.timedOut.optional() },
      },
      async ({ [statusBranch.flag]: shouldWait, timeout_seconds, ...args }) => {
        if (!shouldWait && timeout_seconds !== undefined)
          return invalidToolInput("status", "timeout_seconds requires wait.");
        if (shouldWait && args.recorded !== undefined)
          return invalidToolInput("status", "Waiting uses the live turn state. Omit recorded.");
        return shouldWait ? wait.invoke({ ...args, timeout_seconds }) : readStatusTool.invoke(args);
      },
    );

    register(
      "stop",
      {
        ...stopTool,
        input: z.strictObject({
          ...stopTool.input,
          [stopBranch.flag]: z.boolean().optional().describe("Interrupt the turn without stopping the sandbox."),
          after: z.boolean().optional().describe("Wait for settlement before attempting an idle-only stop."),
          timeout_seconds: waitTool.input.timeout_seconds,
        }),
        output: {
          ...stopTool.output,
          status: stopTool.output.status.optional(),
          interrupted: interrupt.output.interrupted.optional(),
          timedOut: waitTool.output.timedOut.optional(),
        },
      },
      async ({ [stopBranch.flag]: shouldInterrupt, after, timeout_seconds, ...args }) => {
        if (!after && timeout_seconds !== undefined) return invalidToolInput("stop", "timeout_seconds requires after.");
        if (after && (shouldInterrupt || args.only_if_idle !== undefined))
          return invalidToolInput("stop", "Use after without turn or only_if_idle.");
        if (shouldInterrupt && args.only_if_idle) return invalidToolInput("stop", "Use turn without only_if_idle.");
        if (after) {
          const seconds = timeout_seconds ?? DEFAULT_WAIT_SECONDS;
          const deadline = context.now().getTime() + seconds * 1000;
          const waited = await waitTool.invoke({ id: args.id, timeout_seconds: seconds });
          if (waited.isError || !waited.structuredContent) return waited;
          if (waited.structuredContent.timedOut || context.now().getTime() >= deadline) {
            const result = { id: args.id, status: waited.structuredContent.status, timedOut: true };
            return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
          }
          return stopTool.invoke({ ...args, only_if_idle: true });
        }
        return shouldInterrupt ? interrupt.invoke({ id: args.id, request_id: args.request_id }) : stopTool.invoke(args);
      },
    );
  }

  function invalidToolInput(name: string, message: string) {
    return errorResult(new ToolError("invalid_request", message), name, context.logError ?? console.error);
  }
}

async function steeredRun(
  provider: Provider,
  found: { providerSandboxId: string; taskPromptId?: string | null },
  promptId: string,
  delivery: "native" | "restart",
  signal: AbortSignal,
) {
  try {
    const run = await provider.getPrompt({ sandboxId: found.providerSandboxId, promptId, signal });
    if (run.promptId === promptId) return promptId;
  } catch {}

  if (!found.taskPromptId) return "";
  try {
    const latest = (await latestPrompt(provider, found.providerSandboxId, true, signal))?.promptId;
    if (latest && (delivery === "native" || latest !== found.taskPromptId)) return latest;
  } catch {}
  return "";
}
