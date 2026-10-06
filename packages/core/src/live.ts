// The fleet's live data: the project registry, events, the runtime session
// holding each ticket and the profile its claim named, the coordinators'
// inboxes with the dashboard's requests, leases, and when each coordinator
// last read its inbox. It lives in the Armada app's database, behind the
// Armada API (THE-850): the CLI never touches it. `FleetStore` is that
// database as the app implements it; the functions below are what each command
// records there, run by the app (`serveFleet` in `fleet-api.ts`) with its own
// clock. Losing this data loses live detail, never progress: Linear stays the
// record.
import { createHash } from "node:crypto";
import { CONFIG_DEFAULTS } from "./config.ts";
import { freshRuntimeState, liveness, NEEDS_HUMAN, inFlight as statusInFlight } from "./fleet.ts";

export { freshRuntimeState } from "./fleet.ts";

import { attachPullRequests } from "./github.ts";
import { buildModel, isClosed } from "./model.ts";
import { type OverlapReading, type OverlapWorker, overlapLines, overlaps } from "./overlap.ts";
import type { RequestKind } from "./request-kinds.ts";
import type { AgentPhase, ForgeData, Issue, LabelPhase, ProgramData, PullRequest, ShippingStage } from "./types.ts";
import type { NewValidation, Validation, ValidationDecision } from "./validations.ts";

// ------------------------------------------------------------------ records

export interface ProjectInput {
  owner?: string | null;
  slug: string;
  name: string;
  /** owner/name */
  repository: string;
  /** Linear identifier of the program root, e.g. ABC-1. */
  programRoot: string;
}

export interface ProjectRecord extends ProjectInput {
  /** The organization the project belongs to; null until one is assigned. */
  organization: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `inbox`: the coordinator read its inbox; it carries no ticket. */
export type EventKind = "claim" | "report" | "heartbeat" | "release" | "merge" | "inbox";

export interface EventInput {
  project: string;
  ticket: string;
  kind: EventKind;
  phase?: string | null;
  shippingStage?: ShippingStage | null;
  message?: string | null;
  runtime?: string | null;
  handle?: string | null;
  prUrl?: string | null;
  headSha?: string | null;
  at: Date;
}

export interface LatestEvent {
  kind: EventKind;
  phase: string | null;
  shippingStage?: ShippingStage | null;
  message: string | null;
  runtime: string | null;
  handle: string | null;
  prUrl: string | null;
  at: string;
}

import { OBSERVABLE_RUNTIMES, type RuntimeState, runtimeNameOf } from "./runtime.ts";

export { RUNTIME_STATES, type RuntimeState } from "./runtime.ts";

export interface RuntimeObservation {
  /** Runtime transition counter, including changes between observations. */
  sequence?: number;
  state: RuntimeState;
  at: string;
  /** When this state began, so an answer suppresses a block until its next transition. */
  since?: string;
}

export interface RuntimeHandle {
  project: string;
  ticket: string;
  runtime: string;
  /** Runtime-specific id of the worker's session, e.g. <workspace>/<session>. */
  handle: string;
  branch: string | null;
  claimedAt: string;
  releasedAt: string | null;
  /** Conductor profile the claim named, null when it named none. */
  profile: string | null;
  runtimeState?: RuntimeObservation | null;
  lastHeartbeatAt?: string | null;
  /** Newest owner answer on this claim; status uses the same resume grace as inbox. */
  lastAnsweredAt?: string | null;
  workerSessionId?: string | null;
}

/** Optional identity of the claim being released; workers also carry their server session id. */
export interface ReleaseGuard {
  handle?: string | null;
  claimedAt?: string | null;
  workerSessionId?: string | null;
}

export interface ReleaseRecord extends ReleaseGuard {
  ticket: string;
  reason: string;
}

export interface HeartbeatRecord {
  ticket: string;
  handle: string;
  claimedAt?: string | null;
}

export interface HeartbeatResult {
  phase?: string | null;
  shippingStage?: ShippingStage | null;
  agent?: string | null;
  active: boolean;
  claimedAt: string | null;
}

export interface WorkerProfile {
  name: string;
  agent: string;
  model: string;
  effort: string;
  fastMode: boolean;
  /** The profile routing recommended; differs from `name` for an override. */
  routed: string | null;
  reason: string | null;
  why: string;
}

export interface CoordinatorFacts {
  harness: "conductor-cloud" | "claude-code" | "codex" | "terminal";
  handle: string | null;
  model: string | null;
  cliVersion: string | null;
}

export interface CoordinatorPresence extends Omit<CoordinatorFacts, "harness"> {
  harness: CoordinatorFacts["harness"] | null;
  startedAt: string;
  seenAt: string;
  inboxSeenAt: string | null;
}

export interface CoordinatorSeen {
  project: string;
  handle?: string | null;
  cliVersion?: string | null;
  facts?: CoordinatorFacts;
  inboxRead?: boolean;
  at: Date;
}

export interface InboxReadEvent {
  id: number;
  at: string;
  handle: string | null;
}

export interface SessionRecord extends RuntimeHandle {
  agent: string | null;
  model: string | null;
  effort: string | null;
  lastReport: { at: string; message: string | null; phase: string | null; shippingStage?: ShippingStage | null } | null;
}

/**
 * `note`: an unsolicited coordinator message to a worker, stored already resolved as a record.
 * `answer-request` and `launch-request`: the owner's requests from the dashboard, which the
 * coordinator carries out (it delivers the answer, or launches the ticket) and then resolves.
 * `request` is an older generic kind, kept readable. `decision`: the owner's
 * decision on a validation (THE-885), which the coordinator carries out
 * (merges, or relays it to the worker) and then resolves.
 */
export type InboxKind = "question" | "plan" | "request" | "hand-back" | "note" | "decision" | RequestKind;
export type InboxRecipient = "coordinator" | "worker";

export interface InboxItem {
  id: number;
  project: string;
  ticket: string | null;
  kind: InboxKind;
  recipient: InboxRecipient;
  author: string | null;
  body: string;
  createdAt: string;
  /** Set on dashboard requests: the question or plan an answer-request answers, the profile a launch-request asks for. */
  request?: { question: number | null; profile: string | null; pr?: number | null; validation?: number | null };
}

/** An inbox item with its resolution: when it was resolved, and the answer or reason. */
export interface StoredInboxItem extends InboxItem {
  resolvedAt: string | null;
  resolution: string | null;
}

export interface NewRequest {
  project: string;
  ticket: string | null;
  kind: RequestKind;
  author: string;
  body: string;
  /** answer-request: the question or plan item it answers. */
  question: number | null;
  /** launch-request: the profile asked for. */
  profile: string | null;
  pr?: number | null;
  at: Date;
}

export interface Lease {
  project: string;
  name: string;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
}

export type LeaseResult = { acquired: true } | { acquired: false; held: Lease | null };

/**
 * A launch (the launch token `armada brief` asked for) whose worker has not
 * claimed the ticket since: the newest launch of its ticket, not ended.
 */
export interface PendingLaunch {
  ticket: string;
  launchedAt: string;
  /** When the worker signed in with the launch token; null while it never did. */
  tokenUsedAt: string | null;
  tokenExpiresAt?: string;
  /** Runtime bound by the coordinator; null for older or unbound launches. */
  runtime: string | null;
  /** Session bound at launch, or reported at sign-in when unbound. */
  handle: string | null;
}

/** A launch with no claim for longer than this is no longer followed: the coordinator was told long before. */
export const LAUNCH_WINDOW_MS = 24 * 60 * 60_000;
export const UNUSED_LAUNCH_GRACE_MS = 60 * 60_000;

export const unusedLaunchExpired = (launch: PendingLaunch, now: Date) =>
  !launch.tokenUsedAt &&
  now.getTime() >
    (launch.tokenExpiresAt ? Date.parse(launch.tokenExpiresAt) : Date.parse(launch.launchedAt) + 60 * 60_000) +
      UNUSED_LAUNCH_GRACE_MS;

export const followedLaunches = (launches: readonly PendingLaunch[], now: Date) =>
  launches.filter(
    (launch) => now.getTime() - Date.parse(launch.launchedAt) <= LAUNCH_WINDOW_MS && !unusedLaunchExpired(launch, now),
  );

// ------------------------------------------------------------------ the store

type Item = { project: string; ticket: string; author: string | null; body: string; at: Date };

/**
 * The fleet's live data, every project of every organization. Each project's
 * rows carry its slug and leases are scoped per project. The app implements
 * it on Postgres (`packages/dashboard/lib/fleet-store.ts`); tests on memory.
 */
export interface FleetStore {
  /** Registers the project only if it is not there yet. */
  ensureProject(p: ProjectInput, at: Date): Promise<void>;
  /** Registers a project, or updates its name, repository and root. */
  upsertProject(p: ProjectInput, at: Date): Promise<void>;
  listProjects(): Promise<ProjectRecord[]>;

