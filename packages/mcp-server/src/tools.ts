import {
  GitHubHydrationError,
  idlePauseMessage,
  isExternalRef,
  LAUNCH_STAGES,
  launchFailureHelp,
  launchResponse,
  providerRateLimitDetails,
  SANDBOX_PLACEMENT_PROVIDERS,
  USAGE_UNAVAILABLE_CODES,
} from "@armada/core";
import { launch } from "@armada/core/contract";
import {
  EncryptionKeyError,
  GoldenError,
  type GoldenRecord,
  goldenForLaunch,
  HARNESSES,
  LaunchError,
  type LaunchOptions,
  type LaunchStores,
  launchSandbox,
  type MemberRole,
  MODEL_CATALOG,
  type Provider,
  ProviderError,
  ProviderRoutingError,
  type ProviderTarget,
  redact,
  resolveModelChoice,
  resolveRepositoryDir,
  SANDBOX_PROVIDERS,
  type SandboxProviderId,
  type SandboxStatus,
  type SkillDefaultsService,
  VaultError,
} from "@armada/core/server";
import { BoatRetentionUnconfirmed } from "@armada/provider-boat";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { apiFailureCode } from "./api-failure.ts";
import type { Caller } from "./caller.ts";
import { UUID } from "./control-input.ts";
import { INTERNAL_FAILURE_MESSAGE } from "./control-response.ts";
import { CREDENTIAL_BINDING_GUIDANCE } from "./credential-binding.ts";
import { DataError, type SandboxView, type ScopedData } from "./data.ts";
import { MAX_LOG_PAGES, readEventPages, validateLogPagination } from "./event-pagination.ts";
import { type GoldenLaunchCredentials, prepareGoldenLaunchAccount } from "./launch-account-admission.ts";
import { publicLogEvents } from "./model-usage.ts";
import type { createOrdinaryLaunchReceipts } from "./ordinary-launch-receipts.ts";
import { recordOperatorFailure } from "./request-observability.ts";
import { observeGoldenLaunch } from "./request-timing.ts";
import type { RuntimeFollowup } from "./runtime-followup.ts";
import { appendConversation, sandboxActivity } from "./sandbox-activity.ts";
import { sandboxControlRefusal } from "./sandbox-control-refusal.ts";
import {
  collectSandboxUsage,
  isStatusReadFenced,
  latestPrompt,
  readStatus,
  recordedStatus,
  type StatusReport,
  waitSettled,
} from "./turns.ts";
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

export const SANDBOX_STATUSES = ["starting", "ready", "running", "stopping", "stopped", "failed", "deleted"] as const;
export const DEFAULT_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 600;
const OUTPUT_LIMIT = 20_000;

export class ToolError extends Error {
  override readonly name = "ToolError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function assertSendConversation(requested: unknown, current: string | undefined): void {
  if (requested !== undefined && requested !== current)
    throw new ToolError(
      "conflict",
      "A sandbox has one conversation. Launch another sandbox for a separate conversation.",
    );
}

export const serverInfo = { name: "armada" } as const;

const id = z.string().describe("Armada's sandbox id (a uuid, as returned by launch and list).");

const modelCatalogText = Object.entries(MODEL_CATALOG)
  .map(
    ([harness, entry]) =>
      `${harness}: ${entry.models.map((option) => `${option.id} (${option.reasoningEfforts.join("|")})`).join(", ")}; ` +
      `default ${entry.defaultModel} ${entry.defaultReasoningEffort}`,
  )
  .join(". ");
const modelInput = z.string().min(1).optional().describe(`The model, by id. ${modelCatalogText}.`);
const effortInput = z.string().min(1).optional().describe("The reasoning effort; one the model accepts (see model).");
const modelOutput = {
  credentialId: z.string().nullable().optional(),
  credentialVersion: z.number().int().nullable().optional(),
  model: z.string().nullable().describe("The requested next-send default, not proof of the observed model."),
  reasoningEffort: z.string().nullable(),
};

const providerOutput = z.enum(SANDBOX_PROVIDERS).describe("The sandbox provider it runs on, fixed for its life.");
const compat = (name: string) =>
  z.string().nullable().describe(`The same as ${name} on a Boat golden or sandbox; null on any other provider.`);

/** The golden record shared by the MCP tools and the REST golden list. */
const taskOutcome = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ready"),
      prNumber: z.number().int().positive().optional(),
      prUrl: z.url().max(2048).optional(),
      headSha: z
        .string()
        .regex(/^[A-Fa-f0-9]{40}$/)
        .optional(),
    })
    .strict(),
  z.object({ state: z.literal("blocked"), reason: z.string().trim().min(1).max(1000) }).strict(),
]);

const pullRequests = z.array(
  z.object({
    repository: z.string(),
    number: z.number().int().positive(),
    url: z.url(),
    headBranch: z.string(),
    state: z.enum(["open", "merged", "closed"]),
    checkedAt: z.string(),
  }),
);

