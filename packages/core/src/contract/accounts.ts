import { z } from "zod";
import type { Operation } from "./index.ts";

const successHeaders = { "Cache-Control": z.literal("no-store") };

export const accountOperations = {
  readAccountStatus: {
    name: "readAccountStatus",
    route: { method: "POST", path: "/api/v1/account/status" },
    audience: "admin",
    readOnly: true,
    destructive: false,
    description:
      "Read the caller's identity, visible organization memberships, authentication kind and server version.",
    input: { body: z.undefined() },
    output: z.strictObject({
      userId: z.string(),
      orgs: z.array(z.strictObject({ orgId: z.string(), role: z.enum(["admin", "member"]) })).readonly(),
      authentication: z.enum(["service", "mcp", "supabase"]),
      version: z.string(),
    }),
    successHeaders,
    errors: ["invalid", "unauthorized", "dependency_unavailable", "internal"],
  },
  logoutAccount: {
    name: "logoutAccount",
    route: { method: "POST", path: "/api/v1/account/logout" },
    audience: "admin",
    readOnly: false,
    destructive: true,
    description: "Sign out the current personal login session.",
    scopedAuth: ["personalSession"],
    input: { body: z.undefined() },
    output: z.strictObject({ ok: z.literal(true) }),
    successHeaders,
    errors: ["invalid", "unauthorized", "forbidden", "unavailable", "dependency_unavailable", "internal"],
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType>>;

const loginPath = "/api/v1/model-accounts/antigravity/login";
const loginId = z.uuid();
const organization = { org: z.string().trim().min(1).max(256).optional() };
const loginOperation = {
  audience: "admin",
  readOnly: false,
  destructive: false,
  successHeaders,
  errors: ["invalid", "unauthorized", "forbidden", "not_found", "conflict", "unavailable", "internal"],
} as const;

export const antigravityLoginOperations = {
  startAntigravityLogin: {
    ...loginOperation,
    name: "startAntigravityLogin",
    route: { method: "POST", path: loginPath },
    description: "Start Google sign-in. An explicit org selects an organization-owned account.",
    input: {
      body: z.union([
        z.strictObject({ ...organization, name: z.string().trim().min(1).max(120) }),
        z.strictObject({ ...organization, id: z.uuid(), expectedVersion: z.int().positive() }),
      ]),
    },
    output: z.strictObject({ loginId, authorizationUrl: z.url(), expiresAt: z.iso.datetime() }),
  },
  completeAntigravityLogin: {
    ...loginOperation,
    name: "completeAntigravityLogin",
    route: { method: "POST", path: `${loginPath}/{loginId}` },
    description: "Submit the Google code or callback URL to the instance that started the sign-in.",
    input: { path: { loginId }, body: z.strictObject({ code: z.string().min(1).max(8192) }) },
    output: z.strictObject({
      account: z.object({
        id: z.uuid(),
        kind: z.literal("antigravity"),
        name: z.string(),
        createdAt: z.string().nullable(),
        version: z.int().positive(),
      }),
    }),
  },
  cancelAntigravityLogin: {
    ...loginOperation,
    name: "cancelAntigravityLogin",
    route: { method: "DELETE", path: `${loginPath}/{loginId}` },
    description: "Cancel the pending Google sign-in on this instance.",
    input: { path: { loginId }, body: z.undefined() },
    output: z.strictObject({ ok: z.literal(true) }),
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType>>;

export function antigravityLoginPath(id: string): `${typeof loginPath}/${string}` {
  return `${loginPath}/${loginId.parse(id)}`;
}

export function isAntigravityLoginPath(path: string) {
  return path.startsWith(`${loginPath}/`) && loginId.safeParse(path.slice(loginPath.length + 1)).success;
}
