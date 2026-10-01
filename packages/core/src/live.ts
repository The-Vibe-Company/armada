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
import { NEEDS_HUMAN } from "./fleet.ts";
import type { AgentPhase, LabelPhase } from "./types.ts";

// ------------------------------------------------------------------ records

export interface ProjectInput {
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
export type EventKind = "claim" | "report" | "release" | "merge" | "inbox";

export interface EventInput {
  project: string;
  ticket: string;
  kind: EventKind;
  phase?: string | null;
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
  message: string | null;
  runtime: string | null;
  handle: string | null;
  prUrl: string | null;
  at: string;
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

/**
 * `note`: an unsolicited coordinator message to a worker, stored already resolved as a record.
 * `answer-request` and `launch-request`: the owner's requests from the dashboard, which the
 * coordinator carries out (it delivers the answer, or launches the ticket) and then resolves.
 * `request` is an older generic kind, kept readable.
 */
export type InboxKind = "question" | "plan" | "request" | "hand-back" | "note" | "answer-request" | "launch-request";
export type InboxRecipient = "coordinator" | "worker";
/** The inbox kinds the dashboard writes. */
export type RequestKind = "answer-request" | "launch-request";

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
  request?: { question: number | null; profile: string | null };
}

/** An inbox item with its resolution: when it was resolved, and the answer or reason. */
export interface StoredInboxItem extends InboxItem {
  resolvedAt: string | null;
  resolution: string | null;
}

export interface NewRequest {
  project: string;
  ticket: string;
  kind: RequestKind;
  author: string;
  body: string;
  /** answer-request: the question or plan item it answers. */
  question: number | null;
  /** launch-request: the profile asked for. */
  profile: string | null;
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

  recordEvent(e: EventInput): Promise<void>;
  /** Time of the newest event of every ticket of a project (ISO strings, by ticket id). */
  lastEventTimes(project: string): Promise<Record<string, string>>;
  /** The newest event of every ticket of a project; with `since`, only tickets with an event since then. */
  latestEvents(project: string, opts?: { since?: Date }): Promise<Record<string, LatestEvent>>;
  /** Records that the coordinator of a project is at work (it read its inbox). */
  recordCoordinatorSeen(seen: { project: string; handle?: string | null; at: Date }): Promise<void>;
  lastCoordinatorSeen(project: string): Promise<string | null>;

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
    at: Date;
  }): Promise<void>;
  /** Marks the session as gone (release or merge) and forgets the profile its claim recorded. */
  releaseRuntimeHandle(project: string, ticket: string, at: Date): Promise<void>;
  /** Sessions still holding a ticket of the project, by ticket id. */
  openRuntimeHandles(project: string): Promise<RuntimeHandle[]>;
  getRuntimeHandle(project: string, ticket: string): Promise<RuntimeHandle | null>;

  addInboxItem(item: Omit<InboxItem, "id" | "createdAt" | "request"> & { at: Date }): Promise<number>;
  /** Adds a dashboard request unless the same one is open, or the question it answers is closed: null then. */
  addRequest(r: NewRequest): Promise<number | null>;
  /** Adds the ticket's plan for the coordinator, unless one is already open. */
  putPlan(item: Item): Promise<void>;
  /** Adds the coordinator's hand-back item for a ticket, or refreshes the unresolved one. */
  putHandBack(item: Item): Promise<void>;
  /** Unresolved items of a project for one recipient, optionally for one ticket, oldest first. */
  openInboxItems(q: { project: string; recipient: InboxRecipient; ticket?: string }): Promise<InboxItem[]>;
  getInboxItem(project: string, id: number): Promise<StoredInboxItem | null>;
  /** Resolves one open item; false when it was already resolved. */
  resolveInboxItem(q: { project: string; id: number; resolution: string; at: Date }): Promise<boolean>;
  /** When the newest question or plan of each ticket was resolved, by ticket id; with `since`, only answers since then. */
  lastAnsweredAt(project: string, opts?: { since?: Date }): Promise<Record<string, string>>;
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
}

