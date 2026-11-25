import { sandboxOperations } from "@armada/core/contract";
import { LaunchError, ProviderError, redact, type SandboxStatus, VaultError } from "@armada/core/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { CREDENTIAL_BINDING_GUIDANCE } from "./credential-binding.ts";
import { DataError, type SandboxView, type ServerSandboxPatch } from "./data.ts";
import { mcpLaunchContract, runMcpLaunch } from "./mcp-launch-tool.ts";
import { DEFAULT_WAIT_SECONDS, registerListTool, registerLogsTool, registerStatusTools } from "./mcp-read-tools.ts";
import {
  requiresMissingMachineObservation,
  retainsDiskOnStop,
  runtimeBridgeTarget,
  usesRuntimeStopJob,
} from "./provider-runtime-admission.ts";
import { recordOperatorFailure } from "./request-observability.ts";
import { RuntimeCheckpointRejected } from "./runtime-checkpoint.ts";
import {
  RuntimeCheckpointActivityConflict,
  RuntimeCheckpointParentConflict,
  RuntimeReconciliationConflict,
  SandboxStopTargetChanged,
} from "./runtime-reconciliation-conflict.ts";
import { sandboxActivity } from "./sandbox-activity.ts";
import { refuseConversationSelector } from "./sandbox-conversation.ts";

