import { z } from "zod";
import { tokenUsageSchema } from "./tokens.js";

export { USAGE_MINOR } from "./envelope.js";
export { type ReportedUsage, reportedUsageSchema, type TokenUsage, tokenUsageSchema } from "./tokens.js";

const count = /* @__PURE__ */ (() => z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))();
const totalsSchema = /* @__PURE__ */ (() =>
  tokenUsageSchema.omit({ model: true, provider: true, incomplete: true }).extend({
    reported: count,
    unknown: count,
    models: z.array(z.string()),
  }))();
export type UsageTotals = z.infer<typeof totalsSchema>;
export const projectUsageSchema = /* @__PURE__ */ (() =>
  z.object({
    zone: z.string(),
    days: z.array(
      z.object({
        day: z.string(),
        coordinator: totalsSchema,
        workers: totalsSchema,
        workerLaunches: count,
        workersReported: count,
      }),
    ),
    sessions: z.array(
      z.object({
        session: z.string(),
        kind: z.enum(["coordinator", "worker"]),
        ticket: z.string().optional(),
        runtime: z.string().optional(),
        launchedAt: z.string().optional(),
        totals: totalsSchema,
      }),
    ),
  }))();
export type ProjectUsage = z.infer<typeof projectUsageSchema>;
