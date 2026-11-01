import { z } from "zod";

const comment = z.object({
  id: z.string(),
  root: z.string(),
  author: z.string(),
  body: z.string().max(600),
  url: z.string(),
  at: z.string(),
  updatedAt: z.string(),
  path: z.string(),
  line: z.number().int().nonnegative().nullable(),
});
export type ReviewComment = z.infer<typeof comment>;
const thread = z.object({ resolved: z.boolean(), cycle: z.number().int().nonnegative(), comment });
const pr = z.object({
  compareKey: z.string().optional(),
  compareEtag: z.string().optional(),
  compareBehind: z.boolean().optional(),
  cursor: z.string().optional(),
  etag: z.string().optional(),
  issueEtag: z.string().optional(),
  failures: z.number().int().nonnegative().default(0),
  failedSince: z.string().optional(),
  error: z.string().optional(),
  abandoned: z.enum(["unavailable-24h", "gone"]).optional(),
  comments: z.record(z.string(), comment).default({}),
  threads: z.record(z.string(), thread).default({}),
});
export type PrCursor = z.infer<typeof pr>;
export const githubCheckpoint = z.object({
  format: z.literal("armada.github-reader"),
  version: z.literal(1),
  repository: z.string(),
  prs: z.record(z.string(), pr),
  backoffMs: z.number().nonnegative(),
  pollMs: z.number().nonnegative(),
  pausedUntil: z.string().optional(),
});
export type GithubCheckpoint = z.infer<typeof githubCheckpoint>;
export const emptyCheckpoint = (repository: string): GithubCheckpoint => ({
  format: "armada.github-reader",
  version: 1,
  repository,
  prs: {},
  backoffMs: 0,
  pollMs: 0,
});
export const emptyPr = (): PrCursor => ({ failures: 0, comments: {}, threads: {} });
