import { z } from "zod";
import { rulesStateSchema } from "./rules.js";

const text = z.string();
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const phaseSchema = z.enum([
  "planning",
  "awaiting-approval",
  "implementing",
  "shipping",
  "blocked",
  "ready-to-merge",
  "awaiting-validation",
  "released",
  "merged",
]);
/** Worker reports and tracker labels exclude terminal phases. */
export const activePhaseSchema = phaseSchema.exclude(["released", "merged"]);
export type Phase = z.infer<typeof phaseSchema>;
const shippingStageSchema = z.enum(["review", "ci"]);
export type ShippingStage = z.infer<typeof shippingStageSchema>;
export type Json = z.infer<ReturnType<typeof z.json>>;

const ticketSchema = z.object({
  id: text,
  title: text,
  labels: z.array(text).optional(),
  description: text.optional(),
  url: text.optional(),
  branchName: text.optional(),
  parent: text.nullable().optional(),
  blockers: z
    .array(
      z.object({ id: text, status: z.enum(["triage", "backlog", "unstarted", "started", "completed", "canceled"]) }),
    )
    .optional(),
  comments: z.array(z.object({ body: text, author: text, at: text })).optional(),
  status: z.enum(["triage", "backlog", "unstarted", "started", "completed", "canceled"]),
  phase: phaseSchema.nullable().optional(),
  reason: text.optional(),
  owner: text.optional(),
});
export type Ticket = z.infer<typeof ticketSchema>;
const ciSchema = z.enum(["none", "pending", "success", "failure"]);
const pullRequestSchema = z.object({
  number: integer,
  ticket: text,
  state: z.enum(["open", "closed", "merged"]),
  ci: ciSchema,
  conflicting: z.boolean(),
  head: text,
});
export type PullRequest = z.infer<typeof pullRequestSchema>;
const githubPullRequestSchema = pullRequestSchema.extend({
  repository: text,
  title: text,
  url: text,
  headRef: text,
  draft: z.boolean(),
  review: z.enum(["none", "approved", "changes_requested", "review_required"]),
  checks: z.array(z.object({ name: text, state: ciSchema, runId: integer.optional(), runAttempt: integer.optional() })),
  checksComplete: z.boolean(),
});
export type GithubPullRequest = z.infer<typeof githubPullRequestSchema>;
const sessionRefSchema = z.object({
  ticket: text,
  /** Unique for each claim; never reuse a runtime handle as a generation. */
  session: text,
});
export type SessionRef = z.infer<typeof sessionRefSchema>;
/** Host-owned launch progress, separate from a worker's actual claim. */
export const workerLaunchCheckpointSchema = sessionRefSchema.extend({
  format: z.literal("armada.worker"),
  version: z.literal(1),
  type: z.enum(["launch-intent", "launch"]),
  generation: integer.min(1),
  runtime: text,
  handle: text.optional(),
  branch: text.optional(),
  step: z.enum(["preparing", "starting", "launched"]),
});

const inboxRequestSchema = z.object({
  id: text,
  ticket: text,
  kind: z.enum(["question", "plan", "hand-back", "owner-request", "launch"]),
  body: text,
});
export type InboxRequest = z.infer<typeof inboxRequestSchema>;
const validationRequestSchema = sessionRefSchema.extend({ id: text, question: text, checks: z.array(text) });
export type ValidationRequest = z.infer<typeof validationRequestSchema>;
const queuedSchema = sessionRefSchema.extend({ id: text, pr: integer, head: text });
const idSchema = z.object({ id: text });
const reasonSchema = idSchema.extend({ reason: text });
const decisionSchema = z.object({ decision: z.enum(["approved", "changes-requested"]), note: text });