  saveTicketPaths(project: string, ticket: string, paths: string[], at: Date): Promise<void>;
  ticketPaths(project: string): Promise<Record<string, string[]>>;
  deleteTicketPaths(project: string, ticket: string): Promise<void>;

  recordEvent(e: EventInput): Promise<void>;
  recordHeartbeat(
    input: HeartbeatRecord & { project: string; workerSessionId?: string | null; at: Date },
  ): Promise<HeartbeatResult>;
  heartbeatTimes(project: string): Promise<Record<string, string>>;
  /** Time of the newest event of every ticket of a project (ISO strings, by ticket id). */
  lastEventTimes(project: string): Promise<Record<string, string>>;
  /** Newest events, optionally bounded to given tickets and events since a time. */
  latestEvents(
    project: string,
    opts?: { since?: Date; tickets?: readonly string[] },
  ): Promise<Record<string, LatestEvent>>;
  /** Records that the coordinator of a project is at work (it read its inbox). */
  recordCoordinatorSeen(seen: CoordinatorSeen): Promise<void>;
  lastCoordinatorSeen(project: string): Promise<string | null>;
  getCoordinatorPresence(project: string): Promise<CoordinatorPresence | null>;
  inboxReads(project: string, now: Date): Promise<InboxReadEvent[]>;
  listSessions(project: string, opts: { since: Date }): Promise<SessionRecord[]>;

  /** Records the profile of the claim now holding a ticket; null forgets the one of an earlier claim. */
  saveWorkerProfile(w: { project: string; ticket: string; profile: WorkerProfile | null; at: Date }): Promise<void>;
  getWorkerProfile(project: string, ticket: string): Promise<WorkerProfile | null>;
  /** Records the session now holding a ticket; a new claim replaces a released one. */
  saveRuntimeHandle(h: {
    project: string;
    ticket: string;
    runtime: string;
    handle: string;
    branch: string | null;
    workerSessionId?: string | null;
    at: Date;
  }): Promise<void>;
  /** Marks the session as gone (release or merge) and forgets the profile its claim recorded. */
  releaseRuntimeHandle(project: string, ticket: string, at: Date, guard?: ReleaseGuard): Promise<boolean>;
  /** Sessions still holding a ticket of the project, by ticket id. */
  openRuntimeHandles(project: string): Promise<RuntimeHandle[]>;
  getRuntimeHandle(project: string, ticket: string): Promise<RuntimeHandle | null>;
  observeRuntime(input: {
    project: string;
    ticket: string;
    handle: string;
    claimedAt: string;
    state: RuntimeState;
    since?: string;
    sequence?: number;
    at: Date;
  }): Promise<boolean>;
  stopRuntime(input: {
    project: string;
    ticket: string;
    handle: string;
    claimedAt: string;
    at: Date;
  }): Promise<boolean>;

  addInboxItem(item: Omit<InboxItem, "id" | "createdAt" | "request"> & { at: Date }): Promise<number>;
  /** Adds a dashboard request unless the same one is open, or the question it answers is closed: null then. */
  addRequest(r: NewRequest): Promise<number | null>;
  /** Adds or refreshes the ticket's open plan for the coordinator. */
  putPlan(item: Item): Promise<void>;
  /** Adds the coordinator's hand-back item for a ticket, or refreshes the unresolved one. */
  putHandBack(item: Item): Promise<void>;
  /** Unresolved items of a project for one recipient, optionally for one ticket, oldest first. */
  openInboxItems(q: { project: string; recipient: InboxRecipient; ticket?: string }): Promise<InboxItem[]>;
  getInboxItem(project: string, id: number): Promise<StoredInboxItem | null>;
  /** Resolves one open item; false when it was already resolved. */
  resolveInboxItem(q: { project: string; id: number; resolution: string; at: Date }): Promise<boolean>;
  /** Newest resolved question, plan or relayed validation decision per ticket, bounded to tickets and a time. */
  lastAnsweredAt(
    project: string,
    opts?: { since?: Date; tickets?: readonly string[] },
  ): Promise<Record<string, string>>;
  /** Resolves the open items of one kind for a ticket; returns how many. */
  resolveInboxItems(q: {
    project: string;
    ticket: string;
    kind: InboxKind;
    resolution: string;
    at: Date;
  }): Promise<number>;
  /** Resolves the open answer-requests for one question; returns how many. */
  resolveAnswerRequests(q: { project: string; question: number; resolution: string; at: Date }): Promise<number>;
  /** Resolves a ticket's open plan and the answer-requests waiting on it; returns how many plans. */
  resolvePlans(input: { project: string; ticket: string; resolution: string; at: Date }): Promise<number>;

