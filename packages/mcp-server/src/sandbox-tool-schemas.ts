import { isExternalRef, LAUNCH_STAGES, SANDBOX_PLACEMENT_PROVIDERS, USAGE_UNAVAILABLE_CODES } from "@armada/core";
import { HARNESSES } from "@armada/core/server";
import * as z from "zod";

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

export const externalRefOutput = z.string().optional().describe("Opaque reference given at launch; absent when none.");
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
