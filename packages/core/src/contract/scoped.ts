import { z } from "zod";
import type { DelegatedScope } from "../delegated-access.ts";
import { HARNESSES } from "../harnesses.ts";
import { MACHINE_SIZES } from "../machine-size.ts";
import { SANDBOX_PROVIDERS } from "../sandbox-provider.ts";
import { INVALID_SKILL_PINS_MESSAGE } from "../skill-pins.ts";
import { LOGS_OUTPUT, modelOutput, SANDBOX_STATUSES, skillReceipts, statusOutput } from "./sandbox.ts";
import { sandboxExtensionLifetime } from "./sandbox-rest.ts";

const key = z.string().regex(/^[ -~]{1,128}$/);
const text = z.string().min(1).max(100_000).regex(/\S/);
const selection = z
  .object({
    goldenId: z.uuid(),
    harness: z.enum(HARNESSES),
    credentialId: z.uuid(),
    credentialVersion: z.number().int().positive().safe(),
    model: z.string().min(1).max(200).describe("Child launch admission requires a non-blank model."),
    skills: z
      .array(z.string())
      .max(20)
      .optional()
      .describe(
        `${INVALID_SKILL_PINS_MESSAGE} Each pin is at most 256 characters. Slugs must be unique across namespaces and versions. The armada-tools slug is reserved.`,
      ),
    reasoningEffort: z
      .string()
      .min(1)
      .optional()
      .describe("If supplied, child launch admission requires non-blank reasoning effort."),
    repo: z.string().min(1).optional().describe("If supplied, child launch admission requires a non-blank repository."),
    prompt: text.optional(),
    size: z.enum(MACHINE_SIZES).optional(),
  })
  .strict();
const child = "Scoped own-child operation. No owner/admin/credential/general sandbox authority.";

export const scopedOperations = {
  finish: {
    scope: "worker:stop",
    description:
      "Declare this sandbox finished. Stops Boat/Modal; permanently removes the Docker container and home volume immediately after work-preservation policy runs. Runtime Git archives are unavailable: push all work first. No target id; affects only this sandbox.",
    input: z.object({}).strict(),
  },
  launch: {
    scope: "worker:launch",
    description: child,
    input: z.object({ idempotencyKey: key, selection }).strict(),
  },
  read: {
    scope: "worker:read",
    description: child,
    input: z.object({ sandboxId: z.uuid() }).strict(),
  },
  message: {
    scope: "worker:message",
    description: child,
    input: z.object({ idempotencyKey: key, sandboxId: z.uuid(), text }).strict(),
  },
  stop: {
    scope: "worker:stop",
    description: child,
    input: z.object({ idempotencyKey: key, sandboxId: z.uuid() }).strict(),
  },
  extend: {
    scope: "worker:extend",
    description: child,
    input: z.object({ idempotencyKey: key, sandboxId: z.uuid(), ttlSeconds: sandboxExtensionLifetime }).strict(),
  },
} as const satisfies Record<string, { scope: DelegatedScope; description: string; input: z.ZodObject }>;

type ScopedMethod = keyof typeof scopedOperations;
export const isScopedMethod = (name: string): name is ScopedMethod => Object.hasOwn(scopedOperations, name);

export const ORCHESTRATOR_SCOPED_PATH = "/api/v1/orchestrator-tools";
export const SCOPED_REST_BODY_MAX_BYTES = 128 * 1024;

const scopedErrorCode = z.enum([
  "invalid_epoch_authority",
  "use_post",
  "scoped_method_denied",
  "invalid_scoped_request",
  "scoped_authority_denied",
  "scoped_operation_unavailable",
]);
export type ScopedErrorCode = z.infer<typeof scopedErrorCode>;
const errorOutput = z.object({ error: z.object({ code: scopedErrorCode, message: scopedErrorCode }) });

const receipt = z.object({
  id: z.uuid(),
  state: z.enum(["pending", "succeeded", "failed", "uncertain"]),
  sandboxId: z.uuid(),
});
const machineSize = z.enum(MACHINE_SIZES).nullable();
const sandboxUsage = statusOutput.usage.unwrap().unwrap();
const scopedUsage = sandboxUsage.extend({
  turns: z.array(
    sandboxUsage.shape.turns.element.extend({
      cacheWriteTokensByTtl: z
        .object({
          fiveMinute: z.number().nullable(),
          oneHour: z.number().nullable(),
          conflicted: z.literal(true).optional(),
        })
        .optional(),
    }),
  ),
});

