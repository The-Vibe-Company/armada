import { z } from "zod";
import { MAX_SANDBOX_EXTENSION_TTL_SECONDS } from "../sandbox-lifetime.ts";
import type { Operation } from "./index.ts";
import { sandboxIdInput as id } from "./sandbox.ts";

const org = z.string().nullish();
const controlErrors = ["internal", "invalid", "unavailable", "unauthorized", "forbidden", "not_found"] as const;

export const sandboxExtensionLifetime = z.number().int().positive().max(MAX_SANDBOX_EXTENSION_TTL_SECONDS);
const absent = z.never().optional();
const extendBody = z.union([
  z.object({ id, ttlSeconds: sandboxExtensionLifetime, ttl_seconds: absent, org }),
  z.object({ id, ttl_seconds: sandboxExtensionLifetime, ttlSeconds: absent, org }),
]);
const runtimeRequest = z.object({ id, request_id: z.string().uuid(), runtimeVersion: z.literal(1), org });
const runtime = z.object({ kind: z.literal("armada"), epoch: z.string() });

export const sandboxRestOperations = {
  resumeSandbox: {
    name: "resumeSandbox",
    route: { method: "POST", path: "/api/v1/sandbox/resume" },
    readOnly: false,
    destructive: false,
    audience: "public",
    errors: [...controlErrors, "unsupported", "conflict", "docker_host_upgrade_required"],
    description:
      "Owner-only. Restarts the same Docker allocation with fresh runtime enrolment, keeping history and the original TTL. Reuse request_id after uncertainty.",
    input: { body: z.object({ id, request_id: z.string().uuid(), org }) },
    output: z.object({ id: z.string(), status: z.literal("ready") }),
  },
  extendSandbox: {
    name: "extendSandbox",
    route: { method: "POST", path: "/api/v1/sandbox/extend" },
    readOnly: false,
    destructive: false,
    audience: "public",
    errors: [
      ...controlErrors,
      "extension_maximum",
      "extension_not_allowed",
      "extension_not_found",
      "extension_state",
      "rate_limited",
    ],
    description:
      "Set a later expiry, measured from now. Owner/admin only. Modal extensions must fit inside the current physical machine lifetime; stop and resume for a new physical lifetime.",
    input: { body: extendBody },
    output: z.object({ id: z.string(), expiresAt: z.string(), ttlSeconds: z.number().int() }),
  },
  sandboxAdvice: {
    name: "sandboxAdvice",
    route: { method: "POST", path: "/api/v1/sandbox/advice" },
    readOnly: false,
    destructive: false,
    audience: "public",
    errors: [...controlErrors, "dependency_unavailable"],
    description:
      "Collects one bounded read-only VM observation and reports the last ten comparable repository sessions. Missing evidence causes abstention; never resizes or changes defaults.",
    input: { body: z.object({ id, org }) },
    output: z.object({ advice: z.unknown() }),
  },
  recoverSandbox: {
    name: "recoverSandbox",
    route: { method: "POST", path: "/api/v1/sandbox/recovery" },
    readOnly: true,
    destructive: false,
    audience: "public",
    errors: [...controlErrors, "dependency_unavailable"],
    description: "Owner/admin only. Returns sensitive base64 recovery archive; never log it.",
    input: { body: z.object({ id, recovery_id: z.string().uuid().optional(), org }) },
    output: z.object({ archive: z.string().nullable() }),
  },
  postSandboxCheckpointRuntimeV1: {
    name: "postSandboxCheckpointRuntimeV1",
    route: { method: "POST", path: "/api/v1/sandbox/checkpoint-runtime-v1" },
    readOnly: false,
    destructive: false,
    audience: "public",
    errors: [...controlErrors, "unsupported", "conflict"],
    description: "Capture the current Armada runtime checkpoint.",
    input: { body: runtimeRequest },
    output: z.object({
      id: z.string(),
      requestId: z.string(),
      runtime,
      checkpoint: z.object({
        state: z.literal("complete"),
        watermark: z.number().int().nonnegative(),
        acknowledgedSequence: z.number().int().nonnegative(),
      }),
    }),
  },
  postSandboxResumeRuntimeV1: {
    name: "postSandboxResumeRuntimeV1",
    route: { method: "POST", path: "/api/v1/sandbox/resume-runtime-v1" },
    readOnly: false,
    destructive: false,
    audience: "public",
    errors: [...controlErrors, "unsupported", "conflict"],
    description: "Resume an Armada runtime from its checkpoint and queue a prompt.",
    input: {
      body: runtimeRequest.extend({
        prompt: z.string().min(1),
      }),
    },
    output: z.object({
      id: z.string(),
      requestId: z.string(),
      promptId: z.string(),
      conversationId: z.string(),
      status: z.enum(["queued", "running", "finished", "failed", "interrupted"]),
      resumed: z.literal(true),
      runtime,
      sourceCheckpoint: z.object({
        epoch: z.string(),
        watermark: z.number().int().nonnegative(),
        empty: z.literal(true).optional(),
      }),
    }),
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType>>;
