import { flowStepSchema, phaseSchema, sessionStateSchema } from "@armada/protocol";
import { z } from "zod";

// The protocol owns the folded state's vocabulary. The app reads the few
// fields its screens need, item by item: a row of another shape is skipped,
// never a reason to drop the whole project, and any other field is ignored.

const text = z.string();
const sessionSchema = z.object({
  ticket: text.min(1),
  session: text.min(1),
  title: text,
  phase: phaseSchema,
  state: sessionStateSchema,
  reason: text,
  flowStep: flowStepSchema,
  at: text,
  /** Where the worker runs: the sky reads its harness from it (src/fleet/sky.ts). */
  runtime: text.optional(),
  /** The worker generation and its runtime handle: what the session page's actions name (THE-2045). */
  generation: z.number().int().optional(),
  handle: text.optional(),
});
/** A ticket's comments: where a V1 claim says which runtime session holds it. */
const ticketSchema = z.object({
  id: text,
  comments: z.array(z.object({ body: text, at: text })).optional(),
});
const pullRequestSchema = z.object({
  number: z.number().int(),
  ticket: text,
  state: z.enum(["open", "closed", "merged"]),
  ci: z.enum(["none", "pending", "success", "failure"]),
  conflicting: z.boolean(),
});
/** `at`: when it was asked (the room's pinned question shows it). */
const inboxSchema = z.object({ id: text, ticket: text, kind: text, body: text, at: text.optional() });
const queueSchema = z.object({
  ticket: text,
  session: text,
  pr: z.number().int(),
  state: z.enum(["queued", "running"]),
});
const validationSchema = z.object({
  id: text,
  ticket: text,
  session: text,
  question: text,
  /** What the owner checks (the session's page lists them). */
  checks: z.array(text).optional(),
  decision: z.object({ decision: text }).nullable(),
});

export type FoldedSession = z.infer<typeof sessionSchema>;
export type FoldedTicket = z.infer<typeof ticketSchema>;
export type FoldedPullRequest = z.infer<typeof pullRequestSchema>;
export type FoldedInboxItem = z.infer<typeof inboxSchema>;
type FoldedQueueEntry = z.infer<typeof queueSchema>;
type FoldedValidation = z.infer<typeof validationSchema>;

/** One project's folded state, as far as the fleet's screens read it. */
export interface FleetState {
  readAt?: Record<string, string>;
  sessions: FoldedSession[];
  tickets: FoldedTicket[];
  pullRequests: FoldedPullRequest[];
  inbox: FoldedInboxItem[];
  queue: FoldedQueueEntry[];
  validations: FoldedValidation[];
}

/** The items of `list` this schema reads; anything else, or no list, is left out. */
function rows<T>(list: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(list)) return [];
  const out: T[] = [];
  for (const item of list) {
    const read = schema.safeParse(item);
    if (read.success) out.push(read.data);
  }
  return out;
}

const cache = new WeakMap<object, FleetState>();

/** A snapshot's folded state, read once per snapshot the client holds (the sidebar and the home share it). */
export function fleetOf(snapshot: { state: unknown }): FleetState {
  let state = cache.get(snapshot);
  if (!state) {
    state = readFleetState(snapshot.state);
    cache.set(snapshot, state);
  }
  return state;
}

/** Reads a project's folded state from the daemon's JSON. */
export function readFleetState(state: unknown): FleetState {
  const o =
    state !== null && typeof state === "object" && !Array.isArray(state) ? (state as Record<string, unknown>) : {};
  const reading = z.record(text, z.iso.datetime()).safeParse(o.readAt);
  return {
    ...(reading.success ? { readAt: reading.data } : {}),
    sessions: rows(o.sessions, sessionSchema),
    tickets: rows(o.tickets, ticketSchema),
    pullRequests: rows(o.pullRequests, pullRequestSchema),
    inbox: rows(o.inbox, inboxSchema),
    queue: rows(o.queue, queueSchema),
    validations: rows(o.validations, validationSchema),
  };
}