const sandboxUsage = z
  .object({
    computeSeconds: z.number().nullable(),
    turnCount: z.number().nullable(),
    cost: z
      .object({
        classification: z.enum(["priced", "included_in_subscription", "unknown"]),
        currency: z.literal("USD"),
        usd: z.string().nullable(),
        basis: z.enum(["estimated", "api_equivalent"]).nullable(),
        unknown: z.enum(["admission", "coverage", "price", "tokens", "pricing_dimensions"]).nullable(),
        unpricedTurns: z.number().int().nonnegative().nullable(),
      })
      .optional(),
    tokenTotals: z
      .object({
        incomplete: z.boolean().optional(),
        inputTokens: z.number().nullable(),
        outputTokens: z.number().nullable(),
        cachedTokens: z.number().nullable(),
        cacheWriteTokens: z.number().nullable(),
        reasoningTokens: z.number().nullable(),
      })
      .optional(),
    turns: z.array(
      z.object({
        promptId: z.string(),
        model: z.string().nullable(),
        inputTokens: z.number().nullable(),
        outputTokens: z.number().nullable(),
        cachedTokens: z.number().nullable(),
        cacheWriteTokens: z.number().nullable().optional(),
        reasoningTokens: z.number().nullable().optional(),
        // Versioned service-owned pricing metadata; native decoders never populate it.
        pricing: z
          .unknown()
          .nullable()
          .optional()
          .describe("Versioned server USD quote from a frozen snapshot; null means unpriced, never zero."),
        unavailableReason: z.object({ code: z.enum(USAGE_UNAVAILABLE_CODES), message: z.string().max(600) }).optional(),
      }),
    ),
  })
  .nullable()
  .optional();

// Logical Armada lifetime only; provider deadlines never drive this warning.
function logicalExpiry(expiresAt: string | null | undefined, now: Date) {
  const deadline = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const timeLeftSeconds = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now.getTime()) / 1000)) : null;
  return {
    expiresAt: expiresAt ?? null,
    timeLeftSeconds,
    expiringSoon: timeLeftSeconds !== null && timeLeftSeconds <= 300,
  };
}

const expiryOutput = {
  timeLeftSeconds: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Seconds until persisted Armada logical expiry, rounded up and clamped to zero; null if unknown."),
  expiringSoon: z
    .boolean()
    .describe("True when known logical time left is at most five minutes, including expired resources."),
};

const externalRefOutput = z.string().optional().describe("Opaque reference given at launch; absent when none.");
const externalRefInput = z
  .string()
  .refine(isExternalRef, "1 to 200 characters without control characters.")
  .describe(
    "Opaque caller reference, for example one business object id. Not unique; use idempotencyKey for exactly-once.",
  );

const sandboxListMetadata = z.object({
  ...expiryOutput,
  idlePaused: z.boolean().optional(),
  statusMessage: z.string().nullable().optional(),
  usage: sandboxUsage,
  preservationNote: z.string().nullable().optional(),
  providerSandboxId: z.string().nullable(),
  boatId: z.string().nullable(),
  id: z.string(),
  orgId: z.string(),
  ownerId: z.string(),
  provider: z.enum(SANDBOX_PLACEMENT_PROVIDERS),
  harness: z.enum(HARNESSES),
  model: modelOutput.model,
  reasoningEffort: modelOutput.reasoningEffort,
  status: z.enum(SANDBOX_STATUSES),
  createdAt: z.string(),
  stoppedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  effectiveTtlSeconds: z.number().nullable(),
  machineSize: z.enum(["small", "medium", "large", "xlarge"]).nullable(),
  displayLabel: z.string(),
  taskOutcome: taskOutcome.nullable().optional(),
  pullRequests: pullRequests.nullable().optional(),
  externalRef: externalRefOutput,
  canOpen: z.boolean(),
  canManage: z.boolean(),
});

const prompt = z.object({
  rateLimit: z
    .object({
      retryCount: z.number(),
      delayMs: z.number(),
      totalWaitMs: z.number(),
      retryAt: z.number(),
      waiting: z.boolean(),
      message: z.string(),
    })
    .nullable()
    .optional(),
  promptId: z.string(),
  conversationId: z.string().nullable(),
  state: z.enum(["queued", "running", "finished", "interrupted", "failed"]),
  reason: z.string().nullable(),
  requestedModel: z.string().nullable().optional(),
  observedModel: z.string().nullable().optional(),
  modelSelectionReason: z.enum(["model_selection_mismatch", "model_selection_unverified"]).nullable().optional(),
  modelSelectionMessage: z.string().nullable().optional(),
});

const skillReceipts = z
  .array(
    z.object({
      reference: z.string(),
      version: z.string(),
      skillId: z.string(),
      checksum: z.string(),
      origin: z.string(),
    }),
  )
  .optional();

/** #2560: latest activation (launch or resume), stages in time order; ms is the time since the previous stage. */
const launchTiming = z
  .object({
    activation: z.string().describe('"1" is the launch; a higher activation is a resume.'),
    stages: z.array(z.object({ stage: z.enum(LAUNCH_STAGES), at: z.string(), ms: z.number().nullable() })),
    ready: z.boolean().describe("Harness ready was recorded."),
    totalMs: z
      .number()
      .nullable()
      .describe(
        "First stage to harness ready (or the last stage so far); first_token waits for a prompt and is excluded.",
      ),
    slowest: z.object({ stage: z.enum(LAUNCH_STAGES), ms: z.number() }).nullable(),
  })
  .nullable()
  .optional()
  .describe("Launch time per stage for the latest launch or resume; null before any stage is recorded.");

