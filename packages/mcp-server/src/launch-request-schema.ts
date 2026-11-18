import {
  HARNESSES,
  MACHINE_SIZES,
  MAX_EXTERNAL_REF_LENGTH,
  MAX_LAUNCH_TTL_SECONDS,
  MAX_MCP_CONNECTIONS,
  SANDBOX_PROVIDERS,
  SKILL_PIN_PATTERN,
} from "@armada/core";
import { launch } from "@armada/core/contract";
import { z } from "zod";

const dockerLaunchVariants = launch.input.body.options.filter((variant) => variant.shape.provider.value === "docker");

// Explicit case classes: JSON Schema patterns drop regex flags, so an `/i` flag would not be published.
const launchUuid = z.string().regex(/^[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$/);
const sharedRestLaunchFields = {
  harness: z.enum(HARNESSES),
  credentialId: launchUuid.optional(),
  skills: z.array(z.string().regex(SKILL_PIN_PATTERN)).max(20).optional(),
  skipSkillDefaults: z.boolean().optional(),
  connections: z.array(launchUuid).max(MAX_MCP_CONNECTIONS).optional(),
  stopWhenWorkMerged: z.boolean().optional(),
};

const launchCorrelationFields = {
  idempotencyKey: z.string().min(16).max(128).optional(),
  externalRef: z
    .string()
    .min(1)
    .max(MAX_EXTERNAL_REF_LENGTH)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: controls are explicitly excluded from external references
    .regex(/^[^\x00-\x1f\x7f-\x9f]+(?![\s\S])/)
    .optional(),
};

const goldenFields = {
  golden: z.string().min(1).describe("The name returned by golden/list."),
  org: z.string().nullish().describe("Organization name or ID. Required for ambiguous golden names."),
  model: z.string().nullish(),
  reasoningEffort: z.string().nullish(),
  ttlSeconds: z.number().int().min(1).max(MAX_LAUNCH_TTL_SECONDS).optional(),
  prompt: z.string().nullish().describe("First instruction. Omit for an idle sandbox."),
  size: z.enum(MACHINE_SIZES).optional(),
  sizePolicyVersion: z.literal(1).optional(),
  repo: z.string().min(1).optional().describe("Configured directory or owner/repo from the golden."),
  visibility: z.enum(["private", "org"]).optional(),
  ...sharedRestLaunchFields,
  ...launchCorrelationFields,
};

const goldenLaunch = z
  .strictObject({
    ...goldenFields,
    provider: z.enum(SANDBOX_PROVIDERS).nullish(),
    helperCapabilities: z.array(z.string().max(64)).max(8).optional(),
    armadaAccessVersion: z.literal(1).optional(),
    armadaAccess: z
      .union([z.boolean(), z.strictObject({ maxActiveChildren: z.number().int().min(1).max(100).optional() })])
      .optional(),
  })
  .describe("Launch from a golden with the server's default runtime selection.");

const explicitRuntimeFields = {
  ...goldenFields,
  prompt: z.string().optional(),
  runtimeVersion: z.literal(1),
  helperCapabilities: z.array(z.string()).max(0).optional(),
  armadaAccess: z.literal(false).optional(),
};

const boatRuntimeLaunch = z
  .strictObject({
    ...explicitRuntimeFields,
    provider: z.literal("boat").optional(),
    boatRuntime: z.literal(true),
  })
  .describe("Explicit Boat runtime launch from a golden.");

const modalRuntimeLaunch = z
  .strictObject({
    ...explicitRuntimeFields,
    provider: z.literal("modal"),
    runtimeTransport: z.literal("dialout"),
  })
  .describe("Explicit Modal runtime launch from a golden.");

const pinnedTemplateFields = {
  org: launchUuid,
  id: launchUuid,
  revision: z.number().int().positive(),
  requestKey: z
    .string()
    .regex(/^[A-Za-z0-9._:-]+$/)
    .max(128),
  prompt: z.string().min(1).max(100000).optional(),
  ttlSeconds: z.number().int().positive().optional(),
  size: goldenFields.size,
  repo: z.string().min(1).max(200).optional(),
  skills: sharedRestLaunchFields.skills.nullable(),
  skipSkillDefaults: sharedRestLaunchFields.skipSkillDefaults,
  externalRef: launchCorrelationFields.externalRef,
  stopWhenWorkMerged: sharedRestLaunchFields.stopWhenWorkMerged,
};

export const PINNED_MODAL_TEMPLATE_FIELDS = Object.keys(pinnedTemplateFields);

export const PINNED_MODAL_LAUNCH_REQUEST = z
  .strictObject({
    ...pinnedTemplateFields,
    provider: z.literal("modal"),
    harness: z.enum(["codex", "claude", "opencode"]),
    runtimeVersion: z.literal(1),
    runtimeTransport: z.literal("dialout"),
  })
  .describe("Launch a pinned Modal template revision with the template's model account and explicit dial-out.");

export const GOLDEN_LAUNCH_REQUEST = z.union([goldenLaunch, boatRuntimeLaunch, modalRuntimeLaunch]);

export const LAUNCH_REQUEST_VARIANTS = [
  goldenLaunch,
  boatRuntimeLaunch,
  modalRuntimeLaunch,
  PINNED_MODAL_LAUNCH_REQUEST,
  ...dockerLaunchVariants,
] as const;
