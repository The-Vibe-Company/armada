import {
  LaunchError,
  type LaunchOptions,
  type LaunchStores,
  type MemberRole,
  MODEL_CATALOG,
  type Provider,
  ProviderError,
  type ProviderTarget,
  redact,
  resolveModelChoice,
  type SandboxProviderId,
  type SandboxStatus,
  type SkillDefaultsService,
  VaultError,
} from "@armada/core/server";
import { BoatRetentionUnconfirmed } from "@armada/provider-boat";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import type { Caller } from "./caller.ts";
import { CREDENTIAL_BINDING_GUIDANCE } from "./credential-binding.ts";
import type { SandboxView, ScopedData, ServerSandboxPatch } from "./data.ts";
import type { GoldenLaunchCredentials } from "./launch-account-admission.ts";
import { mcpLaunchContract, runMcpLaunch } from "./mcp-launch-tool.ts";
import { DEFAULT_WAIT_SECONDS, registerListTool, registerLogsTool, registerStatusTools } from "./mcp-read-tools.ts";
import type { createOrdinaryLaunchReceipts } from "./ordinary-launch-receipts.ts";
import { recordOperatorFailure } from "./request-observability.ts";
import type { RuntimeFollowup } from "./runtime-followup.ts";
import { appendConversation, sandboxActivity } from "./sandbox-activity.ts";
import { refuseConversationSelector } from "./sandbox-conversation.ts";
import { sandboxIdInput as id, SANDBOX_STATUSES, statusOutput, taskOutcome } from "./sandbox-tool-schemas.ts";
import { ToolError } from "./tool-error.ts";
import { errorResult, publicationFailure, unknownMutationOutcome } from "./tool-failure.ts";
import { createToolRegistration } from "./tool-registration.ts";
import { collectSandboxUsage, latestPrompt, readStatus } from "./turns.ts";
import { stopAndObserve } from "./work-preservation.ts";

/** Everything a tool call may use, for one authenticated request. */
export interface ToolContext {
  accountTurns?: import("./account-turn-queue.ts").AccountTurnQueue;
  sandboxBillingAccount?: (id: string) => Promise<import("./sandbox-billing-account.ts").SandboxBillingAccount | null>;
  dockerControls?: import("./docker-sandbox-controls.ts").DockerSandboxControls;
  runtimeSend?: RuntimeFollowup;
  measure?: import("./request-timing.ts").RequestTiming["measure"];
  storedProviders?: Partial<Record<SandboxProviderId, ToolContext["provider"]>>;
  skillDefaults?: SkillDefaultsService;
  caller: Caller;
  data: ScopedData;
  /** The launch's credentials: the caller's own for the harness, else the golden's org's. Decrypted in this process. */
  launchCredentials: GoldenLaunchCredentials;
  /** The caller's own and one org's model credentials, decrypted, for redacting command output. */
  exposedSecrets(orgId: string): Promise<string[]>;
  /** A provider paying with the boat.dev key of a golden of this org and visibility. The key never leaves the server. */
  /** The provider of a golden's or a sandbox's own backend (see `ProviderRegistry`). Its key never leaves the server. */
  provider(target: ProviderTarget): Promise<Provider>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  launch?: LaunchOptions;
  ordinaryLaunchReceipts?: ReturnType<typeof createOrdinaryLaunchReceipts>;
  connections?: LaunchStores["connections"];
  /** Where the real cause of an internal or unavailable tool error goes, redacted. Defaults to stderr. */
  logError?: (line: string) => void;
}

const OUTPUT_LIMIT = 20_000;

export const serverInfo = { name: "armada" } as const;

const modelCatalogText = Object.entries(MODEL_CATALOG)
  .map(
    ([harness, entry]) =>
      `${harness}: ${entry.models.map((option) => `${option.id} (${option.reasoningEfforts.join("|")})`).join(", ")}; ` +
      `default ${entry.defaultModel} ${entry.defaultReasoningEffort}`,
  )
  .join(". ");
const modelInput = z.string().min(1).optional().describe(`The model, by id. ${modelCatalogText}.`);
const effortInput = z.string().min(1).optional().describe("The reasoning effort; one the model accepts (see model).");
/** One MCP server per request: the principal is fixed for its whole life, and nothing outlives the request. */
export function createArmadaServer(context: ToolContext, version: string) {
  return createToolServer(context, version, "mcp");
}

/** In-memory REST dispatch and schema discovery. Never exposed on the MCP transport. */
export function createRestToolServer(context: ToolContext, version: string, onlyTool?: "list") {
  return createToolServer(context, version, "rest", onlyTool);
}