const status = {
  ...expiryOutput,
  launch: launchTiming,
  providerExpiresAt: z
    .string()
    .nullable()
    .describe("Provider physical deadline, when observed; distinct from Armada logical expiry."),
  billingAccount: z
    .object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      billing: z.enum(["subscription", "api-key"]),
      version: z.number().int(),
    })
    .nullable()
    .optional(),
  skills: skillReceipts,
  usage: sandboxUsage,
  preservationNote: z.string().nullable().optional(),
  externalRef: externalRefOutput,
  id: z.string(),
  golden: z.string().nullable(),
  provider: z.enum(SANDBOX_PLACEMENT_PROVIDERS).optional(),
  hostId: z.string().optional(),
  image: z.string().optional(),
  visibility: z.enum(["org", "private"]),
  harness: z.enum(HARNESSES),
  repositoryDir: z
    .string()
    .nullable()
    .describe("Configured directory used to prepare native agent cwd; not confinement."),
  ...modelOutput,
  machineSize: z.unknown().nullable(),
  status: z.enum(SANDBOX_STATUSES),
  statusReason: z.string().nullable(),
  statusMessage: z.string().nullable().optional(),
  taskOutcome: taskOutcome.nullable().optional(),
  pullRequests: pullRequests.nullable().optional(),
  providerState: z.string().nullable(),
  conversationIds: z.array(z.string()),
  expiresAt: z.string().nullable(),
  prompt: prompt.nullable(),
  settled: z.boolean(),
};

const event = z.looseObject({
  id: z.string(),
  at: z.number(),
  kind: z.enum(["prompt", "message", "steer", "other"]),
  conversationId: z.string().optional(),
  promptId: z.string().optional(),
});

/** Output of the `logs` tool, also published (open) as the REST `logs/read` response (`REST_LOGS_RESPONSE`). */
export const LOGS_OUTPUT = {
  events: z.array(event),
  cursor: z.string().nullable(),
  olderCursor: z.string().optional(),
  hasMore: z.boolean(),
  settled: z.boolean().optional(),
  source: z.literal("armada-runtime").optional(),
  threadStatus: z
    .object({ status: z.string(), statusMessage: z.string().nullable(), prompt: z.unknown(), usage: z.unknown() })
    .optional(),
  runtimeFailure: z.object({ status: z.literal("failed"), reason: z.string() }).optional(),
  queuedPrompt: z
    .object({
      promptId: z.string(),
      conversationId: z.string().nullable(),
      state: z.string(),
      reason: z.string().nullable(),
    })
    .optional()
    .describe(
      "Docker only: the latest prompt while the runtime has not admitted it (queued behind startup, or failed before admission).",
    ),
};

export const sandboxListInput = z.object({
  harness: z.enum(HARNESSES).optional(),
  golden: z.string().uuid().optional().describe("Golden UUID, not a name."),
  owner: z.union([z.string().uuid(), z.literal("me")]).optional(),
  page: z.number().int().min(1).max(1_000_000).optional().describe("1-based page, default 1."),
  status: z.array(z.enum(SANDBOX_STATUSES)).min(1).optional().describe("Only these statuses."),
  limit: z.number().int().min(1).max(200).optional().describe("At most this many. Default 25."),
  externalRef: externalRefInput
    .optional()
    .describe("Only sandboxes launched with this reference that you own or administer."),
});

const [ordinaryBoatLaunch, , ordinaryModalLaunch] = launch.input.body.options;
const mcpLaunchOmissions = { armadaAccess: true, armadaAccessVersion: true } as const;
const mcpLaunchInput = z.union([
  ordinaryBoatLaunch.omit(mcpLaunchOmissions),
  ordinaryModalLaunch.omit(mcpLaunchOmissions),
]);
const mcpLaunchArguments = z.looseObject({}).meta({
  anyOf: mcpLaunchInput.options.map((variant) => {
    const { $schema: _dialect, ...schema } = z.toJSONSchema(variant, { io: "input" });
    return schema;
  }),
});

/** One MCP server per request: the principal is fixed for its whole life, and nothing outlives the request. */
export function createArmadaServer(context: ToolContext, version: string) {
  return createToolServer(context, version, "mcp");
}

/** In-memory REST dispatch and schema discovery. Never exposed on the MCP transport. */
export function createRestToolServer(context: ToolContext, version: string, onlyTool?: "list") {
  return createToolServer(context, version, "rest", onlyTool);
}

type ToolInput = z.ZodRawShape | z.ZodObject;
type ToolArgs<In extends ToolInput> = z.infer<In extends z.ZodRawShape ? z.ZodObject<In> : In>;

