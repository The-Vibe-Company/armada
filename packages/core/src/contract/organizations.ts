import { z } from "zod";
import type { Operation } from "./index.ts";

export const orgReference = z.string({ error: "org must be text." }).nullish();
export const orgSummary = z.strictObject({
  id: z.string(),
  name: z.string(),
  role: z.enum(["admin", "member"]),
});

function requiredText(field: string) {
  return z.string({
    error: ({ input }) => (input == null ? `${field} is required.` : `${field} must be text.`),
  });
}

export const orgProvider = z.enum(["boat", "modal"]);
export const ORG_PROVIDER_CREDENTIAL_MAX_LENGTH = 16_384;

const provider = requiredText("provider").meta({ enum: orgProvider.options });
const value = requiredText("value").meta({
  description: `Provider credential, at most ${ORG_PROVIDER_CREDENTIAL_MAX_LENGTH} UTF-16 code units before trimming. The response never includes its value.`,
  writeOnly: true,
});
const scopeBody = z.looseObject({ org: orgReference });
const providerBody = scopeBody.extend({ provider });
const providerStatus = z.strictObject({
  org: orgSummary,
  ready: z.boolean(),
  providers: z.array(z.strictObject({ provider: orgProvider, configured: z.boolean() })),
});

const metadata = {
  audience: "admin",
  scopedAuth: ["serviceToken", "personalSession"],
  successHeaders: { "Cache-Control": z.literal("no-store") },
} as const;
const errors = ["invalid", "unauthorized", "forbidden", "dependency_unavailable", "internal"];

export const organizationOperations = {
  createOrganization: {
    ...metadata,
    name: "createOrganization",
    route: { method: "POST", path: "/api/v1/org/create" },
    input: {
      body: scopeBody.extend({
        name: requiredText("name").describe("Organization name, 1 to 120 characters after trimming."),
      }),
    },
    output: z.strictObject({ org: orgSummary }),
    description: "Create an organization with the caller as its first administrator.",
    readOnly: false,
    destructive: false,
    errors: [...errors, "conflict"],
  },
  listOrganizations: {
    ...metadata,
    name: "listOrganizations",
    route: { method: "POST", path: "/api/v1/org/list" },
    input: { body: scopeBody, bodyRequired: false },
    output: z.strictObject({ orgs: z.array(orgSummary) }),
    description: "List the caller's current organization memberships within the bearer scope.",
    readOnly: true,
    destructive: false,
    errors,
  },
  readOrganizationProviderStatus: {
    ...metadata,
    name: "readOrganizationProviderStatus",
    route: { method: "POST", path: "/api/v1/org/provider/status" },
    input: { body: scopeBody, bodyRequired: false },
    output: providerStatus,
    description: "Read provider readiness and credential presence for an organization.",
    readOnly: true,
    destructive: false,
    errors: [...errors, "not_found"],
  },
  connectOrganizationProvider: {
    ...metadata,
    name: "connectOrganizationProvider",
    route: { method: "POST", path: "/api/v1/org/provider/connect" },
    input: { body: providerBody.extend({ value }) },
    output: providerStatus,
    description: "As an organization administrator, validate and store a provider credential.",
    readOnly: false,
    destructive: false,
    errors: [...errors, "not_found", "unavailable"],
  },
  disconnectOrganizationProvider: {
    ...metadata,
    name: "disconnectOrganizationProvider",
    route: { method: "POST", path: "/api/v1/org/provider/disconnect" },
    input: { body: providerBody },
    output: providerStatus,
    description: "As an organization administrator, remove a provider credential.",
    readOnly: false,
    destructive: true,
    errors: [...errors, "not_found"],
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType>>;
