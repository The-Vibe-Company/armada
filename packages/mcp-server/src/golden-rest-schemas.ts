import { SANDBOX_PROVIDERS } from "@armada/core";
import { z } from "zod";

export const GOLDEN_CAPABILITIES_REQUEST = z.object({
  org: z.string().optional(),
  provider: z.enum(SANDBOX_PROVIDERS).optional(),
});

export const GOLDEN_CAPABILITIES_RESPONSE = z.object({
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

export const GOLDEN_ADOPTION_REQUEST = z.object({
  id: z.string().uuid(),
  confirmation: z.string().uuid().optional(),
  org: z.string().optional(),
});

export const GOLDEN_ADOPTION_RESPONSE = z.object({
  goldenId: z.string(),
  dryRun: z.boolean(),
  confirmation: z.string(),
});