type ToolContract<In extends ToolInput, Out extends z.ZodRawShape> = {
  title: string;
  description: string;
  input: In;
  output: Out;
  readOnly?: boolean;
  destructive?: boolean;
};

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
  const orgIds = caller.orgs.map((org) => org.orgId);

  const register = <In extends ToolInput, Out extends z.ZodRawShape>(
    name: string,
    config: ToolContract<In, Out>,
    invoke: (args: ToolArgs<In>) => Promise<CallToolResult>,
  ) => {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.input,
        outputSchema: config.output,
        annotations: {
          readOnlyHint: config.readOnly ?? false,
          destructiveHint: config.destructive ?? false,
          openWorldHint: true,
        },
      },
      invoke as never,
    );
  };

  const tool = <In extends ToolInput, Out extends z.ZodRawShape>(
    name: string,
    config: ToolContract<In, Out>,
    run: (args: ToolArgs<In>) => Promise<z.infer<z.ZodObject<Out>>>,
    restOnly = false,
  ) => {
    const invoke: (args: ToolArgs<In>) => Promise<CallToolResult> = async (args) => {
      try {
        if (["send", "steer", "exec", "interrupt"].includes(name)) {
          const input = args as Record<string, unknown>;
          const found = data.sandboxes.controlState
            ? await data.sandboxes.controlState(input.id as string)
            : await visible(input.id as string);
          if (!found) throw new ToolError("not_found", `No sandbox with id '${input.id}' that you can see.`);
          // A retained legacy Modal workspace needs its owner's explicit account binding
          // before any control, including controls that require running compute.
          if (found.provider === "modal" && !found.credentialId && !sandboxControlRefusal(found, context.now(), "send"))
            throw new VaultError("credential_binding_required", CREDENTIAL_BINDING_GUIDANCE);
          const refusal = sandboxControlRefusal(found, context.now(), name);
          if (refusal) throw new ToolError("sandbox_terminal", refusal);
          if (name === "send" && !context.accountTurns && input.conversation_id !== undefined)
            assertSendConversation(input.conversation_id, found.conversationIds.at(-1));
        }
        if (
          name === "stop" &&
          !(args as Record<string, unknown>).only_if_idle &&
          typeof (args as Record<string, unknown>).id === "string"
        )
          await context.accountTurns?.cancelQueued(caller, (args as Record<string, unknown>).id as string);
        if (name === "report") {
          const input = args as Record<string, unknown>;
          const queued = await context.accountTurns?.status(caller, input.id as string, input.prompt_id as string);
          if (queued && "nativePromptId" in queued) input.prompt_id = queued.nativePromptId;
        }
        if (name === "logs") validateLogPagination(args as Record<string, unknown>);
        const routed = ["send", "status", "wait"].includes(name)
          ? undefined
          : await context.dockerControls?.invoke(caller, name, args);
        const raw = routed?.handled ? routed.result : await run(args);
        if (["logs", "status", "wait", "list"].includes(name) && context.accountTurns?.publicPromptIds) {
          type PublicReport = {
            id?: string;
            sandboxes?: PublicReport[];
            events?: { promptId?: string }[];
            prompt?: { promptId: string };
            usage?: { turns: { promptId: string }[] };
          };
          const root = raw as PublicReport;
          const reports = (name === "list" ? (root.sandboxes ?? []) : [root]).map((report) => {
            const items = [
              ...(report.events ?? []),
              ...(report.prompt ? [report.prompt] : []),
              ...(report.usage?.turns ?? []),
            ];
            return { sandboxId: report.id ?? ((args as Record<string, unknown>).id as string), items };
          });
          const aliases = await context.accountTurns.publicPromptIdsBatch(
            caller,
            reports.map(({ sandboxId, items }) => ({
              sandboxId,
              nativeIds: items.flatMap((item) => (item.promptId ? [item.promptId] : [])),
            })),
          );
          for (const { sandboxId, items } of reports) {
            const ids = aliases.get(sandboxId);
            for (const item of items)
              if (item.promptId && ids?.has(item.promptId)) item.promptId = ids.get(item.promptId)!;
          }
        }
        const value =
          routed?.handled && (name === "status" || name === "wait")
            ? {
                ...(raw as Record<string, unknown>),
                ...logicalExpiry((raw as { expiresAt: string | null }).expiresAt, context.now()),
                providerExpiresAt: null,
              }
            : raw;
        const sandboxId = (args as Record<string, unknown>).id;
        const result =
          (name === "status" || name === "wait") && context.sandboxBillingAccount && typeof sandboxId === "string"
            ? {
                ...(value as Record<string, unknown>),
                billingAccount: await context.sandboxBillingAccount(sandboxId),
              }
            : value;
        return {
          structuredContent: result as Record<string, unknown>,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return errorResult(error, name, context.logError ?? ((line) => console.error(line)));
      }
    };
    if (!restOnly || surface === "rest") register(name, config, invoke);
    return { ...config, invoke };
  };

  // HTTP list calls keep the same handler and SDK validation without building unrelated tools.
  if (onlyTool === "list") {
    registerList();
    return server;
  }

  const visible = async (sandboxId: string): Promise<SandboxView> => {
    const found = await data.sandboxes.get(sandboxId);
    if (!found) throw new ToolError("not_found", `No sandbox with id '${sandboxId}' that you can see.`);
    return found;
  };
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
  const statusOf = async (
    sandboxId: string,
    promptId: string | undefined,
    stored = false,
    allowRecordedFallback = false,
    recorded = false,
  ): Promise<StatusReport & ReturnType<typeof logicalExpiry>> => {
    const queued = await context.accountTurns?.status(caller, sandboxId, promptId);
    // Route reads with the native ID, but keep the receipt identity stable for clients.
    const publicPromptId = queued && "nativePromptId" in queued ? (promptId ?? queued.publicPromptId) : undefined;
    const publicReport = (report: StatusReport): StatusReport =>
      publicPromptId
        ? {
            ...report,
            ...(report.prompt ? { prompt: { ...report.prompt, promptId: publicPromptId } } : {}),
            ...(report.usage
              ? {
                  usage: {
                    ...report.usage,
                    turns: report.usage.turns.map((turn) =>
                      turn.promptId === promptId ? { ...turn, promptId: publicPromptId } : turn,
                    ),
                  },
                }
              : {}),
          }
        : report;
    if (queued && "nativePromptId" in queued) promptId = queued.nativePromptId;
    const waiting = queued && !("nativePromptId" in queued) ? queued : undefined;
    const routed = await context.dockerControls?.invoke(caller, "status", {
      id: sandboxId,
      ...(promptId && !waiting ? { prompt_id: promptId } : {}),
      ...(recorded ? { recorded: true } : {}),
    });
    const queuePatch = waiting
      ? {
          statusMessage: waiting.message,
          settled: waiting.failed ?? false,
          prompt: {
            promptId: waiting.requestId!,
            conversationId: waiting.conversationId!,
            state: waiting.failed ? ("failed" as const) : ("running" as const),
            reason: waiting.message,
          },
        }
      : {};
    if (routed?.handled) {
      const report = publicReport(routed.result as StatusReport);
      return { ...report, ...logicalExpiry(report.expiresAt, context.now()), providerExpiresAt: null, ...queuePatch };
    }
    const found = await measure("sandbox_read", () => visible(sandboxId));
    if (waiting) return { ...recordedStatus(found), ...logicalExpiry(found.expiresAt, context.now()), ...queuePatch };
    if (recorded)
      return {
        ...publicReport(recordedStatus(found)),
        ...logicalExpiry(found.expiresAt, context.now()),
        statusMessage: `Recorded state only; use armada status ${sandboxId} --live for provider and prompt details.`,
      };
    try {
      const storedProvider = stored ? context.storedProviders?.[found.provider] : undefined;
      const provider =
        found.status === "deleted" || isStatusReadFenced(found)
          ? null
          : storedProvider
            ? await storedProvider(found)
            : await context.provider(found);
      const result = await measure("state", () =>
        readStatus(provider, data.sandboxes, found, {
          stored: storedProvider !== undefined,
          ...(promptId ? { promptId } : {}),
          now: context.now(),
        }),
      );
      return {
        ...publicReport(result),
        ...logicalExpiry(result.expiresAt, context.now()),
        statusMessage: idlePauseMessage(result, context.now()),
      };
    } catch (error) {
      if (!allowRecordedFallback || !(error instanceof ProviderError)) throw error;
      return {
        ...publicReport(recordedStatus(found)),
        ...logicalExpiry(found.expiresAt, context.now()),
        statusMessage: "Provider observation unavailable; showing recorded state.",
      };
    }
  };

  tool(
    "launch",
    {
      title: "Launch an agent",
      description:
        "Forks a golden into a new sandbox, pulls its repos, runs its init commands, and starts the agent. " +
        "With `prompt` the agent starts working at once (status running). Without it the sandbox is left ready " +
        "and the conversation starts at the first `send`. The sandbox gets only your (or your org's) Armada " +
        "credentials for this agent, never the boat.dev account's. When the caller connected GitHub, git and gh in " +
        "the sandbox act as that person (8 hour token): see `github` in the answer. Setup can take a few minutes. " +
        "Personal sessions may use an org slug or UUID. For scoped tokens, omit `org` or use the scoped org UUID.",
      input: mcpLaunchArguments,
      output: {
        id: z.string(),
        provider: providerOutput,
        runtime: z.object({ kind: z.literal("armada"), epoch: z.string() }).optional(),
        runtimeTransport: z.literal("dialout").optional(),
        providerSandboxId: z.string(),
        boatId: compat("providerSandboxId"),
        golden: z.string(),
        externalRef: externalRefOutput,
        visibility: z.enum(["org", "private"]),
        harness: z.enum(HARNESSES),
        helper: z.unknown(),
        skills: skillReceipts,
        repositoryDir: z
          .string()
          .nullable()
          .describe("Configured directory used to prepare native agent cwd; not confinement."),
        ...modelOutput,
        machineSize: z.unknown().nullable(),
        status: z.enum(SANDBOX_STATUSES),
        conversationIds: z.array(z.string()),
        promptId: z.string().nullable(),
        ttlSeconds: z.number().int(),
        expiresAt: z.string().nullable(),
        github: z
          .object({
            status: z.enum(["connected", "not_connected", "revoked", "unavailable"]),
            login: z.string().nullable(),
            tokenExpiresAt: z.string().nullable(),
            message: z.string().nullable(),
          })
          .describe(
            "Whether git and gh in the sandbox act as the caller. Anything but connected means they are not signed in; message says how to fix it.",
          ),
      },
    },
    (input) =>
      observeGoldenLaunch("mcp", async (timing) => {
        const parsed = mcpLaunchInput.safeParse(input);
        if (!parsed.success)
          throw new VaultError("invalid", "Invalid golden launch request. See the launch tool schema.");
        const args = parsed.data;
        // Refused before any lookup or allocation.
        resolveModelChoice(args.harness, { model: args.model, reasoningEffort: args.reasoningEffort });
        const actor = await launchActor(args.golden, args.org);
        const chosen: GoldenRecord = await goldenForLaunch(data.goldens, actor, args.golden, args.provider);
        resolveRepositoryDir(chosen, args.repo);
        timing.checkpoint("admission");
        const prepare = async () => {
          const account = await prepareGoldenLaunchAccount(
            actor,
            chosen,
            args,
            context.launchCredentials,
            context.launch ?? {},
          );
          timing.checkpoint("account_resolution");
          const provider = await context.provider(chosen);
          timing.checkpoint("provider_resolution");
          return { ...account, provider };
        };
        let prepared: ReturnType<typeof prepare> | undefined;
        const prepareOnce = () => (prepared ??= prepare());
        const dispatch = async (receiptId?: string) => {
          const { provider, credentials, options } = await prepareOnce();
          timing.checkpoint("receipt_admission");
          const result = await launchSandbox(
            provider,
            {
              ...(context.skillDefaults ? { skillDefaults: context.skillDefaults } : {}),
              goldens: data.goldens,
              sandboxes: data.sandboxes,
              credentials,
              ...(context.connections ? { connections: context.connections } : {}),
            },
            actor,
            {
              golden: args.golden,
              ...(args.size === undefined ? {} : { size: args.size }),
              provider: chosen.provider,
              harness: args.harness,
              ...(args.repo === undefined ? {} : { repo: args.repo }),
              ...(args.model === undefined ? {} : { model: args.model }),
              ...(args.visibility === undefined ? {} : { visibility: args.visibility }),
              ...(args.skipSkillDefaults === undefined ? {} : { skipSkillDefaults: args.skipSkillDefaults }),
              ...(args.skills === undefined ? {} : { skills: args.skills }),
              ...(args.helperCapabilities === undefined ? {} : { helperCapabilities: args.helperCapabilities }),
              ...(args.connections === undefined ? {} : { connections: args.connections }),
              ...(args.credentialId ? { credentialId: args.credentialId } : {}),
              ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
              ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
              ...(args.ttlSeconds === undefined ? {} : { ttlSeconds: args.ttlSeconds }),
              ...(args.stopWhenWorkMerged === undefined ? {} : { stopWhenWorkMerged: args.stopWhenWorkMerged }),
              ...(args.externalRef === undefined ? {} : { externalRef: args.externalRef }),
            },
            { ...options, ...(receiptId ? { newId: () => receiptId } : {}) },
          );
          timing.checkpoint("shared_launcher");
          timing.launched(result.sandbox);
          return {
            ...launchResponse(result),
            helper: result.helper,
            visibility: result.sandbox.visibility ?? result.golden.visibility,
          };
        };
        if (!context.ordinaryLaunchReceipts) {
          if (args.idempotencyKey) throw new ToolError("invalid", "Durable launch receipts are not configured.");
          return dispatch();
        }
        const { provider } = await prepareOnce();
        const authority = {
          target: {
            provider: chosen.provider,
            orgId: chosen.orgId,
            visibility: chosen.visibility,
            modal: chosen.modal,
          },
          management:
            (await provider.managementIdentity?.()) ??
            (() => {
              throw new ToolError("invalid", "Provider cannot pin management authority.");
            })(),
          backendId:
            (await provider.backendIdentity?.())?.id ??
            (() => {
              throw new ToolError("invalid", "Provider cannot pin allocation authority.");
            })(),
        };
        return context.ordinaryLaunchReceipts.run(
          actor,
          args.idempotencyKey ?? crypto.randomUUID(),
          { ...args, goldenId: chosen.id },
          dispatch,
          authority,
        );
      }),
  );

  registerList();

  function registerList() {
    tool(
      "list",
      {
        title: "List sandboxes",
        description:
          "Allowlisted metadata of sandboxes in your current organizations, newest first. Interior is owner/admin only. " +
          "Deleted ones are left out unless asked for. Statuses are as recorded; call status for a fresh read.",
        input: sandboxListInput.shape,
        output: {
          sandboxes: z.array(sandboxListMetadata),
          total: z.number().int(),
          page: z.number().int(),
          limit: z.number().int(),
          hasMore: z.boolean(),
          nextPage: z.number().int().nullable(),
        },
        readOnly: true,
      },
      async (args) => {
        const statuses: readonly SandboxStatus[] = args.status ?? SANDBOX_STATUSES.filter((name) => name !== "deleted");
        const limit = args.limit ?? 25;
        const page = args.page ?? 1;
        const { rows, total } = await data.sandboxes.list({
          statuses,
          limit,
          page,
          ...(args.harness === undefined ? {} : { harness: args.harness }),
          ...(args.golden === undefined ? {} : { goldenId: args.golden }),
          ...(args.owner === undefined ? {} : { ownerId: args.owner === "me" ? caller.userId : args.owner }),
          ...(args.externalRef === undefined ? {} : { externalRef: args.externalRef }),
        });
        const hasMore = page * limit < total;
        return {
          total,
          page,
          limit,
          hasMore,
          nextPage: hasMore && page < 1_000_000 ? page + 1 : null,
          sandboxes: rows.map((row) => ({
            ...row,
            ...logicalExpiry(row.expiresAt, context.now()),
            statusMessage: idlePauseMessage(row, context.now()),
          })),
        };
      },
    );
  }

  const readStatusTool = tool(
    "status",
    {
      title: "Sandbox status",
      description:
        "Where a sandbox and its latest turn are. Modal uses authorized stored observations; physical state is refreshed by the lifecycle worker. Boat is read live. prompt.state is " +
        "queued (accepted by a starting Docker sandbox, not yet admitted by its runtime), running, finished, interrupted or failed; failed includes a usage limit or an expired login, with " +
        "the reason. settled is true when the agent is not working.",
      input: {
        id,
        prompt_id: z.string().min(1).optional().describe("A specific turn. Default: the latest."),
        recorded: z
          .boolean()
          .optional()
          .describe(
            "True: database-only state. False: live provider probe. Omitted: provider-specific detail read. CLI defaults to true; --live sets false.",
          ),
      },
      output: status,
      readOnly: true,
    },
    async (args) => {
      const report = await statusOf(args.id, args.prompt_id, args.recorded === undefined, true, args.recorded === true);
      // Read after statusOf so an invisible sandbox has already been refused.
      const launch = data.sandboxes.launchTiming ? await data.sandboxes.launchTiming(report.id) : undefined;
      return launch === undefined ? report : { ...report, launch };
    },
    true,
  );

  const waitTool = tool(
    "wait",
    {
      title: "Wait for the agent",
      description:
        `Blocks until the agent settles (its turn finished, failed or was interrupted, or the machine stopped) ` +
        `or the timeout passes, then answers like status with timedOut. Default ${DEFAULT_WAIT_SECONDS}s, ` +
        `at most ${MAX_WAIT_SECONDS}s: call again to keep waiting.`,
      input: {
        id,
        timeout_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional(),
        prompt_id: z.string().min(1).optional().describe("A specific turn. Default: the latest."),
      },
      output: { ...status, timedOut: z.boolean() },
      readOnly: true,
    },
    (args) =>
      waitSettled(() => statusOf(args.id, args.prompt_id), {
        timeoutMs: (args.timeout_seconds ?? DEFAULT_WAIT_SECONDS) * 1000,
        now: context.now,
        sleep: context.sleep,
      }),
    true,
  );

  tool(
    "logs",
    {
      title: "Read events",
      description:
        "The agent's events oldest first: prompts (with status and failure reason), messages and tool calls, " +
        "steers. The default is one bounded page (100 events). Set all to read every available page (up to " +
        `${MAX_LOG_PAGES} pages) in one response. Pass the returned cursor as since_cursor to read only what is new. ` +
        "An event read twice has the same id and the newer body; each id appears once per response.",
      input: {
        id,
        since_cursor: z.string().min(1).optional().describe("The cursor of the previous page."),
        limit: z.number().int().min(1).max(500).optional(),
        all: z.boolean().optional().describe("Read up to 100 pages. Use forward direction only."),
        direction: z.enum(["forward", "backward"]).optional(),
        maxBytes: z.number().int().min(256).max(1048576).optional(),
        coalesce: z.boolean().optional(),
      },
      output: {
        ...LOGS_OUTPUT,
        settled:
          surface === "rest"
            ? LOGS_OUTPUT.settled.describe("Docker only. Use status or wait to check whether a turn has settled.")
            : LOGS_OUTPUT.settled.describe("Docker only. Use status to check whether a turn has settled."),
      },
      readOnly: true,
    },
    async (args) => {
      const found = await visible(args.id);
      if (found.status === "deleted") throw new ToolError("conflict", "Sandbox is deleted.");
      const storedProvider = context.storedProviders?.[found.provider];
      const provider = storedProvider ? await storedProvider(found) : await context.provider(found);
      const page = await readLogs(provider, found.providerSandboxId, {
        ...(args.since_cursor ? { since_cursor: args.since_cursor } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
        ...(args.all ? { all: true } : {}),
        ...(args.direction ? { direction: args.direction } : {}),
        ...(args.maxBytes ? { maxBytes: args.maxBytes } : {}),
        ...(args.coalesce !== undefined ? { coalesce: args.coalesce } : {}),
      });
      return { ...page, events: page.events.map((item) => ({ ...item })) };
    },
  );

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
      pricingContext = await data.sandboxes.captureUsagePricingContext(found.id);
    const stored =
      found.model !== null && found.reasoningEffort !== null
        ? { model: found.model, reasoningEffort: found.reasoningEffort }
        : undefined;
    // Recorded defaults bypass today's catalog; an override applies to this turn only.
    const choice =
      args.model === undefined && args.reasoning_effort === undefined
        ? stored
        : resolveModelChoice(found.harness, { model: args.model, reasoningEffort: args.reasoning_effort }, stored);
    const conversation = args.conversation_id ?? found.conversationIds.at(-1);
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
        conversation_id: z
          .string()
          .min(1)
          .optional()
          .describe("The sandbox's current conversation ID for a new turn. Omit to target it automatically."),
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
      return sandboxActivity(
        data.sandboxes,
        found,
        {
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
        input: {
          ...sendTool.input,
          request_id: sendTool.input.request_id.describe(
            "Required for runtime follow-up. Optional for runtime steer. Reuse with identical input after uncertain delivery. " +
              "Native send accepts the field without deduplication. Omit it for native steer.",
          ),
          steer: z
            .boolean()
            .optional()
            .describe("Redirect the running turn. Delivery is native or a restart in the same conversation."),
        },
        output: {
          ...sendTool.output,
          status: sendTool.output.status.optional(),
          delivery: steerTool.output.delivery.optional(),
          mode: steerTool.output.mode.optional(),
        },
      },
      async ({ steer, ...args }) => {
        if (!steer) return sendTool.invoke(args);
        if (args.model !== undefined || args.reasoning_effort !== undefined)
          return invalidToolInput("send", "Model and effort overrides require a new turn.");
        if (args.conversation_id !== undefined)
          return invalidToolInput("send", "Steer targets the sandbox. Omit conversation_id.");
        return steerTool.invoke({
          id: args.id,
          text: args.prompt,
          request_id: args.request_id,
        });
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
        output: { ...status, timedOut: waitTool.output.timedOut.optional() },
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
        description: `${stopTool.description} Set turn to interrupt the current turn and keep the machine up.`,
        input: z.strictObject({
          ...stopTool.input,
          turn: z.boolean().optional().describe("Interrupt the turn without stopping the sandbox."),
        }),
        output: {
          ...stopTool.output,
          status: stopTool.output.status.optional(),
          interrupted: interruptTool.output.interrupted.optional(),
        },
      },
      async ({ turn, ...args }) => {
        if (turn && args.only_if_idle) return invalidToolInput("stop", "Use turn without only_if_idle.");
        return turn ? interruptTool.invoke({ id: args.id, request_id: args.request_id }) : stopTool.invoke(args);
      },
    );
  }

  function invalidToolInput(name: string, message: string) {
    return errorResult(new ToolError("invalid_request", message), name, context.logError ?? console.error);
  }

  /** The org a launch acts in: the given one, else the one of the caller's orgs that has this golden. */
  async function launchActor(name: string, org: string | undefined) {
    const member = (orgId: string) => {
      const found = caller.orgs.find((item) => item.orgId === orgId);
      return found ? { userId: caller.userId, orgId: found.orgId, role: found.role } : null;
    };
    if (org !== undefined) {
      const ref = org.trim().toLowerCase();
      const orgId = UUID.test(ref)
        ? ref
        : caller.orgs.find(({ orgId }) => caller.orgNames?.[orgId]?.trim().toLowerCase() === ref)?.orgId;
      const chosen = orgId ? member(orgId) : null;
      if (!chosen) throw new ToolError("not_found", `You are not a member of org '${org}'.`);
      return chosen;
    }
    const [first] = caller.orgs;
    if (!first) throw new ToolError("not_found", "You are not a member of any org.");
    if (caller.orgs.length === 1) return member(first.orgId) ?? fail();
    const holders: string[] = [];
    for (const orgId of orgIds) if ((await data.goldens.findByName(orgId, name)).length > 0) holders.push(orgId);
    if (holders.length > 1) {
      throw new ToolError(
        "invalid_request",
        `'${name}' is a golden in several of your orgs. Pass org (a slug or UUID).`,
      );
    }
    return member(holders[0] ?? first.orgId) ?? fail();
  }

  return server;
}

