import * as z from "zod";
import { HARNESSES } from "../contract.ts";
import { LAUNCH_STAGES } from "../launch-stages.ts";
import { MODEL_CATALOG } from "../models.ts";
import { isExternalRef } from "../sandbox.ts";
import { SANDBOX_PLACEMENT_PROVIDERS } from "../sandbox-provider.ts";
import { USAGE_UNAVAILABLE_CODES } from "../sandbox-usage.ts";
import { sandboxControlErrors, sandboxDispatchErrors, sandboxStatusErrors, stopSandboxErrors } from "./failures.ts";
import type { Operation } from "./index.ts";

export const sandboxIdInput = z.string().describe("Armada's sandbox id (a uuid, as returned by launch and list).");

export const SANDBOX_STATUSES = ["starting", "ready", "running", "stopping", "stopped", "failed", "deleted"] as const;

export const modelOutput = {
  credentialId: z.string().nullable().optional(),
  credentialVersion: z.number().int().nullable().optional(),
  model: z.string().nullable().describe("The requested next-send default, not proof of the observed model."),
  reasoningEffort: z.string().nullable(),
};

export const taskOutcome = z.discriminatedUnion("state", [
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

export const sandboxListMetadata = z.object({
  ...expiryOutput,
  idlePaused: z.boolean().optional(),
  statusMessage: z.string().nullable().optional(),
  usage: sandboxUsage,
  preservationNote: z.string().nullable().optional(),
  providerSandboxId: z.string().nullable(),
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

export const skillReceipts = z
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

export const statusOutput = {
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
  provider: z.enum(SANDBOX_PLACEMENT_PROVIDERS),
  hostId: z.string().optional(),
  image: z.string().optional(),
  snapshotId: z.uuid().optional().describe("Snapshot used to launch this Docker sandbox, when applicable."),
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

export const agentEventSchema = z.looseObject({
  id: z.string(),
  at: z.number(),
  kind: z.enum(["prompt", "message", "steer", "other"]),
  conversationId: z.string().optional(),
  promptId: z.string().optional(),
});

export const LOGS_OUTPUT = {
  events: z.array(agentEventSchema),
  cursor: z.string().nullable(),
  olderCursor: z.string().optional(),
  hasMore: z.boolean(),
  settled: z.boolean().optional(),
  source: z.literal("armada-runtime").optional(),
  threadStatus: z
    .object({ status: z.string(), statusMessage: z.string().nullable(), prompt: z.unknown(), usage: z.unknown() })
    .optional(),
  runtimeFailure: z.object({ status: z.literal("failed"), reason: z.string() }).optional(),
};

export const sandboxListInput = z.object({
  harness: z.enum(HARNESSES).optional(),
  golden: z.string().uuid().optional().describe("Filter by Boat or Modal snapshot UUID."),
  owner: z.union([z.string().uuid(), z.literal("me")]).optional(),
  page: z.number().int().min(1).max(1_000_000).optional().describe("1-based page, default 1."),
  status: z.array(z.enum(SANDBOX_STATUSES)).min(1).optional().describe("Only these statuses."),
  limit: z.number().int().min(1).max(200).optional().describe("At most this many. Default 25."),
  externalRef: externalRefInput
    .optional()
    .describe("Only sandboxes launched with this reference that you own or administer."),
});

const modelCatalogText = Object.entries(MODEL_CATALOG)
  .map(
    ([harness, entry]) =>
      `${harness}: ${entry.models.map((option) => `${option.id} (${option.reasoningEfforts.join("|")})`).join(", ")}; ` +
      `default ${entry.defaultModel} ${entry.defaultReasoningEffort}`,
  )
  .join(". ");
const modelInput = z.string().min(1).optional().describe(`The model, by id. ${modelCatalogText}.`);
const effortInput = z.string().min(1).optional().describe("The reasoning effort; one the model accepts (see model).");

const id = sandboxIdInput;
export const DEFAULT_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 600;

function sandboxOperation<
  Input extends z.ZodRawShape,
  Output extends z.ZodRawShape,
  const Branch extends [] | [{ flag: string; operation: string }],
  const Errors extends readonly string[] = [],
>(
  name: string,
  path: `/api/v1/sandbox/${string}`,
  toolName: string,
  audience: Operation<z.ZodType>["audience"],
  tool: {
    title: string;
    description: string;
    mcpDescription?: string;
    input: Input;
    output: Output;
    readOnly?: boolean;
    destructive?: boolean;
    errors?: Errors;
  },
  ...branch: Branch
) {
  const mcpBranch: Branch[0] = branch[0];
  return {
    name,
    route: { method: "POST" as const, path },
    input: { body: z.object({ ...tool.input, org: z.string().nullish() }) },
    output: z.object(tool.output),
    toolName,
    tool,
    mcpBranch,
    readOnly: tool.readOnly ?? false,
    destructive: tool.destructive ?? false,
    audience,
    description: tool.description,
    ...(tool.mcpDescription === undefined ? {} : { mcpDescription: tool.mcpDescription }),
    errors: [...sandboxDispatchErrors, ...(tool.errors ?? [])] as const,
  } satisfies Operation<z.ZodType, z.ZodType> & { toolName: string; tool: typeof tool; mcpBranch: Branch[0] };
}

const stopDescription =
  "Stops the machine. Modal keeps its disk only if checkpoint succeeds; fallback termination returns " +
  "checkpoint_failed_disk_not_retained and cannot resume. Other retained stops can resume on send. Use it when the " +
  "agent is done, so the sandbox stops costing.";
const statusDescription =
  "Where a sandbox and its latest turn are. Modal uses authorized stored observations; physical state is refreshed by the lifecycle worker. Boat is read live. prompt.state is " +
  "queued (accepted by a starting Docker sandbox, not yet admitted by its runtime), running, finished, interrupted or failed; failed includes a usage limit or an expired login, with " +
  "the reason. settled is true when the agent is not working.";

export const sandboxOperations = {
  reportSandbox: sandboxOperation("reportSandbox", "/api/v1/sandbox/report", "report", "agent", {
    title: "Report a task outcome",
    errors: ["conflict"],
    description: `Explicit result for the latest finished turn. Call after status confirms settlement; never inferred from message text. A new send clears it. Only the sandbox owner or current org admin may report or read it.`,
    input: { id, prompt_id: z.string().min(1), outcome: taskOutcome },
    output: { id: z.string(), taskOutcome },
  }),
  sendPrompt: sandboxOperation(
    "sendPrompt",
    "/api/v1/sandbox/send",
    "send",
    "agent",
    {
      title: "Send a prompt",
      mcpDescription:
        "Start a new turn, or set steer to redirect a running turn. Model and effort overrides apply only to new turns. " +
        "Runtime follow-up requires a request ID. Reuse that ID with identical input after uncertain delivery.",
      errors: sandboxControlErrors,
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
          .describe("Request UUID. Reuse it with identical input after uncertain delivery."),
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
    { flag: "steer", operation: "steerSandbox" },
  ),
  steerSandbox: sandboxOperation("steerSandbox", "/api/v1/sandbox/steer", "steer", "public", {
    title: "Steer the running turn",
    destructive: true,
    errors: [...sandboxControlErrors, "no_running_turn"],
    description:
      "Redirects the turn that is running now. delivery says how: in-place joins the turn (Claude Code); " +
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
      delivery: z.enum(["in-place", "restart"]),
      mode: z.string().nullable(),
    },
  }),
  interruptSandbox: sandboxOperation("interruptSandbox", "/api/v1/sandbox/interrupt", "interrupt", "public", {
    title: "Interrupt the running turn",
    destructive: true,
    errors: [...sandboxControlErrors, "no_running_turn"],
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
  }),
  execSandbox: sandboxOperation("execSandbox", "/api/v1/sandbox/exec", "exec", "agent", {
    title: "Run a command",
    errors: sandboxControlErrors,
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
  }),
  stopSandbox: sandboxOperation(
    "stopSandbox",
    "/api/v1/sandbox/stop",
    "stop",
    "agent",
    {
      title: "Stop a sandbox",
      errors: stopSandboxErrors,
      description: stopDescription,
      mcpDescription:
        `${stopDescription} Set turn to interrupt the current turn and keep the machine up. ` +
        "Set after to wait for settlement and stop only if still idle. On timeout this call does not request a stop.",
      input: { id, request_id: z.string().uuid().optional(), only_if_idle: z.boolean().optional() },
      output: { id: z.string(), status: z.enum(SANDBOX_STATUSES), preservationNote: z.string().optional() },
      destructive: true,
    },
    { flag: "turn", operation: "interruptSandbox" },
  ),
  listSandboxes: sandboxOperation("listSandboxes", "/api/v1/sandbox/list", "list", "agent", {
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
  }),
  sandboxStatus: sandboxOperation(
    "sandboxStatus",
    "/api/v1/sandbox/status",
    "status",
    "agent",
    {
      title: "Sandbox status",
      errors: sandboxStatusErrors,
      description: statusDescription,
      mcpDescription: `${statusDescription} Set wait to block until settled or timed out.`,
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
      output: statusOutput,
      readOnly: true,
    },
    { flag: "wait", operation: "waitSandbox" },
  ),
  waitSandbox: sandboxOperation("waitSandbox", "/api/v1/sandbox/wait", "wait", "public", {
    title: "Wait for the agent",
    errors: sandboxStatusErrors,
    description:
      `Blocks until the agent settles (its turn finished, failed or was interrupted, or the machine stopped) ` +
      `or the timeout passes, then answers like status with timedOut. Default ${DEFAULT_WAIT_SECONDS}s, ` +
      `at most ${MAX_WAIT_SECONDS}s: call again to keep waiting.`,
    input: {
      id,
      timeout_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional(),
      prompt_id: z.string().min(1).optional().describe("A specific turn. Default: the latest."),
    },
    output: { ...statusOutput, timedOut: z.boolean() },
    readOnly: true,
  }),
} as const;
