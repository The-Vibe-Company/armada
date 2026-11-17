import { type DockerLaunchRequest, HARNESSES, MAX_MCP_CONNECTIONS, SKILL_PIN_PATTERN } from "@armada/core";
import { z } from "zod";

const uuid = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
const binding = (idField: "variableId" | "secretId") =>
  z.strictObject({ key: z.string(), [idField]: uuid, version: z.number().int().min(1) });

/**
 * The normal Docker `sandbox/launch` body (`provider: "docker"`). The normalizer in
 * `docker-normal-launch.ts` refuses any field outside this schema's keys, and the
 * OpenAPI description publishes it as the Docker launch variant. Value rules the
 * normalizer applies beyond shape (model catalog, key names, repository URLs) stay
 * server-side.
 */
export const DOCKER_LAUNCH_REQUEST = z
  .strictObject({
    org: uuid.describe("Organization UUID."),
    provider: z.literal("docker"),
    hostId: uuid.optional().describe("Docker host UUID. Required unless snapshotId selects the host."),
    snapshotId: uuid.optional().describe("Docker snapshot UUID; cannot be combined with repos."),
    harness: z.enum(HARNESSES),
    credentialId: uuid
      .optional()
      .describe("Omit to use the caller's compatible personal default, frozen at admission."),
    credentialVersion: z.number().int().min(1).optional(),
    requestId: uuid.describe("Caller-chosen UUID; replaying it returns the same launch."),
    prompt: z.string().min(1).optional().describe("First prompt. The whole request body is limited to 128 KiB."),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    ttlSeconds: z.number().int().min(1).max(86400).optional(),
    visibility: z.literal("private").optional(),
    skills: z.array(z.string().regex(SKILL_PIN_PATTERN)).max(20).optional(),
    skipSkillDefaults: z.boolean().optional(),
    connections: z.array(uuid).max(MAX_MCP_CONNECTIONS).optional().describe("MCP connection UUIDs."),
    repos: z
      .array(
        z.strictObject({
          url: z.string(),
          branch: z.string().optional(),
          dir: z.string().optional(),
          history: z.enum(["full", "shallow"]).optional(),
        }),
      )
      .optional()
      .describe("GitHub repositories to check out, as in a golden config."),
    variables: z.array(binding("variableId")).max(64).optional(),
    secrets: z.array(binding("secretId")).max(64).optional(),
  })
  .describe("Launch on a registered Docker host from the official Armada environment. There is no golden.");

/** Every field of the core request type is accepted, and nothing else. */
const dockerFieldsMatchCore: [
  Exclude<keyof DockerLaunchRequest, keyof z.input<typeof DOCKER_LAUNCH_REQUEST>>,
  Exclude<keyof z.input<typeof DOCKER_LAUNCH_REQUEST>, keyof DockerLaunchRequest>,
] extends [never, never]
  ? true
  : never = true;
void dockerFieldsMatchCore;

export const DOCKER_LAUNCH_FIELDS: readonly string[] = Object.keys(DOCKER_LAUNCH_REQUEST.shape);