function createToolServer(
  context: ToolContext,
  version: string,
  surface: "mcp" | "rest",
  onlyTool?: "list",
): McpServer {
  const server = new McpServer(
    { ...serverInfo, version },
    {
      instructions:
        "Armada launches Claude Code, Codex and OpenCode agents in sandboxes. " +
        "Provider and agent availability depend on server configuration. In these tools, a golden is a snapshot. " +
        "Find a golden with the dashboard or POST /api/v1/golden/list. Then launch with a prompt, use status, and use logs to read " +
        "what the agent did, send for the next instruction, and stop when done. Ids are Armada sandbox ids.",
    },
  );
  const { caller, data } = context;

  const visible = async (sandboxId: string): Promise<SandboxView> => {
    const found = await data.sandboxes.get(sandboxId);
    if (!found) throw new ToolError("not_found", `No sandbox with id '${sandboxId}' that you can see.`);
    return found;
  };
  const { register, tool } = createToolRegistration(server, context, surface, visible);

  // HTTP list calls keep the same handler and SDK validation without building unrelated tools.
  if (onlyTool === "list") {
    registerListTool(context, tool);
    return server;
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

  tool(
    "report",
    {
      title: "Report a task outcome",
      description: `Explicit result for the latest finished turn. Call after ${surface === "rest" ? "wait" : "status confirms settlement"}; never inferred from message text. A new send clears it. Only the sandbox owner or current org admin may report or read it.`,
      input: { id, prompt_id: z.string().min(1), outcome: taskOutcome },
      output: { id: z.string(), taskOutcome },
    },
    async (args) => {
      const found = await visible(args.id);
      const provider =
        found.status === "deleted" ||
        found.status === "starting" ||
        (found.status === "failed" && found.stoppedAt !== null)
          ? null
          : await context.provider(found);
      // Empty is a successful-steer marker, not a provider run ID. Null remains
      // unreportable after an ambiguous admission or for legacy rows.
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
    },
  );

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
    // One send shape across placements. Native providers do not implement a
    // durable request-key protocol; accepting this field promises no deduplication.
    // A merge stop runs the same irreversible idle checkpoint as an idle pause.
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
    // Recorded defaults bypass today's catalog; an override applies to this turn only.
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
    return sandboxActivity(
      data.sandboxes,
      found,
      {
        clearTaskOutcome: true,
        ...(args.request_id ? { queueRequestId: args.request_id } : {}),
        renewLifecycle: machine.state === "stopped" && found.statusReason !== "idle_paused",
        stopRequested: false,
        ...(machine.state === "stopped" ? { status: "starting" as const, stoppedAt: null } : {}),
      },
      async (signal, activityToken) => {
        let activationOpened = machine.state === "stopped";
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
                          // The provider can discover a stop after the initial state read.
                          // Open that activation while this send still owns the same lease.
                          if (!activationOpened) {
                            await data.sandboxes.update(found.id, {
                              status: "starting",
                              stoppedAt: null,
                              renewActivity: true,
                              activityToken,
                              expectedGeneration: generation + 1,
                            });
                            activationOpened = true;
                          }
                        } else if (activationOpened) {
                          await data.sandboxes.recordLaunchStage?.(found.id, stage, 0, generation + 1);
                        }
                      } catch {
                        // Timing is optional and must not affect native prompt admission.
                      }
                    },
                  }
                : {}),
            })
            .catch(async (error: unknown) => {
              if (error instanceof BoatRetentionUnconfirmed && generation !== undefined) {
                await data.sandboxes.update(found.id, {
                  status: "stopping",
                  stoppedAt: null,
                  stopRequested: true,
                  finishActivity: true,
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
          // The accepted prompt continues; the structured line carries the request and sandbox IDs.
          recordOperatorFailure("tool.send.turn_model_record", error, {
            sandboxId: found.id,
            ...(context.logError ? { log: context.logError } : {}),
          });
        }
        const conversationIds = appendConversation(found.conversationIds, receipt.conversationId);
        return {
          patch: {
            status: "running",
            taskPromptId: receipt.promptId,
            statusReason: null,
            conversationIds,
            stoppedAt: null,
            rearmDeadline: receipt.resumed === true && found.statusReason !== "idle_paused",
          },
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

  const sendTool = tool(
    "send",
    {
      title: "Send a prompt",
      description:
        "Gives the agent its next instruction as a new turn. The first send of an idle sandbox opens its " +
        "conversation and later sends continue it. Launch another sandbox for a separate conversation. To redirect a turn that is " +
        "still running, use steer. The turn runs with the model and effort chosen at launch; model and " +
        "reasoning_effort override them for this turn only. Experimental runtime follow-up requires request_id, " +
        "an empty ready sandbox, existing conversation, or verified empty checkpoint; retained idle pauses wake automatically before expiry. Preserved stopped Boat/Modal sandboxes resume on send; terminal sandboxes refuse controls with recovery guidance. Model/effort remain pinned to launch.",
      input: {
        id,
        request_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Required for runtime follow-up; reuse with identical input after uncertain delivery. Native providers accept the field for compatibility only; they do not deduplicate.",
          ),
        prompt: z.string().min(1).describe("The instruction."),
        model: modelInput,
        reasoning_effort: effortInput,
      },
      output: {
        id: z.string(),
        requestId: z.string().optional(),
        runtime: z.object({ kind: z.literal("armada"), epoch: z.string() }).optional(),
        promptId: z.string(),
        conversationId: z.string(),
        status: z.enum(["queued", "running", "finished", "failed", "interrupted"]),
        statusMessage: z.string().optional(),
      },
    },
    sendSandbox,
    true,
  );

  const steerTool = tool(
    "steer",
    {
      title: "Steer the running turn",
      description:
        "Redirects the turn that is running now. delivery says how: native joins the turn (Claude Code); " +
        "restart interrupts it and continues the same conversation with this text (Codex). Refused when no " +
        "turn runs: use send then.",
      input: {
        id,
        text: z.string().min(1),
        request_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Optional durable runtime request ID (runtime sandboxes only); reuse identical input after uncertain delivery.",
          ),
      },
      output: {
        id: z.string(),
        promptId: z.string(),
        conversationId: z.string(),
        delivery: z.enum(["native", "restart"]),
        mode: z.string().nullable(),
      },
    },
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
          // Register the concrete run like send does, so native settlement (and
          // its Langfuse export) sees the steered turn. Empty stays the marker
          // when the run cannot be proven yet; report then resolves it from events,
          // and the recovery worker uses a durable steer cursor to register it.
          const taskPromptId = await steeredRun(provider, found, receipt.promptId, delivery, signal);
          if (taskPromptId) await data.sandboxes.recordNativePrompt?.(found.id, found.providerSandboxId, taskPromptId);
          else await data.sandboxes.recordPendingSteer?.(found.id, found.providerSandboxId, found.taskPromptId || null);
          return {
            patch: {
              status: "running",
              taskPromptId,
              conversationIds: appendConversation(found.conversationIds, receipt.conversationId),
            },
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
            // A definite refusal admitted no work, so the next send need not wait
            // for lease expiry. Unknown/transport errors retain the bounded lease.
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
    {
      title: "Interrupt the running turn",
      description: "Interrupts the sandbox's running turn. The sandbox stays up for the next send.",
      input: {
        id,
        request_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Optional durable runtime request ID (runtime sandboxes only); reuse identical input after uncertain delivery.",
          ),
      },
      output: { id: z.string(), interrupted: z.boolean() },
    },
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

  tool(
    "exec",
    {
      title: "Run a command",
      description:
        "Runs a shell command in the sandbox (cwd /home/user by default) and returns its output. Output that " +
        "contains the agent's credentials is redacted. Use it to inspect the repos, not to drive the agent.",
      input: {
        id,
        request_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Optional durable runtime request ID (runtime sandboxes only); reuse identical input after uncertain delivery.",
          ),
        command: z.string().min(1),
        cwd: z.string().min(1).optional(),
        timeout_seconds: z.number().int().min(1).max(600).optional().describe("Default 120."),
      },
      output: {
        id: z.string(),
        exitCode: z.number().int().nullable(),
        stdout: z.string(),
        stderr: z.string(),
        timedOut: z.boolean(),
        truncated: z.boolean(),
      },
    },
    async (args) => {
      const { sandbox: found, provider, enrolled } = await liveControl(args);
      // Applies to managed and ordinary exec before any native preparation or
      // provider command can implicitly resume a retained disk.
      await data.sandboxes.assertExecAllowed?.(found.id);
      const managedNative =
        !enrolled &&
        (await context.launchCredentials.assertExec?.(
          { userId: found.ownerId, orgId: found.orgId, role: "member" },
          found.id,
        ));
      let acknowledged = false;
      const execute = async () => {
        const membership = caller.orgs.find((member) => member.orgId === found.orgId);
        if (!membership) throw new ToolError("forbidden", "No current organization membership.");
        if (!enrolled) await prepareConnections(provider, found, membership.role);
        const nativeActor = { userId: found.ownerId, orgId: found.orgId, role: "member" as const };
        const readNativeSecrets = (phase: "before" | "after") =>
          context.launchCredentials.nativeSecrets?.(nativeActor, found.id, provider, found.providerSandboxId, phase);
        const nativeBefore = (!enrolled && (await readNativeSecrets("before"))) || [];
        const result = await provider
          .exec({
            sandboxId: found.providerSandboxId,
            ...(args.request_id ? { requestId: args.request_id } : {}),
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
      if (!managedNative) {
        // Admission-only check: already-running ordinary commands remain concurrent
        // and do not hold a lifecycle lease or delay stop/TTL reconciliation.
        return execute();
      }
      // Stop and native-file mutation must not interleave: a stop receipt sampled
      // before this command cannot authenticate output produced after auto-resume.
      return sandboxActivity(
        data.sandboxes,
        found,
        {},
        async (signal) => {
          signal.throwIfAborted();
          const result = await execute();
          signal.throwIfAborted();
          return { result, patch: {} };
        },
        { deadlineMs: ((args.timeout_seconds ?? 120) + 60) * 1000 },
      ).catch((error) => publicationFailure(error, acknowledged));
    },
  );

  const stopTool = tool(
    "stop",
    {
      title: "Stop a sandbox",
      description:
        "Stops the machine. Modal keeps its disk only if checkpoint succeeds; fallback termination returns " +
        "checkpoint_failed_disk_not_retained and cannot resume. Other retained stops can resume on send. Use it when the " +
        "agent is done, so the sandbox stops costing.",
      input: { id, request_id: z.string().uuid().optional(), only_if_idle: z.boolean().optional() },
      output: { id: z.string(), status: z.enum(SANDBOX_STATUSES), preservationNote: z.string().optional() },
      destructive: true,
    },
    async (args) => {
      const found = await visible(args.id);
      if (args.only_if_idle && !["ready", "stopped"].includes(found.status))
        throw new VaultError(
          "credential_binding_unsafe",
          "Wait for the running turn or lifecycle operation to finish before changing accounts.",
        );
      if (args.only_if_idle && found.status === "ready" && !(await statusOf(args.id, undefined)).settled)
        throw new VaultError(
          "credential_binding_unsafe",
          "Wait for the current turn to finish before changing accounts.",
        );
      // A repeated stop observes the admitted request; it must not compete with
      // its activity/reconciliation lease or replay provider hooks on archiving compute.
      if (found.stopRequestedAt || ["stopping", "stopped"].includes(found.status))
        return { id: found.id, status: found.status };
      const { provider } = await live(args.id, true);
      const idleGuard: Pick<ServerSandboxPatch, "onlyIfIdle"> = { onlyIfIdle: args.only_if_idle === true };
      return sandboxActivity(
        data.sandboxes,
        found,
        {
          ...idleGuard,
          status: found.status === "failed" ? "failed" : "stopping",
          stoppedAt: null,
          stopRequested: true,
          ...(found.statusReason === "expired" ? { statusReason: "expired" } : {}),
        },
        async (signal) => {
          signal.throwIfAborted();
          // A historical warning is not proof that this stop has captured current work.
          const preservation = await data.sandboxes
            .preserveWork?.(found.id, provider, found.providerSandboxId)
            .catch(() => {});
          signal.throwIfAborted();
          if (preservation === "pending")
            return {
              result: {
                id: found.id,
                status: found.status === "failed" ? ("failed" as const) : ("stopping" as const),
              },
              patch: {
                status: found.status === "failed" ? ("failed" as const) : ("stopping" as const),
                stopRequested: true,
              },
            };
          let terminal = false;
          let stoppedAt: Date | undefined;
          let preservationNote: string | undefined;
          try {
            if (provider.collectTurnUsage) await collectSandboxUsage(provider, data.sandboxes, found);
            signal.throwIfAborted();
            const observed = await stopAndObserve(provider, found.id, found.providerSandboxId, "user_stop", signal);
            terminal =
              observed.state === "stopped" &&
              (provider.id !== "boat" || observed.retainedSnapshot === "usable" || found.status === "failed");
            stoppedAt = observed.stoppedAt;
            preservationNote = observed.stopNote;
          } catch (error) {
            if (!(error instanceof ProviderError && error.code === "not_found")) throw error;
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
    register(
      "send",
      {
        title: sendTool.title,
        description:
          "Start a new turn, or set steer to redirect a running turn. Model and effort overrides apply only to new turns. " +
          "Runtime follow-up requires a request ID. Reuse that ID with identical input after uncertain delivery.",
        input: z.looseObject({
          ...sendTool.input,
          request_id: sendTool.input.request_id.describe(
            "Required for runtime follow-up. Optional for runtime steer. Reuse with identical input after uncertain delivery. " +
              "Native send accepts the field without deduplication. Omit it for native steer.",
          ),
          steer: z
            .boolean()
            .optional()
            .describe("Redirect the running turn. Delivery is native or a restart in the same conversation."),
        }),
        output: {
          ...sendTool.output,
          status: sendTool.output.status.optional(),
          delivery: steerTool.output.delivery.optional(),
          mode: steerTool.output.mode.optional(),
        },
      },
      async ({ steer, id, prompt, request_id, model, reasoning_effort, ...extra }) => {
        try {
          refuseConversationSelector(extra);
        } catch (error) {
          return errorResult(error, "send", context.logError ?? console.error);
        }
        if (!steer) return sendTool.invoke({ id, prompt, request_id, model, reasoning_effort });
        if (model !== undefined || reasoning_effort !== undefined)
          return invalidToolInput("send", "Model and effort overrides require a new turn.");
        return steerTool.invoke({ id, text: prompt, request_id });
      },
    );

    register(
      "status",
      {
        ...readStatusTool,
        description: `${readStatusTool.description} Set wait to block until settled or timed out.`,
        input: {
          ...readStatusTool.input,
          timeout_seconds: waitTool.input.timeout_seconds,
          wait: z.boolean().optional().describe("Wait for settlement. Default timeout: 60 seconds."),
        },
        output: { ...statusOutput, timedOut: waitTool.output.timedOut.optional() },
      },
      async ({ wait, timeout_seconds, ...args }) => {
        if (!wait && timeout_seconds !== undefined) return invalidToolInput("status", "timeout_seconds requires wait.");
        if (wait && args.recorded !== undefined)
          return invalidToolInput("status", "Waiting uses the live turn state. Omit recorded.");
        return wait ? waitTool.invoke({ ...args, timeout_seconds }) : readStatusTool.invoke(args);
      },
    );

    register(
      "stop",
      {
        ...stopTool,
        description:
          `${stopTool.description} Set turn to interrupt the current turn and keep the machine up. ` +
          "Set after to wait for settlement and stop only if still idle. On timeout this call does not request a stop.",
        input: z.strictObject({
          ...stopTool.input,
          turn: z.boolean().optional().describe("Interrupt the turn without stopping the sandbox."),
          after: z.boolean().optional().describe("Wait for settlement before attempting an idle-only stop."),
          timeout_seconds: waitTool.input.timeout_seconds,
        }),
        output: {
          ...stopTool.output,
          status: stopTool.output.status.optional(),
          interrupted: interruptTool.output.interrupted.optional(),
          timedOut: waitTool.output.timedOut.optional(),
        },
      },
      async ({ turn, after, timeout_seconds, ...args }) => {
        if (!after && timeout_seconds !== undefined) return invalidToolInput("stop", "timeout_seconds requires after.");
        if (after && (turn || args.only_if_idle !== undefined))
          return invalidToolInput("stop", "Use after without turn or only_if_idle.");
        if (turn && args.only_if_idle) return invalidToolInput("stop", "Use turn without only_if_idle.");
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
        return turn ? interruptTool.invoke({ id: args.id, request_id: args.request_id }) : stopTool.invoke(args);
      },
    );
  }

  function invalidToolInput(name: string, message: string) {
    return errorResult(new ToolError("invalid_request", message), name, context.logError ?? console.error);
  }

  return server;
}

/** The run a successful steer left in progress, or "" when it cannot be proven.
 * Boat may answer with a steer-record ID; then the newest prompt event names the
 * run, but only relative to a known prior run: a restart must not settle as the
 * run it interrupted, and an unresolved earlier steer leaves nothing to compare.
 */
async function steeredRun(
  provider: Provider,
  found: { providerSandboxId: string; taskPromptId?: string | null },
  promptId: string,
  delivery: "native" | "restart",
  signal: AbortSignal,
): Promise<string> {
  try {
    const run = await provider.getPrompt({ sandboxId: found.providerSandboxId, promptId, signal });
    if (run.promptId === promptId) return promptId;
  } catch {
    /* Not a pollable run: resolve it from events below. */
  }
  // Without a concrete prior run, a stale newest event is indistinguishable
  // from the replacement; keep the empty marker so report resolves it later.
  if (!found.taskPromptId) return "";
  try {
    const latest = (await latestPrompt(provider, found.providerSandboxId, true, signal))?.promptId;
    if (latest && (delivery === "native" || latest !== found.taskPromptId)) return latest;
  } catch {
    /* Accepted steer stays reportable through the empty marker. */
  }
  return "";
}