/** The single vocabulary for events appended by daemon adapters and folded offline. */
export const eventPayloadSchemas = {
  "ticket.seen": ticketSchema,
  "pull-request.seen": pullRequestSchema,
  "session.claimed": sessionRefSchema.extend({ generation: integer.min(1), owner: text, runtime: text, handle: text }),
  "session.reported": sessionRefSchema.extend({
    phase: activePhaseSchema,
    reason: text,
    stage: shippingStageSchema.optional(),
  }),
  "session.heartbeat": sessionRefSchema,
  "session.runtime-observed": sessionRefSchema.extend({
    generation: integer.min(1),
    state: z.enum(["starting", "running", "stopped", "failed", "unknown"]),
    activity: z.enum(["working", "idle"]).optional(),
  }),
  "session.released": sessionRefSchema.extend({ reason: text }),
  "inbox.opened": inboxRequestSchema,
  "inbox.answered": idSchema.extend({ answer: text }),
  "merge.queued": queuedSchema,
  "merge.started": idSchema,
  "merge.refused": reasonSchema,
  "merge.canceled": reasonSchema,
  "merge.confirmed": queuedSchema,
  "hold.opened": reasonSchema,
  "hold.cleared": reasonSchema,
  "validation.opened": validationRequestSchema,
  "validation.decided": idSchema.extend(decisionSchema.shape),
  "coordinator.message": z.object({ role: z.enum(["owner", "coordinator"]), body: text }),
  "coordinator.checkpoint": z.object({ checkpoint: z.json() }),
  "ticket.phase-changed": z.object({ ticket: text, from: phaseSchema.nullable(), to: phaseSchema.nullable() }),
  "ticket.report-posted": z.object({
    ticket: text,
    comment: text,
    updatedAt: text,
    phase: phaseSchema,
    summary: text,
    body: text,
  }),
  "pull-request.opened": githubPullRequestSchema,
  "pull-request.head-moved": githubPullRequestSchema,
  "pull-request.checks-green": githubPullRequestSchema,
  "pull-request.checks-red": githubPullRequestSchema,
  "pull-request.review-changed": githubPullRequestSchema,
  "pull-request.closed": githubPullRequestSchema,
  "pull-request.merged": githubPullRequestSchema,
} as const;
export type EventKind = keyof typeof eventPayloadSchemas;
export type EventPayloads = { [K in EventKind]: z.infer<(typeof eventPayloadSchemas)[K]> };
export type EventInput = {
  [K in EventKind]: { project: string; kind: K; at: string; actor: string; payload: EventPayloads[K] };
}[EventKind];
export type FleetEvent = EventInput & { seq: number };

export const sessionStateSchema = z.enum([
  "blocked",
  "waiting-for-owner",
  "in-progress",
  "ready-to-merge",
  "merged",
  "released",
]);
export type SessionState = z.infer<typeof sessionStateSchema>;
export const flowStepSchema = z.enum(["plan", "implementing", "review", "ci", "merged"]);
const sessionSchema = sessionRefSchema.extend({
  generation: integer,
  owner: text,
  runtime: text,
  handle: text,
  title: text,
  phase: phaseSchema,
  state: sessionStateSchema,
  reason: text,
  step: integer,
  flowStep: flowStepSchema,
  at: text,
  heartbeat: text.nullable(),
});
export type Session = z.infer<typeof sessionSchema>;
const inboxItemSchema = inboxRequestSchema.extend({ at: text, actor: text, seq: integer });
export type InboxItem = z.infer<typeof inboxItemSchema>;
const queueEntrySchema = queuedSchema.extend({ at: text, seq: integer, state: z.enum(["queued", "running"]) });
export type QueueEntry = z.infer<typeof queueEntrySchema>;
const holdSchema = reasonSchema.extend({ at: text, actor: text });
export type Hold = z.infer<typeof holdSchema>;
const validationSchema = validationRequestSchema.extend({
  at: text,
  actor: text,
  decision: decisionSchema.extend({ at: text, actor: text }).nullable(),
});
export type Validation = z.infer<typeof validationSchema>;
const tablesSchema = z.object({
  // Absent on older snapshots; current daemon folds always supply this slice.
  rules: rulesStateSchema.optional(),
  /** Successful provider reads, even when no facts changed; absent on older snapshots. */
  readAt: z.record(z.string(), z.iso.datetime()).optional(),
  tickets: z.array(ticketSchema),
  pullRequests: z.array(pullRequestSchema),
  sessions: z.array(sessionSchema),
  sessionsByState: z.object({
    blocked: z.array(sessionSchema),
    "waiting-for-owner": z.array(sessionSchema),
    "in-progress": z.array(sessionSchema),
    "ready-to-merge": z.array(sessionSchema),
    merged: z.array(sessionSchema),
    released: z.array(sessionSchema),
  }),
  inbox: z.array(inboxItemSchema),
  queue: z.array(queueEntrySchema),
  holds: z.array(holdSchema),
  validations: z.array(validationSchema),
});
export type ProjectTables = z.infer<typeof tablesSchema>;
export interface FleetTables {
  seq: number;
  projects: Record<string, ProjectTables>;
}

/** Validate the known tables without stripping extension fields or reordering JSON keys.
 * Wire consumers can keep ignoring rows and event kinds they do not use.
 */
export const projectTablesSchema = z
  .json()
  .superRefine((value, ctx) => {
    const result = tablesSchema.safeParse(value);
    if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ ...issue });
  })
  .transform((value) => value as ProjectTables);