import { ToolError } from "./tool-error.ts";
import { errorResult, unknownMutationOutcome } from "./tool-failure.ts";
import { createToolRegistration, type ToolBinding } from "./tool-registration.ts";
import type { ToolContext } from "./tools.ts";
import { isFailedModalLaunch, latestPrompt, readStatus } from "./turns.ts";
import { SANDBOX_ADMISSION_TIMEOUT_MS, waitForSandboxAdmission } from "./wake-bus.ts";
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
    if ((found.boatRuntime || found.modalTransport === "dialout") && !allowUnbound && !runtimeControl)
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
  const liveControl = async (args: { id: string; request_id?: unknown }) => {
    const target = await live(args.id, false, undefined, true);
    const enrolled = Boolean(target.sandbox.boatRuntime || target.sandbox.modalTransport === "dialout");
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
    const fenced =
      found.status === "deleted" ||
      found.status === "starting" ||
      isFailedModalLaunch(found) ||
      (found.status === "failed" && found.stoppedAt !== null);
    const jobReader = fenced ? null : await context.modalJobReader?.(found);
    const provider = fenced ? null : (jobReader ?? (await context.provider(found)));

    const target =
      found.taskPromptId === ""
        ? provider
          ? (await latestPrompt(provider, found.providerSandboxId, true))?.promptId
          : null
        : found.taskPromptId;
    const queued = jobReader ? await context.accountTurns?.status(caller, found.id, args.prompt_id) : undefined;
    const promptId = queued && "nativePromptId" in queued ? queued.nativePromptId : args.prompt_id;
    if (!target || target !== promptId)
      throw new ToolError("conflict", "Report only the latest finished turn, using its prompt id.");
    const report = await readStatus(provider, data.sandboxes, found, {
      promptId: target,
      now: context.now(),
    });
    await jobReader?.verify();
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
    await visible(args.id);
    if (!context.runtimeSend) throw new ToolError("unsupported", "Runtime follow-up is unavailable.");
    return context.runtimeSend(caller, args);
  }

  const sendTool = tool("send", sandboxOperations.sendPrompt.tool, sendSandbox, true);

  const steerTool = tool(
    "steer",
    sandboxOperations.steerSandbox.tool,
    async (args) => {
      const { sandbox: found, provider } = await liveControl(args);
      const delivery = provider.capabilities[found.harness]?.steer ?? "none";
      if (delivery === "none") throw new ToolError("unsupported", `${found.harness} cannot be steered here.`);
      const receipt = await provider
        .steer({
          sandboxId: found.providerSandboxId,
          ...(args.request_id ? { requestId: args.request_id } : {}),
          text: args.text,
        })
        .catch(unknownMutationOutcome);
      return { id: found.id, ...receipt, delivery, mode: receipt.mode ?? null };
    },
    true,
  );

  const interruptTool = tool(
    "interrupt",
    sandboxOperations.interruptSandbox.tool,
    async (args) => {
      const { sandbox: found, provider } = await liveControl(args);
      if (!provider.capabilities[found.harness]?.interrupt) {
        throw new ToolError("unsupported", `${found.harness} cannot be interrupted here.`);
      }
      await provider
        .interrupt({
          sandboxId: found.providerSandboxId,
          ...(args.request_id ? { requestId: args.request_id } : {}),
        })
        .catch(unknownMutationOutcome);
      return { id: found.id, interrupted: true };
    },
    true,
  );

  tool("exec", sandboxOperations.execSandbox.tool, async (args) => {
    const { sandbox: found, provider } = await liveControl(args);

    await data.sandboxes.assertExecAllowed?.(found.id);
    const result = await provider
      .exec({
        sandboxId: found.providerSandboxId,
        ...(args.request_id ? { requestId: args.request_id } : {}),
        command: args.command,
        cwd: args.cwd ?? "/home/user",
        timeoutSeconds: args.timeout_seconds ?? 120,
      })
      .catch(unknownMutationOutcome);
    if (result.detached)
      throw new ToolError(
        "outcome_unknown",
        "The command started in the background. Check sandbox status before retrying.",
      );
    try {
      const secrets = await context.exposedSecrets(found.orgId);
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
  });

  const stopTool = (() => {
    async function stopOnce(
      found: SandboxView,
      onlyIfIdle: boolean,
      checkpointState: { attempted: boolean },
      signal?: AbortSignal,
    ) {
      const canCheckIdle = found.status === "ready" || (found.status === "running" && runtimeBridgeTarget(found));
      if (onlyIfIdle && !canCheckIdle && found.status !== "stopped")
        throw new VaultError(
          "credential_binding_unsafe",
          "Wait for the running turn or lifecycle operation to finish before changing accounts.",
        );
      if (onlyIfIdle && canCheckIdle && !(await statusOf(found.id, undefined)).settled)
        throw new VaultError(
          "credential_binding_unsafe",
          "Wait for the current turn to finish before changing accounts.",
        );

      if (onlyIfIdle) {
        const startingStop = await data.sandboxes.requestStartingModalStop?.(found);
        if (startingStop) return startingStop;
      }
      if (found.stopRequestedAt || ["stopping", "stopped"].includes(found.status))
        return { id: found.id, status: found.status };
      if (found.status === "deleted") throw new ToolError("conflict", `Sandbox '${found.id}' is deleted.`);
      const provider = usesRuntimeStopJob(found.provider) ? undefined : (await live(found.id, true, found)).provider;
      signal?.throwIfAborted();
      const needsCheckpoint =
        found.ownerId === caller.userId &&
        runtimeBridgeTarget(found) &&
        ["ready", "running"].includes(found.status) &&
        Date.parse(found.expiresAt ?? "") > context.now().getTime();
      if (needsCheckpoint && !context.runtimeStopCheckpoint)
        throw new VaultError("unavailable", "Runtime stop checkpoint is unavailable.");
      const checkpoint = needsCheckpoint
        ? await context.runtimeStopCheckpoint!(caller, found, onlyIfIdle, signal).catch((error) => {
            if (error instanceof RuntimeCheckpointRejected) return null;
            recordOperatorFailure("sandbox.stop.checkpoint", error, { sandboxId: found.id });
            throw error;
          })
        : undefined;
      checkpointState.attempted = checkpoint !== undefined;
      if (!checkpointState.attempted) signal?.throwIfAborted();
      const stopAdmission: Pick<ServerSandboxPatch, "ownerStop" | "onlyIfIdle" | "ownerStopSignal"> = {
        ownerStop: true,
        onlyIfIdle,
        ...(signal && !checkpointState.attempted ? { ownerStopSignal: signal } : {}),
      };
      const retainedGuard: Pick<ServerSandboxPatch, "retainedRuntimeStop"> = checkpoint
        ? { retainedRuntimeStop: checkpoint.requestId }
        : {};
      if (!provider) {
        const status = found.status === "failed" ? "failed" : "stopping";
        await data.sandboxes.update(found.id, {
          ...stopAdmission,
          ...retainedGuard,
          status,
          stoppedAt: null,
          stopRequested: true,
          advanceGeneration: true,
          activityToken: crypto.randomUUID(),
          ...(found.statusReason === "expired" ? { statusReason: "expired" } : {}),
          ...(found.lifecycleGeneration !== undefined && { expectedGeneration: found.lifecycleGeneration }),
        });
        return { id: found.id, status } as const;
      }
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
              (!retainsDiskOnStop(provider.id) || observed.retainedSnapshot === "usable" || found.status === "failed");
            stoppedAt = observed.stoppedAt;
            preservationNote = observed.stopNote ?? preservationNote;
          } catch (error) {
            if (checkpoint || !(error instanceof ProviderError && error.code === "not_found")) throw error;
            terminal = !requiresMissingMachineObservation(provider.id);
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
    }

    return tool(
      "stop",
      sandboxOperations.stopSandbox.tool,
      async (args) => {
        const checkpoint = { attempted: false };
        if (args.only_if_idle) return stopOnce(await visible(args.id), true, checkpoint);
        context.configureStopRequest?.();
        const deadline = AbortSignal.timeout(SANDBOX_ADMISSION_TIMEOUT_MS);
        const signal = context.stopSignal ? AbortSignal.any([deadline, context.stopSignal]) : deadline;
        try {
          return await waitForSandboxAdmission(signal, async () => {
            const target = await data.sandboxes.getForStop?.(args.id);
            const found = target ? target.sandbox : await visible(args.id);
            signal.throwIfAborted();
            try {
              if (found.stopRequestedAt || ["stopping", "stopped", "deleted"].includes(found.status))
                return { busy: false, result: await stopOnce(found, false, checkpoint) };
              const startingStop = await data.sandboxes.requestStartingModalStop?.(found, signal);
              if (startingStop) return { busy: false, result: startingStop };
              if (target?.busy) return { busy: true };
              return { busy: false, result: await stopOnce(found, false, checkpoint, signal) };
            } catch (error) {
              const cause = error instanceof DataError ? error.cause : error;
              if (
                !checkpoint.attempted &&
                (cause instanceof RuntimeReconciliationConflict ||
                  cause instanceof RuntimeCheckpointActivityConflict ||
                  cause instanceof RuntimeCheckpointParentConflict ||
                  cause instanceof SandboxStopTargetChanged)
              )
                return { busy: true };
              throw error;
            }
          });
        } catch (error) {
          if (error === signal.reason)
            throw new ToolError("dependency_unavailable", "Sandbox stop admission ended before compute stop.");
          throw error;
        }
      },
      true,
    );
  })();

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
            "Request UUID. Reuse it with identical input after uncertain delivery.",
          ),
          [sendBranch.flag]: z
            .boolean()
            .optional()
            .describe("Redirect the running turn. Delivery is in-place or a restart in the same conversation."),
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
