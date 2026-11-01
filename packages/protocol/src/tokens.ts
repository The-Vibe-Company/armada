import { z } from "zod";

const count = /* @__PURE__ */ (() => z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))();
/** Each missing counter is unknown, even when other counters are reported. */
export const tokenUsageSchema = /* @__PURE__ */ (() =>
  z.object({
    input: count.nullable(),
    output: count.nullable(),
    cacheRead: count.nullable(),
    cacheWrite: count.nullable(),
    model: z.string().nullable(),
    provider: z.string().nullable(),
    incomplete: z.boolean().optional(),
  }))();
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export const reportedUsageSchema = /* @__PURE__ */ (() => z.union([tokenUsageSchema, z.literal("unknown")]))();
export type ReportedUsage = z.infer<typeof reportedUsageSchema>;