  /** Takes a lease when it is free, expired or already ours (which renews it); atomic. */
  acquireLease(l: { project: string; name: string; holder: string; ttlMs: number; at: Date }): Promise<LeaseResult>;
  getLease(project: string, name: string): Promise<Lease | null>;
  /** Extends a lease we hold; false when it expired and someone else took it. */
  renewLease(l: { project: string; name: string; holder: string; ttlMs: number; at: Date }): Promise<boolean>;
  /** Gives a lease back; a lease someone else took after ours expired is left alone. */
  releaseLease(l: { project: string; name: string; holder: string }): Promise<void>;

  /**
   * Launches of the project made since `since`, newest per ticket, that no
   * claim of their ticket followed and that have not ended (revoked, released,
   * merged), oldest first. A ticket a session holds (open runtime handle) has
   * none: a brief made to look at it again launches nobody, and a relaunch
   * releases the old claim first.
   */
  pendingLaunches(project: string, since: Date): Promise<PendingLaunch[]>;
  expireUnusedLaunches(project: string, now: Date): Promise<PendingLaunch[]>;

  /**
   * Adds what the owner validates (THE-885). An open one it repeats (the same
   * pull request's merge, the same ticket's validation) is superseded by it, atomically.
   */
  addValidation(v: NewValidation): Promise<Validation>;
  /** A project's validations, newest first: the open ones, and those decided since `decidedSince` (all without it). */
  listValidations(q: { project: string; ticket?: string; pr?: number; decidedSince?: Date }): Promise<Validation[]>;
  getValidation(project: string, id: number): Promise<Validation | null>;
  /**
   * Records the owner's decision on an open validation and puts it in the
   * coordinator's inbox (a `decision` item), atomically; null when it was
   * already decided.
   */
  decideValidation(d: {
    project: string;
    id: number;
    decision: Omit<ValidationDecision, "at">;
    body: string;
    at: Date;
  }): Promise<{ item: number } | null>;
}

// ------------------------------------------------------------------ what each command records

export interface ClaimRecord {
  ticket: string;
  runtime: string;
  handle: string;
  branch: string | null;
  /** The phase the claim leaves on the ticket: planning, or the one a resumed claim keeps. */
  phase: string | null;
  /** The same session claimed again: its profile and the launch requests stay as they are. */
  resuming: boolean;
  profile: WorkerProfile | null;
  workerSessionId?: string | null;
}

/** The explicit stage of this claim's latest shipping event, including a resumed claim. */
async function currentShippingStage(store: FleetStore, project: string, ticket: string, claimedAt?: string) {
  const event = (await store.latestEvents(project, { tickets: [ticket], since: new Date(claimedAt ?? 0) }))[ticket];
  return event?.phase === "shipping" ? (event.shippingStage ?? null) : null;
}

/** A claim: the session holding the ticket, its profile, the event; the launch the owner asked for is done. */
export async function recordClaim(store: FleetStore, project: string, c: ClaimRecord, at: Date): Promise<InboxItem[]> {
  const handle = c.resuming && c.phase === "shipping" ? await store.getRuntimeHandle(project, c.ticket) : null;
  const shippingStage =
    handle &&
    !handle.releasedAt &&
    handle.handle === c.handle &&
    handle.runtime === c.runtime &&
    (handle.workerSessionId ?? null) === (c.workerSessionId ?? null)
      ? await currentShippingStage(store, project, c.ticket, handle.claimedAt)
      : null;
  await store.saveRuntimeHandle({
    project,
    ticket: c.ticket,
    runtime: c.runtime,
    handle: c.handle,
    branch: c.branch,
    workerSessionId: c.workerSessionId,
    at,
  });
  // A new claim replaces the profile of an earlier one; a resume keeps it.
  if (!c.resuming) await store.saveWorkerProfile({ project, ticket: c.ticket, profile: c.profile, at });
  await store.recordEvent({
    project,
    ticket: c.ticket,
    kind: "claim",
    phase: c.phase,
    shippingStage,
    runtime: c.runtime,
    handle: c.handle,
    at,
  });
  if (c.resuming) return [];
  const asked = (await store.openInboxItems({ project, recipient: "coordinator", ticket: c.ticket })).filter(
    (i) => i.kind === "launch-request",
  );
  for (const r of asked)
    await store.resolveInboxItem({ project, id: r.id, resolution: `claimed by ${c.runtime} (${c.handle})`, at });
  return asked;
}

export interface ReportResult extends Pick<OverlapReading, "overlaps" | "incomplete"> {
  inbox: InboxItem[];
}

export interface ReportRecord {
  paths?: string[];
  ticket: string;
  phase: LabelPhase;
  shippingStage?: ShippingStage | null;
  /** The phase before this report. */
  previous: LabelPhase | null;
  /** The status line's summary. */
  summary: string;
  /** The whole message: the plan's body for awaiting-approval. */
  message: string;
  prUrl: string | null;
  headSha: string | null;
}

/** A report: the event, the plan or the hand-back for the coordinator; returns what waits for the worker. */
export async function recordReport(
  store: FleetStore,
  project: string,
  r: ReportRecord,
  at: Date,
  snapshot?: HandBackSnapshot,
): Promise<InboxItem[] | ReportResult> {
  if (r.paths !== undefined) await store.saveTicketPaths(project, r.ticket, r.paths, at);
  const reading = r.paths !== undefined ? await readOverlap(store, project, r.ticket, r.paths, at, snapshot) : null;
  const notes = reading ? overlapLines(reading) : [];
  const handle =
    r.phase === "shipping" && r.previous === "shipping" && !r.shippingStage
      ? await store.getRuntimeHandle(project, r.ticket)
      : null;
  const shippingStage =
    r.phase === "shipping"
      ? (r.shippingStage ??
        (r.previous === "shipping" ? await currentShippingStage(store, project, r.ticket, handle?.claimedAt) : null))
      : null;
  await store.recordEvent({
    project,
    ticket: r.ticket,
    kind: "report",
    phase: r.phase,
    shippingStage,
    message: r.summary,
    prUrl: r.prUrl,
    headSha: r.headSha,
    at,
  });
  if (r.phase === "awaiting-approval" && (r.previous !== r.phase || r.paths !== undefined)) {
    const handle = await store.getRuntimeHandle(project, r.ticket);
    await store.putPlan({
      project,
      ticket: r.ticket,
      author: handle && !handle.releasedAt ? handle.handle : null,
      body: [r.message, ...notes].join("\n\n"),
      at,
    });
  } else if (r.phase !== "awaiting-approval")
    await store.resolvePlans({ project, ticket: r.ticket, resolution: `worker reported ${r.phase}`, at });
  if (r.phase === "ready-to-merge")
    await store.putHandBack({
      project,
      ticket: r.ticket,
      author: null,
      body: `Agent status: ${r.phase} — ${r.summary}`,
      at,
    });
  const inbox = await store.openInboxItems({ project, recipient: "worker", ticket: r.ticket });
  return reading ? { inbox, overlaps: reading.overlaps, incomplete: reading.incomplete } : inbox;
}

/** A worker's question for the coordinator, signed with its session; returns the item id. */
export async function recordQuestion(
  store: FleetStore,
  project: string,
  q: { ticket: string; body: string },
  at: Date,
): Promise<number> {
  const held = await store.getRuntimeHandle(project, q.ticket);
  return store.addInboxItem({
    project,
    ticket: q.ticket,
    kind: "question",
    recipient: "coordinator",
    author: held && !held.releasedAt ? held.handle : null,
    body: q.body,
    at,
  });
}

/** A release: the session is gone, and its plan, questions and the answers waiting for them are closed. */
export async function recordRelease(
  store: FleetStore,
  project: string,
  r: ReleaseRecord,
  at: Date,
): Promise<{ released: boolean }> {
  const resolution = `ticket released: ${r.reason}`;
  if (!(await store.releaseRuntimeHandle(project, r.ticket, at, r))) return { released: false };
  await store.deleteTicketPaths(project, r.ticket);
  await store.resolvePlans({ project, ticket: r.ticket, resolution, at });
  // No worker is left to take an answer.
  await store.resolveInboxItems({ project, ticket: r.ticket, kind: "question", resolution, at });
  await store.resolveInboxItems({ project, ticket: r.ticket, kind: "answer-request", resolution, at });
  await store.recordEvent({ project, ticket: r.ticket, kind: "release", message: r.reason, at });
  return { released: true };
}

export interface AnswerRecord {
  /** The answer, or the note. */
  text: string;
  /** An unsolicited coordinator message rather than an answer. */
  note: boolean;
  /** The ticket answered or told; null for an item with none. */
  ticket: string | null;
  /** The inbox item answered, when the coordinator named one. */
  item: number | null;
}

/**
 * The coordinator's answer or note, already delivered through the runtime
 * guide and posted on the ticket: resolves what it answers. Returns one line
 * saying what was resolved.
 */
export async function recordAnswer(store: FleetStore, project: string, a: AnswerRecord, at: Date): Promise<string> {
  const { text } = a;
  if (a.note) {
    if (a.ticket) await store.resolvePlans({ project, ticket: a.ticket, resolution: text, at });
    const id = await store.addInboxItem({
      project,
      ticket: a.ticket,
      kind: "note",
      recipient: "worker",
      author: "coordinator",
      body: text,
      at,
    });
    await store.resolveInboxItem({ project, id, resolution: "delivered through the runtime", at });
    return `Note #${id} recorded.`;
  }
  if (a.item !== null) {
    const item = await store.getInboxItem(project, a.item);
    if (item?.kind === "answer-request") {
      // The question an answer-request answers is resolved with it.
      const question = item.request?.question ?? null;
      const answered = question === null ? null : await store.getInboxItem(project, question);
      await store.resolveInboxItem({ project, id: item.id, resolution: text, at });
      const closed =
        question !== null && (await store.resolveInboxItem({ project, id: question, resolution: text, at }));
      return `Dashboard request #${item.id} delivered${closed ? `; ${answered?.kind === "plan" ? "plan" : "question"} #${question} resolved` : ""}.`;
    }
    const done = await store.resolveInboxItem({ project, id: a.item, resolution: text, at });
    // An answer the owner typed on the dashboard for this question is now moot.
    if (item?.kind === "question" || item?.kind === "plan")
      await store.resolveAnswerRequests({ project, question: a.item, resolution: text, at });
    return done ? `Inbox item #${a.item} resolved.` : `Inbox item #${a.item} was already resolved.`;
  }
  const ticket = a.ticket ?? "";
  const n = await store.resolveInboxItems({ project, ticket, kind: "question", resolution: text, at });
  const plans = await store.resolvePlans({ project, ticket, resolution: text, at });
  await store.resolveInboxItems({ project, ticket, kind: "answer-request", resolution: text, at });
  if (n === 0 && plans === 0 && a.ticket) {
    const held = await store.getRuntimeHandle(project, ticket);
    if (
      held &&
      OBSERVABLE_RUNTIMES.includes(runtimeNameOf(held.runtime) as "herdr" | "conductor") &&
      !held.releasedAt &&
      held.runtimeState?.state === "blocked"
    ) {
      // Harness approvals have no worker-authored question. Keep the delivered
      // answer in the same indexed answer history so the inbox clears until the
      // next blocked transition, even if the terminal stays blocked briefly.
      const id = await store.addInboxItem({
        project,
        ticket,
        kind: "question",
        recipient: "coordinator",
        author: held.handle,
        body: "Herdr approval or question",
        at,
      });
      await store.resolveInboxItem({ project, id, resolution: text, at });
      return `Herdr approval or question of ${ticket} answered.`;
    }
  }
  return `${n} open question${n === 1 ? "" : "s"}${plans ? ` and ${plans} plan${plans === 1 ? "" : "s"}` : ""} of ${ticket} resolved.`;
}

export interface MergeRecord {
  ticket: string;
  number: number;
  url: string;
  mergeCommit: string | null;
  headSha: string;
  /** How the merge was decided (THE-885): "merged on its own (rule: …)" or "approved by <owner> at <time>". */
  decision?: string | null;
}

export interface MergeRecorded {
  /** The exact ended generation that held the merged ticket, if any. */
  handle: RuntimeHandle | null;
  /** How many hand-backs the merge resolved. */
  resolved: number;
  /** Sessions still holding another ticket of the project. */
  open: RuntimeHandle[];
}

/** A merge: the event, the hand-back resolved, the merged worker's questions closed and its session gone. */
export async function recordMerge(
  store: FleetStore,
  project: string,
  m: MergeRecord,
  at: Date,
): Promise<MergeRecorded> {
  const handle = await store.getRuntimeHandle(project, m.ticket);
  // A retry may follow a failed inbox write or a lost response after the event landed.
  const previous = (await store.latestEvents(project, { since: new Date(handle?.claimedAt ?? at) }))[m.ticket];
  if (previous?.kind !== "merge" || previous.prUrl !== m.url)
    await store.recordEvent({
      project,
      ticket: m.ticket,
      kind: "merge",
      phase: "merged",
      message: `PR #${m.number} merged as ${m.mergeCommit ?? "unknown"}${m.decision ? `; ${m.decision}` : ""}`,
      prUrl: m.url,
      headSha: m.headSha,
      at,
    });
  const resolved = await store.resolveInboxItems({
    project,
    ticket: m.ticket,
    kind: "hand-back",
    resolution: `merged as ${m.mergeCommit ?? "unknown"}`,
    at,
  });
  // No worker is left to take an answer.
  await store.resolveInboxItems({ project, ticket: m.ticket, kind: "question", resolution: "merged", at });
  await store.resolveInboxItems({ project, ticket: m.ticket, kind: "answer-request", resolution: "merged", at });
  await store.resolveInboxItems({ project, ticket: m.ticket, kind: "decision", resolution: "merged", at });
  const released = handle
    ? await store.releaseRuntimeHandle(project, m.ticket, at, {
        handle: handle.handle,
        claimedAt: handle.claimedAt,
        workerSessionId: handle.workerSessionId,
      })
    : false;
  if (released || !handle) await store.deleteTicketPaths(project, m.ticket);
  return {
    handle: released && handle ? { ...handle, releasedAt: handle.releasedAt ?? at.toISOString() } : null,
    resolved,
    open: await store.openRuntimeHandles(project),
  };
}

export interface ValidationRecord extends Pick<NewValidation, "checks" | "excerpts" | "details"> {
  ticket: string;
  kind: NewValidation["kind"];
  what: string;
  reason: string | null;
  choices: string[] | null;
  pr: NewValidation["pr"];
  attachments: string[];
}

/** What the owner is asked to validate, signed with the worker's session when a worker asks, else `author`. */
export async function recordValidation(
  store: FleetStore,
  project: string,
  v: ValidationRecord & { worker: boolean; author: string | null },
  at: Date,
): Promise<Validation> {
  const held = v.worker ? await store.getRuntimeHandle(project, v.ticket) : null;
  const { worker: _worker, author, ...rest } = v;
  return store.addValidation({
    project,
    ...rest,
    author: held && !held.releasedAt ? held.handle : author,
    at,
  });
}

/**
 * A ticket done without a pull request once the owner approved its
 * validation (a design ticket, `armada done`): recorded like a merge, so its
 * session ends, its items close and the dashboard shows it landed.
 */
export async function recordDone(
  store: FleetStore,
  project: string,
  d: { ticket: string; message: string },
  at: Date,
): Promise<MergeRecorded> {
  const handle = await store.getRuntimeHandle(project, d.ticket);
  await store.recordEvent({ project, ticket: d.ticket, kind: "merge", phase: "merged", message: d.message, at });
  let resolved = 0;
  for (const kind of ["hand-back", "question", "answer-request", "decision", "plan"] as const)
    resolved += await store.resolveInboxItems({ project, ticket: d.ticket, kind, resolution: d.message, at });
  await store.releaseRuntimeHandle(project, d.ticket, at);
  return { handle, resolved, open: await store.openRuntimeHandles(project) };
}

// ------------------------------------------------------------------ the coordinator's inbox

const MIN = 60_000;

/**
 * `silent`: a worker gone quiet; `not-started`: a worker launched that never
 * claimed (both read from the fleet, they clear on their own); `version`: a
 * newer Armada is out (`armada watch` only, never stored).
 */
export type InboxEntryKind = InboxKind | "runtime-blocked" | "silent" | "stopped" | "quiet" | "not-started" | "version";

export interface InboxEntry {
  /**
   * Inbox item id for `armada answer`; null for a silent worker (it clears
   * when the worker reports) or a worker not started (it clears on its claim).
   */
  id: number | null;
  kind: InboxEntryKind;
  ticket: string | null;
  /** Runtime handle of the worker that asked, or of the silent or not started worker when known. */
  author: string | null;
  body: string;
  /** When the item was added; for a silent worker, its last report; for a worker not started, its launch. */
  createdAt: string;
  /** Appeared while `armada inbox --wait` was waiting. */
  new: boolean;
  /** Dashboard requests: the question an answer-request answers, the profile a launch-request asks for. */
  request?: InboxItem["request"];
  /** A `version` entry: the Armada release that is out. */
  version?: string;
}

/** Items a worker's report rewrites in place: a hand-back on a new head, a plan. */
const REWRITTEN: readonly InboxEntryKind[] = ["hand-back", "plan"];

const digest = (text: string) => createHash("sha256").update(text).digest("base64url").slice(0, 12);

/**
 * How an entry is told apart between two reads: `#12`, `silent:<ticket>`,
 * `not-started:<ticket>` or `version:<version>`. A hand-back or a plan
 * rewritten in place keeps its id, so its key carries a digest of its text
 * too (a hand-back's names its head SHA): handed back again on a new head, it
 * is new to the coordinator.
 */
export const entryKey = (
  e: Pick<InboxEntry, "id" | "kind" | "ticket" | "body"> & { version?: string | undefined; createdAt?: string },
) =>
  e.id !== null
    ? REWRITTEN.includes(e.kind)
      ? `#${e.id}@${digest(e.body)}`
      : `#${e.id}`
    : e.version
      ? `version:${e.version}`
      : e.kind === "not-started" && e.body.startsWith("not started (token expired)")
        ? `not-started:${e.ticket}:expired@${digest(e.body)}`
        : e.kind === "stopped"
          ? `stopped:${e.ticket}@${e.createdAt}`
          : `${e.kind}:${e.ticket}`;

/** The stored project reading; inbox reconciliation never fetches external state. */
export interface HandBackSnapshot {
  repository: string;
  issues: readonly Pick<Issue, "id" | "statusType">[];
  prs: readonly Pick<PullRequest, "repo" | "number" | "state">[];
  /** Full stored reading for the same in-flight derivation as status. */
  flight?: { program: ProgramData; forge: ForgeData | null; after: string };
}

/** Compares declarations with in-flight tickets using only stored data. */
export async function readOverlap(
  store: FleetStore,
  project: string,
  ticket: string,
  paths: string[],
  at: Date,
  snapshot?: HandBackSnapshot,
): Promise<OverlapReading> {
  const [handles, plans, events] = await Promise.all([
    store.openRuntimeHandles(project),
    store.ticketPaths(project),
    store.latestEvents(project),
  ]);
  const flight = snapshot?.flight;
  const model = flight ? buildModel(attachPullRequests(flight.program, flight.forge), flight.program.rootId) : null;
  const lanes =
    model && flight
      ? statusInFlight(model, flight.program.comments, {
          now: at.getTime(),
          silentAfterMinutes: CONFIG_DEFAULTS.silentAfterMinutes,
          live: { after: flight.after, events, handles: Object.fromEntries(handles.map((h) => [h.ticket, h])) },
        })
      : [];
  const workers = new Map<string, OverlapWorker>();
  for (const lane of lanes) {
    const pr = lane.pr;
    workers.set(lane.issue.id, {
      ticket: lane.issue.id,
      pr: pr?.number ?? null,
      files: pr ? (pr.files?.map((f) => f.path) ?? null) : [],
      filesComplete: !pr || pr.filesComplete === true,
      plan: plans[lane.issue.id] ?? [],
    });
  }
  const closed = new Set(snapshot?.issues.filter(isClosed).map((i) => i.id));
  for (const handle of handles) {
    if (closed.has(handle.ticket) || workers.has(handle.ticket)) continue;
    // A live release or merge wins over an old snapshot, including stale handles.
    const event = events[handle.ticket];
    if (event && event.at >= handle.claimedAt && ["release", "merge"].includes(event.kind)) continue;
    workers.set(handle.ticket, {
      ticket: handle.ticket,
      pr: null,
      files: [],
      filesComplete: true,
      plan: plans[handle.ticket] ?? [],
    });
  }
  workers.delete(ticket);
  const others = [...workers.values()].sort((a, b) => a.ticket.localeCompare(b.ticket));
  return { workers: others, overlaps: overlaps(paths, others), incomplete: !flight?.forge };
}

/** The PR named by the worker's generated hand-back status line. */
export function handBackPr(body: string): number | null {
  const match = body.split("\n", 1)[0]?.match(/\bPR #(\d+)\b/i);
  const number = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Resolve only hand-backs confirmed merged or completed in the stored reading. */
async function reconcileHandBacks(
  store: FleetStore,
  items: InboxItem[],
  snapshot: HandBackSnapshot | undefined,
  now: Date,
): Promise<InboxItem[]> {
  if (!snapshot) return items;
  const completed = new Set(snapshot.issues.filter((i) => i.statusType === "completed").map((i) => i.id));
  const merged = new Set(
    snapshot.prs
      .filter((p) => p.repo.toLowerCase() === snapshot.repository.toLowerCase() && p.state === "merged")
      .map((p) => p.number),
  );
  const open: InboxItem[] = [];
  for (const item of items) {
    if (
      item.kind === "hand-back" &&
      ((item.ticket && completed.has(item.ticket)) || merged.has(handBackPr(item.body) ?? 0))
    ) {
      await store.resolveInboxItem({ project: item.project, id: item.id, resolution: "resolved: PR merged", at: now });
    } else open.push(item);
  }
  return open;
}

export interface InboxReadOptions {
  snapshot?: HandBackSnapshot;
  project: string;
  /** The coordinator's own session, never reported silent. */
  coordinator?: string | null;
  /** `policy.silence_minutes`. */
  silentAfterMinutes: number;
  quietAfterMinutes?: number;
  /** `policy.not_started_minutes`; its default when absent. */
  notStartedMinutes?: number;
  now: Date;
}

const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;

/**
 * Why a launched worker shows as not started, and what the coordinator does:
 * a worker that never used its launch token never reached its login line; one
 * that used it signed in and stopped before its claim.
 */
export function notStartedBody(l: PendingLaunch, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(l.launchedAt)) / MIN);
  const why = l.tokenUsedAt
    ? `the worker signed in with its launch token at ${hhmm(l.tokenUsedAt)}, then stopped before \`armada claim\``
    : "its launch token was never used: the worker never reached its `armada login` line (an install that failed, a prompt cut short)";
  return `launched ${minutes} min ago and never claimed; ${why}${l.handle ? ` (session ${l.handle})` : ""}. Check its session with the runtime guide's status section; launch it again with armada brief ${l.ticket} --prompt, or revoke it with armada launch revoke ${l.ticket}`;
}

/** The pending launches with no claim for longer than `minutes`: the workers that never started. */
export const notStartedLaunches = (launches: readonly PendingLaunch[], now: Date, minutes: number) =>
  followedLaunches(launches, now).filter((l) => now.getTime() - Date.parse(l.launchedAt) > minutes * MIN);

/**
 * What waits for the coordinator, oldest first: open questions, requests and
 * hand-backs, workers launched that never claimed (`not-started`), and silent workers. A worker is silent when it holds a ticket
 * (open runtime handle), its newest heartbeat or report is older than the silence threshold,
 * and its phase does not wait on someone else (awaiting-approval, blocked,
 * awaiting-validation, ready-to-merge). An answer given after its newest event means it owes a
 * report: silence then counts from the answer or a newer heartbeat, whatever the phase. Events and
 * answers are read only since the oldest open claim (each claim records an
 * event), so the read stays bounded by the work in flight, not the history.
 */
export async function readInbox(store: FleetStore, o: InboxReadOptions): Promise<InboxEntry[]> {
  return (await readInboxAndFlight(store, o)).items;
}

/**
 * `readInbox`, with the same tickets in flight as status when a stored reading
 * exists, the coordinator's own excluded. Recent unclaimed launches are also
 * followed until they need the coordinator's attention.
 */
async function readInboxAndFlight(
  store: FleetStore,
  o: InboxReadOptions,
): Promise<{ items: InboxEntry[]; inFlight: string[] }> {
  const now = o.now.getTime();
  const [stored, handles, launches] = await Promise.all([
    store.openInboxItems({ project: o.project, recipient: "coordinator" }),
    store.openRuntimeHandles(o.project),
    store.pendingLaunches(o.project, new Date(now - LAUNCH_WINDOW_MS)),
  ]);
  const items = await reconcileHandBacks(store, stored, o.snapshot, o.now);
  const flight = o.snapshot?.flight;
  const closed = new Set(o.snapshot?.issues.filter(isClosed).map((i) => i.id));
  const model = flight ? buildModel(attachPullRequests(flight.program, flight.forge), flight.program.rootId) : null;
  const eventTickets = [
    ...new Set([
      ...handles.map((h) => h.ticket),
      ...launches.map((l) => l.ticket),
      ...(model?.program.filter((i) => model.isLeaf(i)).map((i) => i.id) ?? []),
    ]),
  ].filter((ticket) => !closed.has(ticket));
  const answerTickets = handles.map((h) => h.ticket).filter((ticket) => !closed.has(ticket));
  const oldest = [
    ...handles.filter((h) => !closed.has(h.ticket)).map((h) => h.claimedAt),
    ...launches.filter((l) => !closed.has(l.ticket)).map((l) => l.launchedAt),
  ].sort()[0];
  const since = new Date(flight && (!oldest || flight.after < oldest) ? flight.after : (oldest ?? o.now.toISOString()));
  const [events, answered] = await Promise.all([
    eventTickets.length
      ? store.latestEvents(o.project, { since: flight ? new Date(0) : since, tickets: eventTickets })
      : Promise.resolve({} as Record<string, LatestEvent>),
    answerTickets.length
      ? store.lastAnsweredAt(o.project, { since, tickets: answerTickets })
      : Promise.resolve({} as Record<string, string>),
  ]);
  const entries: InboxEntry[] = items.map((i) => ({
    id: i.id,
    kind: i.kind,
    ticket: i.ticket,
    author: i.author,
    body: i.body,
    createdAt: i.createdAt,
    new: false,
    ...(i.request ? { request: i.request } : {}),
  }));
  const asking = new Set(items.filter((i) => i.kind === "question").map((i) => i.ticket));
  const planning = new Set(items.filter((i) => i.kind === "plan").map((i) => i.ticket));
  const held =
    flight && model
      ? new Set(
          statusInFlight(model, flight.program.comments, {
            now,
            silentAfterMinutes: o.silentAfterMinutes,
            live: { after: flight.after, events, handles: Object.fromEntries(handles.map((h) => [h.ticket, h])) },
          }).map((lane) => lane.issue.id),
        )
      : null;
  // A claim may arrive before its newly created ticket reaches the stored reading.
  const known = new Set(flight?.program.issues.map((i) => i.id));
  const own = new Set(handles.filter((h) => o.coordinator && h.handle === o.coordinator).map((h) => h.ticket));
  const inFlight: string[] = held ? [...held].filter((ticket) => !own.has(ticket)) : [];
  for (const h of handles) {
    const derived = held !== null && known.has(h.ticket);
    if (own.has(h.ticket) || closed.has(h.ticket) || (derived && !held?.has(h.ticket))) continue;
    const e = events[h.ticket];
    if (!derived && e && (e.kind === "release" || e.kind === "merge") && e.at >= h.claimedAt) continue;
    if (!derived) inFlight.push(h.ticket);
    if (asking.has(h.ticket)) continue;
    const observation = h.runtimeState;
    const answer = answered[h.ticket];
    const runtimeBlocked = freshRuntimeState(observation, o.now, o.silentAfterMinutes, h.claimedAt) === "blocked";
    if (runtimeBlocked && planning.has(h.ticket)) continue;
    if (runtimeBlocked && observation && (!answer || answer < (observation.since ?? observation.at))) {
      entries.push({
        id: null,
        kind: "runtime-blocked",
        ticket: h.ticket,
        author: h.handle,
        body: `${h.runtime} worker is blocked on an approval or question; read its terminal with the runtime guide and answer with armada answer ${h.ticket}`,
        createdAt: observation.at,
        new: false,
      });
      continue;
    }
    if (runtimeBlocked) continue;
    const reported = e?.at ?? h.claimedAt;
    const owesReport = !!answer && answer > reported;
    if (!owesReport && NEEDS_HUMAN.includes(e?.phase as AgentPhase)) continue;
    const last = owesReport ? answer : reported;
    // A waiting turn may lose its heartbeat process. An answer or resumed report
    // grants a full silence window before the next heartbeat has to arrive.
    const heartbeat = h.lastHeartbeatAt && h.lastHeartbeatAt > last ? h.lastHeartbeatAt : null;
    const life = liveness({
      now: o.now,
      silentAfterMinutes: o.silentAfterMinutes,
      phase: e?.phase,
      lastReport: last,
      lastHeartbeat: heartbeat,
      runtimeState: observation,
      claimedAt: h.claimedAt,
      owesReport,
    });
    const { alive, silence } = life;
    if (life.kind === "stopped") {
      entries.push({
        id: null,
        kind: "stopped",
        ticket: h.ticket,
        author: h.handle,
        body: `stopped: its session is idle and it did not hand back (phase ${e?.phase ?? "unknown"}, ${h.runtime} ${h.handle}); read its last reply with the runtime guide and resume or release it`,
        createdAt: observation?.since ?? observation?.at ?? last,
        new: false,
      });
      continue;
    }
    const quiet = now - Date.parse(last);
    const silent = life.kind === "silent";
    if (!silent && (!heartbeat || quiet <= (o.quietAfterMinutes ?? CONFIG_DEFAULTS.quietAfterMinutes) * MIN)) continue;
    entries.push({
      id: null,
      kind: silent ? "silent" : "quiet",
      ticket: h.ticket,
      author: h.handle,
      body: silent
        ? `no ${heartbeat ? "heartbeat" : "report"} for ${Math.floor(silence / MIN)} min${life.state === "working" && observation ? `, but its session is still working (observed ${observation.at.slice(11, 16)})` : ""}${owesReport && !heartbeat ? " since its question was answered" : ""} (phase ${e?.phase ?? "unknown"}, ${h.runtime} ${h.handle}); check it with the runtime guide's status section`
        : `${h.ticket} has been working ${Math.floor(quiet / MIN)} min without a report (heartbeats are arriving, phase ${e?.phase ?? "unknown"})`,
      createdAt: silent ? alive : last,
      new: false,
    });
  }
  // A worker launched is in flight from its launch, so a watch started then waits for its claim;
  // once it shows as not started, its entry carries it until the coordinator acts.
  const currentLaunches = launches.filter((l) => {
    const event = events[l.ticket];
    return (
      !closed.has(l.ticket) &&
      !own.has(l.ticket) &&
      !(event && (event.kind === "release" || event.kind === "merge") && event.at >= l.launchedAt)
    );
  });
  const late = notStartedLaunches(currentLaunches, o.now, o.notStartedMinutes ?? CONFIG_DEFAULTS.notStartedMinutes);
  for (const l of followedLaunches(currentLaunches, o.now))
    if (!late.includes(l) && !inFlight.includes(l.ticket)) inFlight.push(l.ticket);
  for (const l of late)
    entries.push({
      id: null,
      kind: "not-started",
      ticket: l.ticket,
      author: l.handle,
      body: notStartedBody(l, o.now),
      createdAt: l.launchedAt,
      new: false,
    });
  return {
    items: entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id ?? 0) - (b.id ?? 0)),
    inFlight: inFlight.sort(),
  };
}

