import { z } from "zod";
import { MACHINE_SIZES } from "../machine-size.ts";
import { SANDBOX_PROVIDERS } from "../sandbox-provider.ts";
import { SKILL_PIN_PATTERN } from "../skill-pins.ts";
import type { Operation } from "./index.ts";
import { launchExternalRef } from "./launch.ts";
import { templateLaunchResponse } from "./launch-response.ts";

const GOLDEN_CAPABILITIES_REQUEST = z.object({
  org: z.string().nullish(),
  provider: z.enum(SANDBOX_PROVIDERS).nullish(),
});

const GOLDEN_CAPABILITIES_RESPONSE = z.object({
  provider: z.enum(SANDBOX_PROVIDERS),
  maxGoldens: z.number().int().positive().nullable(),
  bindings: z
    .array(
      z.object({
        goldenId: z.string().uuid(),
        relation: z.enum(["current_backend", "other_backend", "unbound"]),
      }),
    )
    .optional(),
});

const GOLDEN_ADOPTION_REQUEST = z.object({
  id: z.string().uuid(),
  confirmation: z.string().uuid().optional(),
  org: z.string().nullish(),
});

const GOLDEN_ADOPTION_RESPONSE = z.object({
  goldenId: z.string(),
  dryRun: z.boolean(),
  confirmation: z.string(),
});
const GOLDEN_OUTPUT = z.object({
  id: z.string(),
  name: z.string(),
  orgId: z.string(),
  visibility: z.enum(["org", "private"]),
  ownerId: z.string(),
  provider: z.enum(SANDBOX_PROVIDERS).describe("The sandbox provider it runs on, fixed for its life."),
  providerSnapshotId: z.string().nullable(),
  baselineVersion: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("The developer baseline version the golden's snapshot was verified against; null when not recorded."),
  baselineOutdated: z
    .boolean()
    .describe("True when the golden has a snapshot built against an older developer baseline than this server's."),
  providerSandboxId: z.string().nullable(),
  modal: z
    .object({ workspace: z.string(), environment: z.string(), appId: z.string() })
    .nullable()
    .describe("The Modal workspace, environment and App id a Modal golden is pinned to."),
  boatSnapshotId: z
    .string()
    .nullable()
    .describe("The same as providerSnapshotId on a Boat golden or sandbox; null on any other provider."),
  boatSandboxId: z
    .string()
    .nullable()
    .describe("The same as providerSandboxId on a Boat golden or sandbox; null on any other provider."),
  repos: z.number().int(),
  config: z.object({
    repos: z.array(z.object({ url: z.string(), branch: z.string(), dir: z.string() })),
    init: z.array(z.string()),
  }),
});

const GOLDEN_LIST_RESPONSE = z.object({
  goldens: z.array(
    GOLDEN_OUTPUT.extend({
      buildWarnings: z.array(z.string()).describe("Non-blocking findings from the golden's last build."),
    }),
  ),
});

const id = z.string().describe("Armada's sandbox id (a uuid, as returned by launch and list).");

export const githubOperations = {
  refreshGitHub: {
    name: "refreshGitHub",
    route: { method: "POST", path: "/api/v1/github/refresh" },
    audience: "public",
    readOnly: false,
    destructive: false,
    errors: [],
    description:
      "Configure or refresh the owner's GitHub access in a running sandbox without relaunching. Enrolled Armada runtimes use current-epoch private RPC; native Boat keeps its existing setup. Reuses a validated unexpired token; rejection/expiry can require renewal. Only the sandbox owner may request this.",
    input: { body: z.object({ id, org: z.string().nullish() }) },
    output: z.object({
      id: z.string(),
      login: z.string(),
      status: z.literal("connected"),
      runtime: z.object({ kind: z.literal("armada"), epoch: z.string() }).optional(),
      revision: z.string().optional(),
    }),
  },
  readRuntimeGitHubStatus: {
    name: "readRuntimeGitHubStatus",
    route: { method: "POST", path: "/api/v1/github/runtime-status" },
    audience: "public",
    readOnly: true,
    destructive: false,
    errors: [],
    description:
      "Owner-only non-secret current-epoch configuration and credential-request count. Does not return credentials or probe GitHub.",
    input: { body: z.object({ id, org: z.string().nullish() }) },
    output: z.object({
      id: z.string(),
      configured: z.boolean(),
      revision: z.string().nullable(),
      credentialRequests: z.number().int().nonnegative(),
      lastAccessedAt: z.string().nullable(),
      runtime: z.object({ kind: z.literal("armada"), epoch: z.string() }).optional(),
    }),
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType>>;

export const goldenOperations = {
  listGoldens: {
    name: "listGoldens",
    route: { method: "POST", path: "/api/v1/golden/list" },
    description:
      "List launch goldens visible to the caller. A golden without a providerSnapshotId cannot be launched yet.",
    audience: "public",
    readOnly: true,
    destructive: false,
    errors: [],
    input: { body: z.object({ org: z.string().nullish() }) },
    output: GOLDEN_LIST_RESPONSE,
  },
  readGoldenCapabilities: {
    name: "readGoldenCapabilities",
    route: { method: "POST", path: "/api/v1/golden/capabilities" },
    description:
      "Reads the selected provider adapter's golden capacity without creating an App or resource. Null is unknown or unbounded.",
    audience: "public",
    readOnly: true,
    destructive: false,
    errors: [],
    input: { body: GOLDEN_CAPABILITIES_REQUEST },
    output: GOLDEN_CAPABILITIES_RESPONSE,
  },
  adoptGolden: {
    name: "adoptGolden",
    route: { method: "POST", path: "/api/v1/golden/adopt" },
    description:
      "Dry-run first: select an existing visible golden by id. Confirm with the returned receipt within ten minutes. Preserves all rows and ACLs.",
    audience: "public",
    readOnly: false,
    destructive: false,
    errors: [],
    input: { body: GOLDEN_ADOPTION_REQUEST },
    output: GOLDEN_ADOPTION_RESPONSE,
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType>>;

// biome-ignore lint/suspicious/noControlCharactersInRegex: template text excludes NUL and requires a non-whitespace character.
const templateText = z.string().regex(/^(?![\s\S]*\x00)[\s\S]*\S/);

export const launchTemplateOperation = {
  name: "launchTemplate",
  route: { method: "POST", path: "/api/v1/templates/launch" },
  description:
    "Launch an immutable template revision. Reusing requestKey with the same body returns the recorded request without allocating twice.",
  audience: "public",
  readOnly: false,
  destructive: false,
  errors: [],
  input: {
    body: z.strictObject({
      org: z.guid(),
      id: z.guid(),
      revision: z.number().int().positive().optional(),
      requestKey: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9._:-]+(?![\s\S])/),
      prompt: templateText.max(100000).optional(),
      ttlSeconds: z.number().int().positive().optional(),
      size: z.enum(MACHINE_SIZES).optional(),
      repo: templateText.max(200).optional(),
      skills: z.array(z.string().max(256).regex(SKILL_PIN_PATTERN)).max(20).nullish(),
      skipSkillDefaults: z.boolean().optional(),
      modelAccount: z
        .strictObject({ id: z.guid(), version: z.number().int().positive() })
        .optional()
        .describe(
          "Model credential account to run with, by id and version, when the revision pins none. Refused when the revision pins one.",
        ),
      externalRef: launchExternalRef.describe(
        "Opaque caller reference recorded on the sandbox. Refused for Docker templates.",
      ),
      stopWhenWorkMerged: z.boolean().optional(),
    }),
  },
  output: templateLaunchResponse,
} as const satisfies Operation<z.ZodType, z.ZodType>;
