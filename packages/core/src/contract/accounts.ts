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
    input: { body: z.undefined() },
    output: z.strictObject({ ok: z.literal(true) }),
    successHeaders,
    errors: ["invalid", "unauthorized", "forbidden", "unavailable", "dependency_unavailable", "internal"],
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType>>;