const readResult = z.looseObject({
  id: z.uuid(),
  provider: z.enum(SANDBOX_PROVIDERS),
  providerSandboxId: z.string(),
  goldenId: z.uuid(),
  orgId: z.uuid(),
  ownerId: z.uuid(),
  harness: z.enum(HARNESSES),
  status: z.enum(SANDBOX_STATUSES),
  conversationIds: z.array(z.string()),
  createdAt: z.string(),
  stoppedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  statusReason: z.string().nullable(),
  repositoryDir: z.string().nullable(),
  model: modelOutput.model,
  reasoningEffort: modelOutput.reasoningEffort,
  credentialId: modelOutput.credentialId.unwrap(),
  credentialVersion: modelOutput.credentialVersion.unwrap(),
  boatRuntime: z.literal(true).optional(),
  runtimeTransport: z.literal("dialout").optional(),
  visibility: statusOutput.visibility.optional(),
  expiresAt: z.string().optional(),
  effectiveTtlSeconds: z.number().optional(),
  requestedTtlSeconds: z.number().nullable().optional(),
  lastObservedAt: z.string().nullable().optional(),
  lifecycleError: z.string().nullable().optional(),
  lifecycleGeneration: z.number().int().positive().optional(),
  stopRequestedAt: z.string().nullable(),
  preservationNote: statusOutput.preservationNote.unwrap(),
  usage: scopedUsage.nullable(),
  taskOutcome: statusOutput.taskOutcome.unwrap(),
  pullRequests: statusOutput.pullRequests,
  externalRef: statusOutput.externalRef,
  taskPromptId: z.string().nullable(),
  skills: z.array(skillReceipts.unwrap().element.extend({ workspaceId: z.string().optional() })),
  resourceProject: z.object({ version: z.literal(1), url: z.string(), branch: z.string(), dir: z.string() }).nullable(),
  machineSize: z
    .object({
      version: z.literal(1),
      requested: machineSize,
      effective: machineSize,
      source: z.enum(["override", "repository", "golden", "legacy"]),
      repositoryDir: z.string().nullable(),
      capacity: z
        .object({
          provider: z.enum(SANDBOX_PROVIDERS),
          provenance: z.literal("requested-provider-resources"),
          vcpus: z.number(),
          memoryMiB: z.number(),
          cpuPhysicalCores: z.number().nullable(),
          cpuLimitPhysicalCores: z.number().nullable(),
          memoryLimitMiB: z.number().nullable(),
          boatType: z.enum(["small", "default", "large", "xlarge"]).nullable(),
        })
        .nullable(),
    })
    .nullable(),
  events: LOGS_OUTPUT.events,
  cursor: LOGS_OUTPUT.cursor,
  hasMore: LOGS_OUTPUT.hasMore,
});

function scopedRest<Method extends ScopedMethod, Body extends z.ZodObject, Result extends z.ZodType>(
  method: Method,
  body: Body,
  result: Result,
  options: { idempotent?: true; readOnly?: true; destructive?: true; description?: string } = {},
) {
  return {
    name: `scoped_${method}` as const,
    route: { method: "POST", path: `${ORCHESTRATOR_SCOPED_PATH}/${method}` as const },
    input: {
      body,
      maxBodyBytes: SCOPED_REST_BODY_MAX_BYTES,
      oversizedBodyStatus: 400,
      ...(options.idempotent && { headers: { "Idempotency-Key": key } }),
    },
    output: z.object({ result }),
    errorOutput,
    directServer: true,
    scopedAuth: method === "finish" ? (["epochGrant", "finishGrant"] as const) : (["epochGrant"] as const),
    audience: "public",
    readOnly: options.readOnly ?? false,
    destructive: options.destructive ?? false,
    description: options.description ?? scopedOperations[method].description,
    errors: scopedErrorCode.options,
  } as const;
}

export const scopedRestOperations = {
  finish: scopedRest(
    "finish",
    scopedOperations.finish.input,
    z.object({ id: z.uuid(), status: z.literal("stopping"), preservationNote: z.string().optional() }),
    {
      destructive: true,
      description:
        "Declare the calling sandbox finished and request its stop. Docker completion also schedules permanent removal of the container and home volume. Push work before finishing because runtime Git archives are unavailable. The response confirms the stop request, with status stopping.",
    },
  ),
  launch: scopedRest("launch", scopedOperations.launch.input.omit({ idempotencyKey: true }), receipt, {
    idempotent: true,
  }),
  read: scopedRest("read", scopedOperations.read.input, readResult, { readOnly: true }),
  message: scopedRest("message", scopedOperations.message.input.omit({ idempotencyKey: true }), receipt, {
    idempotent: true,
  }),
  stop: scopedRest("stop", scopedOperations.stop.input.omit({ idempotencyKey: true }), receipt, {
    idempotent: true,
    destructive: true,
  }),
  extend: scopedRest("extend", scopedOperations.extend.input.omit({ idempotencyKey: true }), receipt, {
    idempotent: true,
  }),
};