export interface InboxQuery {
  facts?: CoordinatorFacts;
  coordinator: string | null;
  silentAfterMinutes: number;
  quietAfterMinutes?: number;
  /** `policy.not_started_minutes`; Armada uses its default for an older CLI that does not send it. */
  notStartedMinutes?: number;
  /**
   * The `etag` of the caller's previous read. When the inbox still has the
   * same entries, Armada answers "not modified" (HTTP 304, no body): a
   * waiting coordinator polls cheaply.
   */
  etag: string | null;
}

export interface InboxRead {
  /** Oldest first. */
  items: InboxEntry[];
  /**
   * Tickets a worker holds (an open runtime handle), the coordinator's own
   * excluded, and tickets a worker was launched on and has not claimed yet:
   * `armada watch` stops when none is left. Absent from an Armada older than
   * this field.
   */
  inFlight?: string[];
  /** Which entries and workers these are (`inboxTag`), for the next read's `etag`. */
  etag: string;
  /** Problems that did not stop the read, such as a presence that could not be recorded. */
  warnings: string[];
}

/**
 * Which entries an inbox holds: its items, silent and not started workers, not their
 * wording (a silent worker's minutes change every minute, its entry does not),
 * and which tickets are in flight.
 */
export function inboxTag(
  items: Pick<InboxEntry, "id" | "kind" | "ticket" | "body">[],
  inFlight: readonly string[] = [],
): string {
  const keys = [...items.map(entryKey), ...inFlight.map((t) => `flight:${t}`)].sort().join("\n");
  return `"${createHash("sha256").update(keys).digest("base64url").slice(0, 22)}"`;
}

