import {
  type DockerLaunchRequest,
  HARNESSES,
  MAX_EXTERNAL_REF_LENGTH,
  MAX_MCP_CONNECTIONS,
  PROVIDER_LIMITS,
  SKILL_PIN_PATTERN,
} from "@armada/core";
import { z } from "zod";
import { DOCKER_PROMPT } from "./docker-send-request-schema.ts";

// Explicit case classes: JSON Schema patterns drop regex flags, so an `/i` flag would not be published.
export const launchUuid = z.string().regex(/^[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$/);
const binding = (idField: "variableId" | "secretId") =>
  z.strictObject({ key: z.string(), [idField]: launchUuid, version: z.number().int().min(1) });

/**
 * The normal Docker `sandbox/launch` body (`provider: "docker"`). The normalizer in
 * `docker-normal-launch.ts` refuses any field outside these keys, and the OpenAPI
 * description publishes both source variants. Value rules the normalizer applies
 * beyond shape (model catalog, key names, repository URLs) stay server-side; the
 * first prompt uses the same `DOCKER_PROMPT` value as admission.
 */
export const launchCorrelationFields = {
  idempotencyKey: z.string().min(16).max(128).optional(),
  externalRef: z
    .string()
    .min(1)
    .max(MAX_EXTERNAL_REF_LENGTH)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: controls are explicitly excluded from external references
    .regex(/^[^\x00-\x1f\x7f-\x9f]+(?![\s\S])/)
    .optional(),
};

const dockerLaunchFields = {
  externalRef: launchCorrelationFields.externalRef,
  org: z.string().min(1).optional().describe("Organization name or UUID. Omit when scoped to one organization."),
  provider: z.literal("docker"),
  harness: z.enum(HARNESSES),
  credentialId: launchUuid
    .optional()
    .describe("Omit to use the caller's compatible personal default, frozen at admission."),
  credentialVersion: z.number().int().min(1).optional(),
  prompt: DOCKER_PROMPT.optional().describe("First prompt: not blank. The whole request body is limited to 128 KiB."),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  ttlSeconds: z.number().int().min(1).max(PROVIDER_LIMITS.docker.maxTtlSeconds).optional(),
  visibility: z.literal("private").optional(),
  skills: z.array(z.string().regex(SKILL_PIN_PATTERN)).max(20).optional(),
  skipSkillDefaults: z.boolean().optional(),
  stopWhenWorkMerged: z
    .boolean()
    .optional()
    .describe("Default true: stop the sandbox once every pull request it opened is merged and the agent is idle."),
  connections: z.array(launchUuid).max(MAX_MCP_CONNECTIONS).optional().describe("MCP connection UUIDs."),
  variables: z.array(binding("variableId")).max(64).optional(),
  secrets: z.array(binding("secretId")).max(64).optional(),
};

/** The official Armada environment on a chosen host, optionally with repository checkouts. */
const hostSource = {
  hostId: launchUuid.describe("Docker host UUID."),
  repos: z
    .array(z.strictObject({ url: z.string(), branch: z.string().optional(), dir: z.string().optional() }))
    .optional()
    .describe(
      "GitHub repositories to check out with bounded history: enough to find a merge base with the default branch.",
    ),
};

/** A snapshot selects its own host and carries its own workspace. */
const snapshotSource = {
  snapshotId: launchUuid.describe("Docker snapshot UUID. It selects the host and workspace."),
  hostId: launchUuid.optional().describe("Optional; when present it must be the snapshot's host."),
};

const requestId = launchUuid.describe("Legacy caller-chosen replay UUID.");
const idempotencyKey = launchCorrelationFields.idempotencyKey
  .unwrap()
  .describe("Replay key scoped to the caller and organization.");

export const DOCKER_LAUNCH_VARIANTS = [
  z
    .strictObject({ ...dockerLaunchFields, ...hostSource, requestId })
    .describe("Launch on a Docker host with a request UUID."),
  z
    .strictObject({ ...dockerLaunchFields, ...snapshotSource, requestId })
    .describe("Launch from a Docker snapshot with a request UUID."),
  z
    .strictObject({ ...dockerLaunchFields, ...hostSource, idempotencyKey })
    .describe("Launch on a Docker host with an idempotency key."),
  z
    .strictObject({ ...dockerLaunchFields, ...snapshotSource, idempotencyKey })
    .describe("Launch from a Docker snapshot with an idempotency key."),
] as const;
export const DOCKER_LAUNCH_REQUEST = z.union(DOCKER_LAUNCH_VARIANTS);

type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type DockerLaunchKey = KeysOfUnion<z.input<typeof DOCKER_LAUNCH_REQUEST>>;
/** Every field of the core request type is accepted by some variant, and nothing else. */
const dockerFieldsMatchCore: [
  Exclude<keyof DockerLaunchRequest, DockerLaunchKey>,
  Exclude<DockerLaunchKey, keyof DockerLaunchRequest>,
] extends [never, never]
  ? true
  : never = true;
void dockerFieldsMatchCore;

export const DOCKER_LAUNCH_FIELDS: readonly string[] = [
  ...new Set(DOCKER_LAUNCH_VARIANTS.flatMap((variant) => Object.keys(variant.shape))),
];
