import { z } from "zod";
import { HARNESSES } from "../harnesses.ts";
import { MACHINE_SIZES } from "../machine-size.ts";
import { MAX_MCP_CONNECTIONS } from "../mcp-launch-selection.ts";
import { MAX_EXTERNAL_REF_LENGTH } from "../sandbox.ts";
import { PROVIDER_LIMITS, type SandboxPlacementProviderId } from "../sandbox-provider.ts";
import { SKILL_PIN_PATTERN } from "../skill-pins.ts";

// Explicit case classes keep the pattern equivalent when exported to JSON Schema.
const uuid = z.string().regex(/^[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$/);
const nonBlank = z.string().regex(/\S/);
const skillPins = z.array(z.string().max(256).regex(SKILL_PIN_PATTERN)).max(20);
const idempotencyKey = z.string().min(16).max(128);
const size = z.enum(MACHINE_SIZES).optional();

const common = {
  org: nonBlank.optional().describe("Organization slug or UUID."),
  harness: z.enum(HARNESSES),
  skills: skillPins.optional(),
  skipSkillDefaults: z.boolean().optional(),
  stopWhenWorkMerged: z.boolean().optional(),
  externalRef: z
    .string()
    .min(1)
    .max(MAX_EXTERNAL_REF_LENGTH)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are excluded from external references
    .regex(/^[^\x00-\x1f\x7f-\x9f]+(?![\s\S])/)
    .optional(),
};

function ttl(provider: SandboxPlacementProviderId) {
  return z.number().int().min(1).max(PROVIDER_LIMITS[provider].maxTtlSeconds).optional();
}

const selectable = {
  credentialId: uuid.optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  connections: z.array(uuid).max(MAX_MCP_CONNECTIONS).optional(),
};

const golden = {
  ...common,
  ...selectable,
  golden: nonBlank.describe("The name returned by golden discovery."),
  prompt: nonBlank.optional(),
  size,
  sizePolicyVersion: z.literal(1).optional(),
  repo: nonBlank.optional(),
  visibility: z.enum(["private", "org"]).optional(),
  idempotencyKey: idempotencyKey.optional(),
};

const defaultRuntime = {
  helperCapabilities: z.array(z.string().max(64)).max(8).optional(),
  armadaAccessVersion: z.literal(1).optional(),
  armadaAccess: z
    .union([z.boolean(), z.strictObject({ maxActiveChildren: z.number().int().min(1).max(100).optional() })])
    .optional(),
};

const explicitRuntime = {
  runtimeVersion: z.literal(1),
  helperCapabilities: z.tuple([]).optional(),
  armadaAccess: z.literal(false).optional(),
};

const boat = { ...golden, provider: z.literal("boat"), ttlSeconds: ttl("boat") };
const modal = { ...golden, provider: z.literal("modal"), ttlSeconds: ttl("modal") };
const pinnedModal = z.strictObject({
  ...common,
  provider: z.literal("modal"),
  runtimeVersion: z.literal(1),
  runtimeTransport: z.literal("dialout"),
  id: uuid,
  revision: z.number().int().positive(),
  requestKey: z
    .string()
    .regex(/^[A-Za-z0-9._:-]+$/)
    .max(128),
  prompt: nonBlank.max(100000).optional(),
  ttlSeconds: ttl("modal"),
  size,
  repo: nonBlank.max(200).optional(),
  skills: skillPins.nullish(),
});

const bindingFields = { key: z.string(), version: z.number().int().positive() };
const dockerPromptMaxBytes = 256 * 1024;
const docker = {
  ...common,
  ...selectable,
  provider: z.literal("docker"),
  ttlSeconds: ttl("docker"),
  visibility: z.literal("private").optional(),
  credentialVersion: z.number().int().positive().optional(),
  prompt: nonBlank
    .max(dockerPromptMaxBytes)
    .refine((prompt) => new TextEncoder().encode(prompt).byteLength <= dockerPromptMaxBytes)
    .optional(),
  variables: z
    .array(z.strictObject({ ...bindingFields, variableId: uuid }))
    .max(64)
    .optional(),
  secrets: z
    .array(z.strictObject({ ...bindingFields, secretId: uuid }))
    .max(64)
    .optional(),
};

const host = {
  hostId: uuid,
  repos: z
    .array(z.strictObject({ url: z.string(), branch: z.string().optional(), dir: z.string().optional() }))
    .optional(),
};
const snapshot = { snapshotId: uuid, hostId: uuid.optional() };

// Each strict variant carries its provider literal. Providers with multiple
// source and runtime forms use distinct objects so mixed fields are rejected.
export const launchInput = z.union([
  z.strictObject({ ...boat, ...defaultRuntime }),
  z.strictObject({ ...boat, ...explicitRuntime, boatRuntime: z.literal(true) }),
  z.strictObject({ ...modal, ...defaultRuntime }),
  z.strictObject({ ...modal, ...explicitRuntime, runtimeTransport: z.literal("dialout") }),
  pinnedModal,
  z.strictObject({ ...docker, ...host, requestId: uuid }),
  z.strictObject({ ...docker, ...snapshot, requestId: uuid }),
  z.strictObject({ ...docker, ...host, idempotencyKey }),
  z.strictObject({ ...docker, ...snapshot, idempotencyKey }),
]);

export type LaunchInput = z.input<typeof launchInput>;