function fail(): never {
  throw new ToolError("internal", INTERNAL_FAILURE_MESSAGE);
}

async function readLogs(
  provider: Provider,
  sandboxId: string,
  args: {
    since_cursor?: string;
    limit?: number;
    all?: boolean;
    direction?: "forward" | "backward";
    maxBytes?: number;
    coalesce?: boolean;
  },
) {
  const { events, cursor, hasMore, olderCursor, source, runtimeFailure } = await readEventPages(
    (cursor) =>
      provider.events({
        sandboxId,
        ...(args.direction ? { direction: args.direction } : {}),
        ...(args.maxBytes ? { maxBytes: args.maxBytes } : {}),
        ...(args.coalesce !== undefined ? { coalesce: args.coalesce } : {}),
        ...(cursor ? { cursor } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
      }),
    args.since_cursor,
    args.all === true,
  );
  return {
    ...(olderCursor ? { olderCursor } : {}),
    ...(source ? { source } : {}),
    ...(runtimeFailure ? { runtimeFailure } : {}),
    events: publicLogEvents(events),
    cursor,
    hasMore,
  };
}

function errorResult(error: unknown, tool: string, logError: (line: string) => void): CallToolResult {
  const { code, message } = describeToolFailure(error);
  logToolFailure(error, tool, code, logError);
  return {
    isError: true,
    ...(error instanceof LaunchError && error.reason
      ? {
          structuredContent: {
            error: {
              code,
              message,
              details: { reason: error.reason, action: error.action, ...(error.stage ? { stage: error.stage } : {}) },
            },
          },
        }
      : {}),
    ...(error instanceof ProviderError && code === "rate_limited"
      ? {
          structuredContent: {
            error: {
              code,
              message,
              details: providerRateLimitDetails({ ...error.details, retryAfterSeconds: error.retryAfterSeconds }),
            },
          },
        }
      : {}),
    ...(error instanceof GitHubHydrationError ? { _meta: { error: { code, message, details: error.details } } } : {}),
    content: [
      { type: "text", text: message },
      { type: "text", text: `error code: ${code}` },
      ...(error instanceof GitHubHydrationError
        ? [{ type: "text" as const, text: JSON.stringify({ error: { code, message, details: error.details } }) }]
        : []),
    ],
  };
}

export function logToolFailure(error: unknown, tool: string, code: string, logError?: (line: string) => void) {
  if (
    [
      "internal",
      "unavailable",
      "provider_unavailable",
      "dependency_unavailable",
      "outcome_unknown",
      "start_failed",
    ].includes(code)
  ) {
    recordOperatorFailure(`tool.${tool}`, error, {
      sandboxId: error instanceof LaunchError ? error.sandboxId : undefined,
      ...(logError ? { log: logError } : {}),
    });
  }
}

export function describeToolFailure(error: unknown): { code: string; message: string } {
  const failure = apiFailureCode(error);
  if (failure) return { code: failure, message: error instanceof Error ? error.message : failure };
  if (error instanceof ToolError) return { code: error.code, message: error.message };
  if (error instanceof LaunchError) {
    const tail = error.sandboxId ? ` Sandbox ${error.sandboxId} is recorded as failed and its machine is stopped.` : "";
    return {
      code: error.code,
      message: `${launchFailureHelp(error.code, undefined, error.message) ?? error.message}${tail}`,
    };
  }
  if (error instanceof GoldenError) return { code: error.code, message: error.message };
  if (error instanceof ProviderRoutingError)
    return { code: error.code, message: launchFailureHelp(error.code, undefined, error.message) ?? error.message };
  if (error instanceof ProviderError) {
    if (error.code === "no_running_turn") {
      return { code: error.code, message: "No turn is running. Use send to start one." };
    }
    return {
      code: error.code,
      message:
        launchFailureHelp(error.code, { ...error.details, retryAfterSeconds: error.retryAfterSeconds }) ??
        error.message,
    };
  }
  if (error instanceof VaultError)
    return {
      // Shared typed classification above handles unavailable and credential refusal.
      // All remaining vault codes already match the public HTTP categories.
      code: error.code,
      message: error.message,
    };
  if (error instanceof EncryptionKeyError) return { code: "dependency_unavailable", message: error.message };
  if (error instanceof DataError)
    return { code: error.code === "unavailable" ? "dependency_unavailable" : error.code, message: error.message };
  return { code: "internal", message: INTERNAL_FAILURE_MESSAGE };
}

/** This catch belongs on the dispatch itself, never on preparation or provider reads. */
function unknownMutationOutcome(error: unknown): never {
  if (!(error instanceof ProviderError) || error.code === "unavailable" || error.code === "unknown")
    throw new LaunchError(
      "outcome_unknown",
      "The operation outcome is unknown. Check sandbox status before retrying.",
      { cause: error },
    );
  throw error;
}

function publicationFailure(error: unknown, acknowledged: boolean): never {
  if (acknowledged)
    throw new LaunchError(
      "outcome_unknown",
      "The operation was accepted but its result could not be published. Check sandbox status before retrying.",
      { cause: error },
    );
  throw error;
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
