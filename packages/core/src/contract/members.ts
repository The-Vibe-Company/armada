import { z } from "zod";
import type { Operation } from "./index.ts";

const org = z.string({ error: "org must be text." }).nullish();
// The vault checks syntax after resolving the caller's organization and role.
export const memberEmailPattern = /^\s*[^\s@]+@[^\s@]+\.[^\s@]+\s*$/;
const email = z
  .string({ error: (issue) => (issue.input == null ? "email is required." : "email must be text.") })
  .meta({
    description: "Email address of an existing Armada account. Surrounding whitespace is ignored.",
    pattern: memberEmailPattern.source,
  });

const role = z.enum(["admin", "member"], {
  error: (issue) =>
    issue.input == null
      ? "role is required."
      : typeof issue.input !== "string"
        ? "role must be text."
        : "A role is admin or member.",
});

const member = z.strictObject({
  userId: z.string(),
  email: z.string().nullable(),
  role,
  createdAt: z.string(),
});
const ok = z.strictObject({ ok: z.literal(true) });
const metadata = {
  audience: "admin",
  scopedAuth: ["serviceToken", "personalSession"],
  successHeaders: { "Cache-Control": z.literal("no-store") },
} as const;
const errors = ["invalid", "unauthorized", "forbidden", "not_found", "dependency_unavailable", "internal"];

const mutationErrors = [...errors, "conflict", "unavailable"];

export const memberOperations = {
  listMembers: {
    ...metadata,
    name: "listMembers",
    route: { method: "POST", path: "/api/v1/members/list" },
    description: "List members of an organization the caller belongs to.",
    input: { body: z.looseObject({ org }), bodyRequired: false },
    output: z.strictObject({
      org: z.strictObject({ id: z.string(), name: z.string(), role }),
      members: z.array(member),
    }),
    readOnly: true,
    destructive: false,
    errors,
  },
  addMember: {
    ...metadata,
    name: "addMember",
    route: { method: "POST", path: "/api/v1/members/add" },
    description: "As an organization administrator, add an existing Armada user. Omitting the role selects member.",
    input: { body: z.looseObject({ org, email, role: role.nullish() }) },
    output: z.strictObject({ member }),
    readOnly: false,
    destructive: false,
    errors: mutationErrors,
  },
  setMemberRole: {
    ...metadata,
    name: "setMemberRole",
    route: { method: "POST", path: "/api/v1/members/role" },
    description: "Change a member's role as an organization administrator.",
    input: { body: z.looseObject({ org, email, role }) },
    output: ok,
    readOnly: false,
    destructive: true,
    errors: mutationErrors,
  },
  removeMember: {
    ...metadata,
    name: "removeMember",
    route: { method: "POST", path: "/api/v1/members/remove" },
    description: "Remove a member as an organization administrator.",
    input: { body: z.looseObject({ org, email }) },
    output: ok,
    readOnly: false,
    destructive: true,
    errors: mutationErrors,
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType>>;
