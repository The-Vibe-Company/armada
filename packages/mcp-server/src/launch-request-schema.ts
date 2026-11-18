import {
  HARNESSES,
  MACHINE_SIZES,
  MAX_LAUNCH_TTL_SECONDS,
  MAX_MCP_CONNECTIONS,
  SANDBOX_PROVIDERS,
  SKILL_PIN_PATTERN,
} from "@armada/core";
import { z } from "zod";
import { DOCKER_LAUNCH_VARIANTS, launchCorrelationFields, launchUuid } from "./docker-launch-request-schema.ts";

const goldenFields = {
  golden: z.string().min(1).describe("The name returned by golden/list."),
  org: z.string().nullish().describe("Organization name or ID. Required for ambiguous golden names."),
  harness: z.enum(HARNESSES),
  model: z.string().nullish(),
  reasoningEffort: z.string().nullish(),
  ttlSeconds: z.number().int().min(1).max(MAX_LAUNCH_TTL_SECONDS).optional(),
  prompt: z.string().nullish().describe("First instruction. Omit for an idle sandbox."),
  size: z.enum(MACHINE_SIZES).optional(),
  sizePolicyVersion: z.literal(1).optional(),
  repo: z.string().min(1).optional().describe("Configured directory or owner/repo from the golden."),
  credentialId: launchUuid.optional(),
  visibility: z.enum(["private", "org"]).optional(),
  skills: z.array(z.string().regex(SKILL_PIN_PATTERN)).max(20).optional(),
  skipSkillDefaults: z.boolean().optional(),
  connections: z.array(launchUuid).max(MAX_MCP_CONNECTIONS).optional(),
  stopWhenWorkMerged: z.boolean().optional(),
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

export const GOLDEN_LAUNCH_REQUEST = z.union([goldenLaunch, boatRuntimeLaunch, modalRuntimeLaunch]);

export const LAUNCH_REQUEST_VARIANTS = [
  goldenLaunch,
  boatRuntimeLaunch,
  modalRuntimeLaunch,
  ...DOCKER_LAUNCH_VARIANTS,
] as const;
