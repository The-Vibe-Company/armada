import { z } from "zod";
import type { DelegatedScope } from "../delegated-access.ts";
import { HARNESSES } from "../harnesses.ts";
import { MACHINE_SIZES } from "../machine-size.ts";
import { sandboxExtensionLifetime } from "./sandbox-rest.ts";

const key = z.string().regex(/^[ -~]{1,128}$/);
const text = z
  .string()
  .min(1)
  .max(100_000)
  .refine((value) => value.trim().length > 0);
const selection = z
  .object({
    goldenId: z.uuid(),
    harness: z.enum(HARNESSES),
    credentialId: z.uuid(),
    credentialVersion: z.number().int().positive().safe(),
    model: z.string().min(1).max(200),
    skills: z.array(z.string()).max(20).optional(),
    reasoningEffort: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    prompt: text.optional(),
    size: z.enum(MACHINE_SIZES).optional(),
  })
  .strict();
const child = "Scoped own-child operation. No owner/admin/credential/general sandbox authority.";

export const scopedOperations = {
  finish: {
    scope: "worker:stop",
    description:
      "Declare this sandbox finished. Stops Boat/Modal; permanently removes the Docker container and home volume immediately after work-preservation policy runs. Runtime Git archives are unavailable: push all work first. No target id; affects only this sandbox.",
    input: z.object({}).strict(),
  },
  launch: {
    scope: "worker:launch",
    description: child,
    input: z.object({ idempotencyKey: key, selection }).strict(),
  },
  read: {
    scope: "worker:read",
    description: child,
    input: z.object({ sandboxId: z.uuid() }).strict(),
  },
  message: {
    scope: "worker:message",
    description: child,
    input: z.object({ idempotencyKey: key, sandboxId: z.uuid(), text }).strict(),
  },
  stop: {
    scope: "worker:stop",
    description: child,
    input: z.object({ idempotencyKey: key, sandboxId: z.uuid() }).strict(),
  },
  extend: {
    scope: "worker:extend",
    description: child,
    input: z.object({ idempotencyKey: key, sandboxId: z.uuid(), ttlSeconds: sandboxExtensionLifetime }).strict(),
  },
} as const satisfies Record<string, { scope: DelegatedScope; description: string; input: z.ZodObject }>;

export type ScopedMethod = keyof typeof scopedOperations;
export const isScopedMethod = (name: string): name is ScopedMethod => Object.hasOwn(scopedOperations, name);
