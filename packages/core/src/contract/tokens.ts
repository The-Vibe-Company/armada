import { z } from "zod";
import type { Operation } from "./index.ts";

const tokenSummary = z.strictObject({
  id: z.string(),
  label: z.string(),
  orgName: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});

const noStore = { "Cache-Control": z.literal("no-store") };
export const serviceTokenExpiry = z.enum(["30d", "90d", "1y", "never"]);
const keyIdentity = z.strictObject({ name: z.string(), expiresAt: z.string().nullable() });

export const tokenOperations = {
  listServiceTokens: {
    name: "listServiceTokens",
    route: { method: "POST", path: "/api/v1/token/list" },
    audience: "admin",
    readOnly: true,
    destructive: false,
    description: "List the caller's service tokens with a personal login, without token values or hashes.",
    input: { body: z.undefined() },
    output: z.strictObject({ tokens: z.array(tokenSummary) }),
    successHeaders: noStore,
    errors: ["unauthorized", "forbidden", "dependency_unavailable"],
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
      body: z.strictObject({
        org: z.string().trim().min(1).optional().describe("Organization UUID or name."),
        label: z.string().trim().min(1).max(80),
        expires: serviceTokenExpiry.default("30d"),
      }),
    },
    output: tokenSummary.pick({ id: true, label: true, orgName: true, expiresAt: true }).extend({ token: z.string() }),
    successHeaders: noStore,
    errors: ["invalid", "unauthorized", "forbidden", "dependency_unavailable"],
  },
  whoami: {
    name: "whoami",
    route: { method: "POST", path: "/api/v1/token/whoami" },
    audience: "admin",
    readOnly: true,
    destructive: false,
    description: "Identify the current personal login or API key.",
    input: { body: z.undefined() },
    output: z.discriminatedUnion("auth", [
      z.strictObject({ userId: z.string(), auth: z.literal("login") }),
      z.strictObject({ userId: z.string(), auth: z.literal("key"), key: keyIdentity }),
    ]),
    successHeaders: noStore,
    errors: ["unauthorized", "forbidden", "dependency_unavailable"],
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
