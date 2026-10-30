import { z } from "zod";
import type { ProjectRequest } from "./index.js";

const sha = z.string().regex(/^[0-9a-f]{40}$/);
/** Fresh forge facts: truncated or unavailable enumerations must never imply readiness. */
export const forgeInspectionSchema = z.object({
  number: z.number().int().positive(),
  head: sha,
  base: sha,
  baseRef: z.string().min(1),
  state: z.enum(["open", "closed", "merged"]),
  title: z.string(),
  url: z.string(),
  draft: z.boolean(),
  mergeState: z.string(),
  mergeCommit: sha.nullable(),
  observedAt: z.iso.datetime({ offset: true }),
  behindBy: z.number().int().nonnegative().nullable(),
  checksComplete: z.boolean(),
  checks: z.array(z.object({ name: z.string().min(1), state: z.enum(["none", "pending", "success", "failure"]) })),
  requiredChecks: z.array(z.string().min(1)),
  reviewThreads: z.object({
    complete: z.boolean(),
    total: z.number().int().nonnegative(),
    read: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
  }),
});
export type ForgeInspection = z.infer<typeof forgeInspectionSchema>;
export interface TestMergeRequest extends ProjectRequest {
  repository: string;
  number: number;
  branch: string;
  base: string;
  head: string;
  commands: string[];
}
export type TestMergeResult = { ok: true } | { ok: false; step: string; output: string };
export interface TrackerWriteRequest extends ProjectRequest {
  ticket: string;
  /** Host writer/generation fence, called immediately before each external write. */
  beforeWrite?: () => void;
  phase?: string;
  state?: "completed";
  comment?: string;
  /** Stable UUID for idempotent merged comments across an interrupted cleanup. */
  commentId?: string;
}
