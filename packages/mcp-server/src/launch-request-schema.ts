import { MACHINE_SIZES, MAX_LAUNCH_TTL_SECONDS, SANDBOX_PROVIDERS, SKILL_PIN_PATTERN } from "@armada/core";
import { launch } from "@armada/core/contract";
import { z } from "zod";

const sharedLaunchVariants = launch.input.body.options.filter(
  (variant) => variant.shape.provider.value === "docker" || "runtimeVersion" in variant.shape,
);

const [boatLaunch] = launch.input.body.options;
const { credentialId, connections, externalRef, harness, idempotencyKey, skipSkillDefaults, stopWhenWorkMerged } =
  boatLaunch.shape;
const sharedRestLaunchFields = {
  harness,
  credentialId,
  skills: z.array(z.string().regex(SKILL_PIN_PATTERN)).max(20).optional(),
  skipSkillDefaults,
  connections,
  stopWhenWorkMerged,
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
  idempotencyKey,
  externalRef,
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

type SharedLaunchRequest = z.output<typeof launch.input.body>;
type ExplicitGoldenLaunchRequest = Extract<SharedLaunchRequest, { golden: string; runtimeVersion: 1 }>;

export const GOLDEN_LAUNCH_REQUEST = goldenLaunch;

export type GoldenLaunchRequest = z.output<typeof goldenLaunch> | ExplicitGoldenLaunchRequest;

export const LAUNCH_REQUEST_VARIANTS = [goldenLaunch, ...sharedLaunchVariants];