/** A claim: the session holding the ticket, its profile, the event; the launch the owner asked for is done. */
export async function recordClaim(store: FleetStore, project: string, c: ClaimRecord, at: Date): Promise<InboxItem[]> {
  await store.saveRuntimeHandle({
    project,
    ticket: c.ticket,
    runtime: c.runtime,
    handle: c.handle,
    branch: c.branch,
    at,
  });
  // A new claim replaces the profile of an earlier one; a resume keeps it.
  if (!c.resuming) await store.saveWorkerProfile({ project, ticket: c.ticket, profile: c.profile, at });
  await store.recordEvent({
    project,
    ticket: c.ticket,
    kind: "claim",
    phase: c.phase,
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

export interface ReportRecord {
  ticket: string;
  phase: LabelPhase;
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
): Promise<InboxItem[]> {
  await store.recordEvent({
    project,
    ticket: r.ticket,
    kind: "report",
    phase: r.phase,
    message: r.summary,
    prUrl: r.prUrl,
    headSha: r.headSha,
    at,
  });
  if (r.phase === "awaiting-approval" && r.previous !== r.phase) {
    const handle = await store.getRuntimeHandle(project, r.ticket);
    await store.putPlan({
      project,
      ticket: r.ticket,
      author: handle && !handle.releasedAt ? handle.handle : null,
      body: r.message,
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
  return store.openInboxItems({ project, recipient: "worker", ticket: r.ticket });
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
  r: { ticket: string; reason: string },
  at: Date,
): Promise<void> {
  const resolution = `ticket released: ${r.reason}`;
  await store.releaseRuntimeHandle(project, r.ticket, at);
  await store.resolvePlans({ project, ticket: r.ticket, resolution, at });
  // No worker is left to take an answer.
  await store.resolveInboxItems({ project, ticket: r.ticket, kind: "question", resolution, at });
  await store.resolveInboxItems({ project, ticket: r.ticket, kind: "answer-request", resolution, at });
  await store.recordEvent({ project, ticket: r.ticket, kind: "release", message: r.reason, at });
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
  return `${n} open question${n === 1 ? "" : "s"}${plans ? ` and ${plans} plan${plans === 1 ? "" : "s"}` : ""} of ${ticket} resolved.`;
}

export interface MergeRecord {
  ticket: string;
  number: number;
  url: string;
  mergeCommit: string | null;
  headSha: string;
}

export interface MergeRecorded {
  /** The session that held the merged ticket, if any. */
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
  await store.recordEvent({
    project,
    ticket: m.ticket,
    kind: "merge",
    phase: "merged",
    message: `PR #${m.number} merged as ${m.mergeCommit ?? "unknown"}`,
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
  await store.releaseRuntimeHandle(project, m.ticket, at);
  return { handle, resolved, open: await store.openRuntimeHandles(project) };
}

// ------------------------------------------------------------------ the coordinator's inbox

const MIN = 60_000;

export type InboxEntryKind = InboxKind | "silent";

export interface InboxEntry {
  /** Inbox item id for `armada answer`; null for a silent worker (it clears when the worker reports). */
  id: number | null;
  kind: InboxEntryKind;
  ticket: string | null;
  /** Runtime handle of the worker that asked, or of the silent worker. */
  author: string | null;
  body: string;
  /** When the item was added; for a silent worker, its last report. */
  createdAt: string;
  /** Appeared while `armada inbox --wait` was waiting. */
  new: boolean;
  /** Dashboard requests: the question an answer-request answers, the profile a launch-request asks for. */
  request?: { question: number | null; profile: string | null };
}

/** How an entry is told apart between two reads: `#12`, or `silent:<ticket>`. */
export const entryKey = (e: Pick<InboxEntry, "id" | "ticket">) => (e.id === null ? `silent:${e.ticket}` : `#${e.id}`);

export interface InboxReadOptions {
  project: string;
  /** The coordinator's own session, never reported silent. */
  coordinator?: string | null;
  /** `policy.silence_minutes`. */
  silentAfterMinutes: number;
  now: Date;
}

/**
 * What waits for the coordinator, oldest first: open questions, requests and
 * hand-backs, and silent workers. A worker is silent when it holds a ticket
 * (open runtime handle), its newest event is older than the silence threshold,
 * and its phase does not wait on someone else (awaiting-approval, blocked,
 * ready-to-merge). An answer given after its newest event means it owes a
 * report: silence then counts from the answer, whatever the phase. Events and
 * answers are read only since the oldest open claim (each claim records an
 * event), so the read stays bounded by the work in flight, not the history.
 */
export async function readInbox(store: FleetStore, o: InboxReadOptions): Promise<InboxEntry[]> {
  return (await readInboxAndFlight(store, o)).items;
}

/** `readInbox`, with the tickets a worker holds (open runtime handle), the coordinator's own excluded. */
async function readInboxAndFlight(
  store: FleetStore,
  o: InboxReadOptions,
): Promise<{ items: InboxEntry[]; inFlight: string[] }> {
  const now = o.now.getTime();
  const [items, handles] = await Promise.all([
    store.openInboxItems({ project: o.project, recipient: "coordinator" }),
    store.openRuntimeHandles(o.project),
  ]);
  const oldest = handles.reduce((min, h) => (h.claimedAt < min ? h.claimedAt : min), handles[0]?.claimedAt ?? "");
  const since = new Date(oldest);
  const [events, answered] = handles.length
    ? await Promise.all([store.latestEvents(o.project, { since }), store.lastAnsweredAt(o.project, { since })])
    : [{} as Record<string, LatestEvent>, {} as Record<string, string>];
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
  const inFlight: string[] = [];
  for (const h of handles) {
    if (o.coordinator && h.handle === o.coordinator) continue;
    const e = events[h.ticket];
    if (e && (e.kind === "release" || e.kind === "merge")) continue;
    inFlight.push(h.ticket);
    if (asking.has(h.ticket)) continue;
    const reported = e?.at ?? h.claimedAt;
    const answer = answered[h.ticket];
    const owesReport = !!answer && answer > reported;
    if (!owesReport && NEEDS_HUMAN.includes(e?.phase as AgentPhase)) continue;
    const last = owesReport ? answer : reported;
    const quiet = now - Date.parse(last);
    if (quiet <= o.silentAfterMinutes * MIN) continue;
    entries.push({
      id: null,
      kind: "silent",
      ticket: h.ticket,
      author: h.handle,
      body: `no report for ${Math.floor(quiet / MIN)} min${owesReport ? " since its question was answered" : ""} (phase ${e?.phase ?? "unknown"}, ${h.runtime} ${h.handle}); check it with the runtime guide's status section`,
      createdAt: last,
      new: false,
    });
  }
  return {
    items: entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id ?? 0) - (b.id ?? 0)),
    inFlight: inFlight.sort(),
  };
}

export interface InboxQuery {
  coordinator: string | null;
  silentAfterMinutes: number;
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
   * excluded: `armada watch` stops when none is left. Absent from an Armada
   * older than this field.
   */
  inFlight?: string[];
  /** Which entries and workers these are (`inboxTag`), for the next read's `etag`. */
  etag: string;
  /** Problems that did not stop the read, such as a presence that could not be recorded. */
  warnings: string[];
}

/** The coordinator's presence is recorded at most this often: a waiting coordinator reads every few seconds. */
export const PRESENCE_EVERY_MS = MIN;

/**
 * Which entries an inbox holds: its items and silent workers, not their
 * wording (a silent worker's minutes change every minute, its entry does not),
 * and which tickets are in flight.
 */
export function inboxTag(items: Pick<InboxEntry, "id" | "ticket">[], inFlight: readonly string[] = []): string {
  const keys = [...items.map(entryKey), ...inFlight.map((t) => `flight:${t}`)].sort().join("\n");
  return `"${createHash("sha256").update(keys).digest("base64url").slice(0, 22)}"`;
}

/**
 * One read of the coordinator's inbox, run by Armada with its clock: records
 * the coordinator's presence for the dashboard (at most once a minute), then
 * reads. Null when the entries are still those of `etag`: nothing to send.
 */
export async function serveInbox(
  store: FleetStore,
  project: string,
  q: InboxQuery,
  now: Date,
): Promise<InboxRead | null> {
  const warnings: string[] = [];
  // The dashboard's view of the coordinator is a nicety: the inbox is read even if it cannot be written.
  try {
    const seen = await store.lastCoordinatorSeen(project);
    if (!seen || now.getTime() - Date.parse(seen) >= PRESENCE_EVERY_MS)
      await store.recordCoordinatorSeen({ project, handle: q.coordinator, at: now });
  } catch (err) {
    warnings.push(`could not record the coordinator's presence (${err instanceof Error ? err.message : String(err)})`);
  }
  const { items, inFlight } = await readInboxAndFlight(store, {
    project,
    coordinator: q.coordinator,
    silentAfterMinutes: q.silentAfterMinutes,
    now,
  });
  const etag = inboxTag(items, inFlight);
  return q.etag === etag ? null : { items, inFlight, etag, warnings };
}

// ------------------------------------------------------------------ the CLI's side

/**
 * The fleet's live data as a command sees it: one project, through the Armada
 * API with the terminal's sign-in (`fleetClient`). Times are the server's.
 */
export interface Fleet {
  /** Registers the project, or updates its name, repository and root (`armada init`). */
  register(): Promise<void>;
  /** Time of the newest event of every ticket (`armada status`). */
  lastEventTimes(): Promise<Record<string, string>>;
  claim(c: ClaimRecord): Promise<InboxItem[]>;
  report(r: ReportRecord): Promise<InboxItem[]>;
  ask(q: { ticket: string; body: string }): Promise<number>;
  release(r: { ticket: string; reason: string }): Promise<void>;
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
  acquireLease(l: { name: string; holder: string; ttlMs: number }): Promise<LeaseResult>;
  renewLease(l: { name: string; holder: string; ttlMs: number }): Promise<boolean>;
  releaseLease(l: { name: string; holder: string }): Promise<void>;
}
