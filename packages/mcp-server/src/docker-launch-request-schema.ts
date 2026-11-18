import { type DockerLaunchRequest, HARNESSES, MAX_MCP_CONNECTIONS, SKILL_PIN_PATTERN } from "@armada/core";
import { z } from "zod";
import { DOCKER_PROMPT } from "./docker-send-request-schema.ts";

// Explicit case classes: JSON Schema patterns drop regex flags, so an `/i` flag would not be published.
const uuid = z.string().regex(/^[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$/);
const binding = (idField: "variableId" | "secretId") =>
  z.strictObject({ key: z.string(), [idField]: uuid, version: z.number().int().min(1) });

/**
 * The normal Docker `sandbox/launch` body (`provider: "docker"`). The normalizer in
 * `docker-normal-launch.ts` refuses any field outside these keys, and the OpenAPI
 * description publishes both source variants. Value rules the normalizer applies
 * beyond shape (model catalog, key names, repository URLs) stay server-side; the
 * first prompt uses the same `DOCKER_PROMPT` value as admission.
 */
const dockerLaunchFields = {
  org: uuid.describe("Organization UUID."),
  provider: z.literal("docker"),
  harness: z.enum(HARNESSES),
  credentialId: uuid.optional().describe("Omit to use the caller's compatible personal default, frozen at admission."),
  credentialVersion: z.number().int().min(1).optional(),
  requestId: uuid.describe("Caller-chosen UUID; replaying it returns the same launch."),
  prompt: DOCKER_PROMPT.optional().describe("First prompt: not blank. The whole request body is limited to 128 KiB."),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  ttlSeconds: z.number().int().min(1).max(86400).optional(),
  visibility: z.literal("private").optional(),
  skills: z.array(z.string().regex(SKILL_PIN_PATTERN)).max(20).optional(),
  skipSkillDefaults: z.boolean().optional(),
  connections: z.array(uuid).max(MAX_MCP_CONNECTIONS).optional().describe("MCP connection UUIDs."),
  variables: z.array(binding("variableId")).max(64).optional(),
  secrets: z.array(binding("secretId")).max(64).optional(),
};

/** The official Armada environment on a chosen host, optionally with repository checkouts. */
export const DOCKER_HOST_LAUNCH_REQUEST = z
  .strictObject({
    ...dockerLaunchFields,
    hostId: uuid.describe("Docker host UUID."),
    repos: z
      .array(z.strictObject({ url: z.string(), branch: z.string().optional(), dir: z.string().optional() }))
      .optional()
      .describe("GitHub repositories to check out as shallow single-branch clones."),
  })
  .describe("Launch on a registered Docker host from the official Armada environment. There is no golden.");

/** A Docker snapshot, which selects its own host and carries its own workspace (no repos). */
export const DOCKER_SNAPSHOT_LAUNCH_REQUEST = z
  .strictObject({
    ...dockerLaunchFields,
    snapshotId: uuid.describe("Docker snapshot UUID. It selects the host and workspace."),
    hostId: uuid.optional().describe("Optional; when present it must be the snapshot's host."),
  })
  .describe("Launch from a Docker snapshot on the host that holds it. There is no golden and no repos.");

export const DOCKER_LAUNCH_REQUEST = z.union([DOCKER_HOST_LAUNCH_REQUEST, DOCKER_SNAPSHOT_LAUNCH_REQUEST]);

type DockerLaunchKey =
  | keyof z.input<typeof DOCKER_HOST_LAUNCH_REQUEST>
  | keyof z.input<typeof DOCKER_SNAPSHOT_LAUNCH_REQUEST>;
/** Every field of the core request type is accepted by some variant, and nothing else. */
const dockerFieldsMatchCore: [
  Exclude<keyof DockerLaunchRequest, DockerLaunchKey>,
  Exclude<DockerLaunchKey, keyof DockerLaunchRequest>,
] extends [never, never]
  ? true
  : never = true;
void dockerFieldsMatchCore;

export const DOCKER_LAUNCH_FIELDS: readonly string[] = [
  ...new Set([...Object.keys(DOCKER_HOST_LAUNCH_REQUEST.shape), ...Object.keys(DOCKER_SNAPSHOT_LAUNCH_REQUEST.shape)]),
];
