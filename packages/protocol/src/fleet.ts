import { z } from "zod";
import { deliveryPayloadSchemas, deliveryStateSchema } from "./deliveries.js";
import { readerUsageSchema } from "./readers.js";
import { rulesStateSchema } from "./rules.js";

export const GITHUB_READER_MINOR = 18;
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
const pullRequestSchema = /* @__PURE__ */ makePullRequestSchema();
function makePullRequestSchema() {
  return z.object({
    number: integer,
    ticket: text,
    state: z.enum(["open", "closed", "merged"]),
    ci: ciSchema,
    conflicting: z.boolean(),
    head: text,
    base: text.optional(),
    behind: z.boolean().optional(),
    unresolvedThreads: integer.optional(),
  });
}
export type PullRequest = z.infer<typeof pullRequestSchema>;
export type GithubPullRequest = EventPayloads["pull-request.opened"];
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

const inboxRequestSchema = /* @__PURE__ */ makeInboxRequestSchema();
function makeInboxRequestSchema() {
  return z.object({
    id: text,
    ticket: text,
    kind: z.enum([
      "question",
      "plan",
      "hand-back",
      "owner-request",
      "launch",
      "delivery-failed",
      "stopped",
      "silent",
      "not-started",
      "liveness",
      "deploy",
      "job",
      "job-silent",
      "job-stalled",
      "version",
    ]),
    body: text,
  });
}
export type InboxRequest = z.infer<typeof inboxRequestSchema>;
const validationRequestSchema = sessionRefSchema.extend({ id: text, question: text, checks: z.array(text) });
export type ValidationRequest = z.infer<typeof validationRequestSchema>;
const queuedSchema = sessionRefSchema.extend({ id: text, pr: integer, head: text });
const idSchema = z.object({ id: text });
const reasonSchema = idSchema.extend({ reason: text });
const decisionSchema = z.object({ decision: z.enum(["approved", "changes-requested"]), note: text });
// The app accepts opaque fleet events; construct wake validators only in consumers that use them.
export const wakeCandidateSchema = /* @__PURE__ */ wakeCandidate();
function wakeCandidate() {
  return z.object({
    key: text,
    summary: text,
    facts: z.object({
      ticket: text.optional(),
      pr: integer.optional(),
      head: text.optional(),
      state: text.optional(),
      item: text.optional(),
      hold: text.optional(),
      branch: text.optional(),
    }),
  });
}
export type WakeCandidate = z.infer<typeof wakeCandidateSchema>;
const branchHealthSchema = z.object({ branch: text, head: text, ci: ciSchema });

/** The single vocabulary for events appended by daemon adapters and folded offline.
 * A pure factory lets the app omit payload validators it never reads. */
export const eventPayloadSchemas = /* @__PURE__ */ payloadSchemas();
function payloadSchemas() {
  const githubPullRequestSchema = pullRequestSchema.extend({
    repository: text,
    title: text,
    url: text,
    headRef: text,
    draft: z.boolean(),
    review: z.enum(["none", "approved", "changes_requested", "review_required"]),
    checks: z.array(
      z.object({ name: text, state: ciSchema, runId: integer.optional(), runAttempt: integer.optional() }),
    ),
    checksComplete: z.boolean(),
    author: text.optional(),
    failingChecks: z.array(text).optional(),
  });
  const forgeCommentSchema = z.object({
    key: text,
    repository: text,
    ticket: text,
    pr: integer,
    head: text,
    author: text,
    body: z.string().max(600),
    url: text,
    at: text,
    comment: text,
    version: text.optional(),
    worker: text.optional(),
  });
  const reviewThreadSchema = forgeCommentSchema.extend({
    thread: text,
    path: text,
    line: integer.nullable(),
    unresolvedThreads: integer,
  });
  return {
    "ticket.seen": ticketSchema,
    "pull-request.seen": pullRequestSchema,
    "session.claimed": sessionRefSchema.extend({
      generation: integer.min(1),
      owner: text,
      runtime: text,
      handle: text,
    }),
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
    "session.liveness": sessionRefSchema.extend({
      id: text,
      generation: integer.min(1),
      episode: integer,
      level: integer.min(1),
      verdict: z.enum(["looping", "drifting"]),
      evidence: z.string().max(240),
      summary: z.string().max(500),
    }),
    "session.released": sessionRefSchema.extend({ reason: text }),
    "inbox.opened": inboxRequestSchema,
    "inbox.answered": idSchema.extend({ answer: text }),
    "merge.queued": queuedSchema,
    "merge.started": idSchema,
    "merge.refused": reasonSchema.extend({ ticket: text.optional(), pr: integer.optional(), head: text.optional() }),
    "merge.canceled": reasonSchema,
    "merge.confirmed": queuedSchema,
    "hold.opened": reasonSchema,
    "hold.cleared": reasonSchema,
    "validation.opened": validationRequestSchema,
    "validation.decided": idSchema.extend(decisionSchema.shape),
    "coordinator.message": z.object({ role: z.enum(["owner", "coordinator"]), body: text }),
    "coordinator.checkpoint": z.object({ checkpoint: z.json() }),
    "coordinator.wakeup": z.object({
      id: text,
      candidates: z.array(wakeCandidateSchema),
      keys: z.array(text),
      reminder: z.boolean().optional(),
    }),
    "coordinator.wakeup-delivered": idSchema,
    "default-branch.seen": branchHealthSchema,
    "ticket.phase-changed": z.object({ ticket: text, from: phaseSchema.nullable(), to: phaseSchema.nullable() }),
    "ticket.report-posted": z.object({
      ticket: text,
      comment: text,
      version: text.optional(),
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
    "pull-request.commented": forgeCommentSchema,
    "review-thread.opened": reviewThreadSchema,
    "review-thread.resolved": reviewThreadSchema,
    "pull-request.conflicting": githubPullRequestSchema.extend({ pr: integer, key: text }),
    "pull-request.behind": githubPullRequestSchema.extend({ pr: integer, key: text }),

    // Durable worker input deliveries (THE-2108).
    ...deliveryPayloadSchemas,
  } as const;
}
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
const inboxItemSchema = /* @__PURE__ */ (() => inboxRequestSchema.extend({ at: text, actor: text, seq: integer }))();
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
function makeTablesSchema() {
  return z.object({
    defaultBranch: branchHealthSchema.optional(),
    // Absent on older snapshots; current daemon folds always supply this slice.
    rules: rulesStateSchema.optional(),
    /** Successful provider reads, even when no facts changed; absent on older snapshots. */
    readAt: z.record(z.string(), z.iso.datetime()).optional(),
    /** Safe usage and rate-limit pauses; older daemons omit this slice. */
    readers: z.record(z.string(), readerUsageSchema).optional(),
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
    deliveries: z.array(deliveryStateSchema).optional(),
  });
}
export type ProjectTables = z.infer<ReturnType<typeof makeTablesSchema>>;
export interface FleetTables {
  seq: number;
  projects: Record<string, ProjectTables>;
}

/** Validate the known tables without stripping extension fields or reordering JSON keys.
 * Wire consumers can keep ignoring rows and event kinds they do not use.
 */
export const projectTablesSchema = /* @__PURE__ */ makeProjectTablesSchema();
function makeProjectTablesSchema() {
  const tablesSchema = makeTablesSchema();
  return z
    .json()
    .superRefine((value, ctx) => {
      const result = tablesSchema.safeParse(value);
      if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ ...issue });
    })
    .transform((value) => value as ProjectTables);
}