/**
 * One read of the coordinator's inbox, run by Armada with its clock: records
 * the coordinator's presence and inbox-read event for the dashboard, then
 * reads. Null when the entries are still those of `etag`: nothing to send.
 */
export async function serveInbox(
  store: FleetStore,
  project: string,
  q: InboxQuery,
  now: Date,
  /** The coordinator's CLI version, from the request's `x-armada-cli-version`. */
  cliVersion: string | null = null,
  snapshot?: HandBackSnapshot,
): Promise<InboxRead | null> {
  const warnings: string[] = [];
  const expired = await store.expireUnusedLaunches(project, now);
  // The dashboard's view of the coordinator is a nicety: the inbox is read even if it cannot be written.
  try {
    await store.recordCoordinatorSeen({
      project,
      handle: q.coordinator,
      facts: q.facts,
      cliVersion,
      inboxRead: true,
      at: now,
    });
  } catch (err) {
    warnings.push(`could not record the coordinator's presence (${err instanceof Error ? err.message : String(err)})`);
  }
  const { items, inFlight } = await readInboxAndFlight(store, {
    snapshot,
    project,
    coordinator: q.coordinator,
    silentAfterMinutes: q.silentAfterMinutes,
    quietAfterMinutes: q.quietAfterMinutes,
    ...(q.notStartedMinutes !== undefined ? { notStartedMinutes: q.notStartedMinutes } : {}),
    now,
  });
  for (const launch of expired)
    items.push({
      id: null,
      kind: "not-started",
      ticket: launch.ticket,
      author: launch.handle,
      body: `not started (token expired): the unused launch of ${launch.ticket} at ${launch.launchedAt} has cleared; launch it again with armada brief ${launch.ticket} --prompt`,
      createdAt: launch.launchedAt,
      new: false,
    });
  items.sort((first, second) => first.createdAt.localeCompare(second.createdAt));
  const etag = inboxTag(items, inFlight);
  return q.etag === etag ? null : { items, inFlight, etag, warnings };
}

