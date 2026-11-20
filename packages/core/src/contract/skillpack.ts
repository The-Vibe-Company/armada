import { z } from "zod";
import { VAULT_CONTROL_BODY_MAX_BYTES } from "../public-control-routes.ts";
import type { Operation } from "./index.ts";

const org = z.string({ error: "org must be text." }).nullish();
const source = z.enum(["public", "private"], { error: "Choose the public catalog or private workspace." });
const offset = z
  .int({ error: "Invalid catalog offset." })
  .min(0, { error: "Invalid catalog offset." })
  .max(10_000, { error: "Invalid catalog offset." })
  .optional();
const reference = z
  .string({ error: (issue) => (issue.input == null ? "reference is required." : "reference must be text.") })
  .describe("Public references use org/slug. Private references use a bare slug.");
const versions = z.array(z.string());
const credential = z.strictObject({
  kind: z.literal("skillpack"),
  createdAt: z.string().nullable(),
  id: z.string().optional(),
  name: z.string().optional(),
  isDefault: z.boolean().optional(),
  maxAgents: z.number().nullable().optional(),
  modelLimits: z.record(z.string(), z.number()).optional(),
  modelCounts: z
    .record(z.string(), z.strictObject({ runningAgents: z.number(), waitingAgents: z.number() }))
    .optional(),
  runningAgents: z.number().optional(),
  waitingAgents: z.number().optional(),
  rateLimited: z.boolean().optional(),
  status: z.string().optional(),
  expiresAt: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
  version: z.number().optional(),
});

const readMetadata = {
  audience: "admin",
  readOnly: true,
  destructive: false,
  successHeaders: { "Cache-Control": z.literal("no-store") },
} as const;
const vaultBody = { maxBodyBytes: VAULT_CONTROL_BODY_MAX_BYTES, oversizedBodyStatus: 400 } as const;
const discoveryErrors = [
  "invalid",
  "unauthorized",
  "forbidden",
  "not_found",
  "missing_credential",
  "credential_refused",
  "dependency_unavailable",
];

export const skillpackOperations = {
  listSkillpackCatalog: {
    ...readMetadata,
    name: "listSkillpackCatalog",
    route: { method: "POST", path: "/api/v1/skillpack/catalog" },
    description:
      "List installable Skillpack metadata. Select the catalog and offset in the JSON body. Query parameters are refused.",
    input: { ...vaultBody, body: z.strictObject({ org, source, offset }) },
    output: z.strictObject({
      items: z.array(
        z.strictObject({
          reference: z.string(),
          name: z.string(),
          description: z.string(),
          visibility: source,
          versions,
        }),
      ),
      nextOffset: z.int().min(0).max(10_000).nullable(),
    }),
    errors: discoveryErrors,
  },
  listSkillpackVersions: {
    ...readMetadata,
    name: "listSkillpackVersions",
    route: { method: "POST", path: "/api/v1/skillpack/versions" },
    description:
      "List exact versions for a skill. The public catalog returns the currently published version. Query parameters are refused.",
    input: { ...vaultBody, body: z.strictObject({ org, source, reference }) },
    output: z.strictObject({ versions }),
    errors: discoveryErrors,
  },
  readSkillpackConnection: {
    ...readMetadata,
    name: "readSkillpackConnection",
    route: { method: "POST", path: "/api/v1/skillpack/connection" },
    description: "List visible Skillpack credential metadata. Credential values are never returned.",
    input: { body: z.looseObject({ org }), bodyRequired: false },
    output: z.strictObject({
      authorization: z.strictObject({
        available: z.literal(false),
        reason: z.literal("delegated_key_flow_unavailable"),
      }),
      user: z.array(credential),
      orgs: z.array(
        z.strictObject({
          id: z.string(),
          name: z.string(),
          role: z.enum(["admin", "member"]),
          credentials: z.array(credential),
        }),
      ),
    }),
    errors: ["invalid", "unauthorized", "forbidden", "not_found"],
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType>>;
