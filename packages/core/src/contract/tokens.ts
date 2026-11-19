import { z } from "zod";
import type { Operation } from "./index.ts";

const tokenSummary = z.strictObject({
  id: z.string(),
  label: z.string(),
  orgName: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});

const noStore = { "Cache-Control": z.literal("no-store") };
const optionalText = (field: string) => z.string({ error: `${field} must be text.` }).nullish();

export const tokenOperations = {
  listServiceTokens: {
    name: "listServiceTokens",
    route: { method: "POST", path: "/api/v1/token/list" },
    audience: "admin",
    readOnly: true,
    destructive: false,
    description: "List the caller's service tokens in their current scope, without token values or hashes.",
    input: { body: z.undefined() },
    output: z.strictObject({ tokens: z.array(tokenSummary) }),
    successHeaders: noStore,
    errors: ["unauthorized", "dependency_unavailable"],
  },
  createServiceToken: {
    name: "createServiceToken",
    route: { method: "POST", path: "/api/v1/token/create" },
    audience: "admin",
    readOnly: false,
    destructive: false,
    description:
      "Create a service token for an organization in the caller's scope. The token value is returned only once.",
    input: {
      body: z.object({
        org: optionalText("org").describe(
          "Organization UUID or name. Required for scoped callers unless orgName is supplied.",
        ),
        orgName: optionalText("orgName").describe(
          "Organization name or UUID. If both selectors are supplied, they must match.",
        ),
        label: optionalText("label").describe(
          "Defaults to default when missing, null, or empty. A supplied label is trimmed and must then contain 1–80 characters and no ASCII control characters.",
        ),
      }),
    },
    output: tokenSummary.pick({ id: true, label: true, orgName: true }).extend({ token: z.string() }),
    successHeaders: noStore,
    errors: ["invalid", "unauthorized", "forbidden", "dependency_unavailable"],
  },
  revokeServiceToken: {
    name: "revokeServiceToken",
    route: { method: "POST", path: "/api/v1/token/revoke" },
    audience: "admin",
    readOnly: false,
    destructive: true,
    description: "Revoke an active service token owned by the caller and visible in their current scope.",
    input: {
      body: z.object({
        id: z.guid({
          error: (issue) => {
            if (issue.input == null) return "id is required.";
            return typeof issue.input === "string" ? "id must be a token UUID." : "id must be text.";
          },
        }),
      }),
    },
    output: z.strictObject({ ok: z.literal(true) }),
    successHeaders: noStore,
    errors: ["invalid", "unauthorized", "forbidden", "dependency_unavailable"],
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType>>;