// ------------------------------------------------------------------ the CLI's side

/**
 * The fleet's live data as a command sees it: one project, through the Armada
 * API with the terminal's sign-in (`fleetClient`). Times are the server's.
 */
export interface Fleet {
  coordinator(facts: CoordinatorFacts): Promise<void>;
  request(input: {
    kind: "merge-request" | "release-request" | "plan-changes";
    ticket?: string;
    pr?: number;
    question?: number;
    text?: string;
  }): Promise<number>;
  /** Registers the project, or updates its name, repository and root (`armada init`). */
  register(): Promise<void>;
  /** Time of the newest event of every ticket (`armada status`). */
  lastEventTimes(): Promise<Record<string, string>>;
  latestEvents(): Promise<Record<string, LatestEvent>>;
  heartbeatTimes(): Promise<Record<string, string>>;
  heartbeat(input: HeartbeatRecord): Promise<HeartbeatResult>;
  runtimeHandles(): Promise<RuntimeHandle[]>;
  runtimeHandle(ticket: string): Promise<RuntimeHandle | null>;
  observeRuntime(input: {
    ticket: string;
    handle: string;
    claimedAt: string;
    state: RuntimeState;
    since?: string;
    sequence?: number;
  }): Promise<boolean>;
  stopRuntime(input: { ticket: string; handle: string; claimedAt: string }): Promise<boolean>;
  /** Launches no claim followed yet, within the last day (`armada status`). */
  pendingLaunches(): Promise<PendingLaunch[]>;
  claim(c: ClaimRecord): Promise<InboxItem[]>;
  report(r: ReportRecord): Promise<ReportResult>;
  overlap(input: { ticket: string; paths: string[] }): Promise<OverlapReading>;
  ask(q: { ticket: string; body: string }): Promise<number>;
  release(r: Omit<ReleaseRecord, "workerSessionId">): Promise<{ released: boolean }>;
  /** The coordinator's inbox; null when its entries are still those of `q.etag` (not modified). */
  inbox(q: InboxQuery): Promise<InboxRead | null>;
  /** One inbox item, open or resolved; null when the project has no such item. */
  inboxItem(id: number): Promise<StoredInboxItem | null>;
  /** The coordinator's open items for one ticket. */
  ticketItems(ticket: string): Promise<InboxItem[]>;
  answer(a: AnswerRecord): Promise<string>;
  /** Resolves one open item (a declined launch); false when it was already resolved. */
  resolve(r: { id: number; resolution: string }): Promise<boolean>;
  merge(m: MergeRecord): Promise<MergeRecorded>;
  /** Asks the owner to validate (THE-885); `url` is the approval link on the dashboard. */
  validate(v: ValidationRecord): Promise<{ validation: Validation; url: string }>;
  /** A ticket's or a pull request's validations, newest first. */
  validations(q: { ticket?: string; pr?: number }): Promise<Validation[]>;
  /** Records a ticket done without a pull request after the owner's approval (`armada done`). */
  done(d: { ticket: string; message: string }): Promise<MergeRecorded>;
  acquireLease(l: { name: string; holder: string; ttlMs: number }): Promise<LeaseResult>;
  renewLease(l: { name: string; holder: string; ttlMs: number }): Promise<boolean>;
  releaseLease(l: { name: string; holder: string }): Promise<void>;
}
