// The fleet's live data in the app's database (THE-849): the project
// registry, events, the runtime session holding each ticket and the profile
// its claim named, the coordinators' inboxes with the dashboard's requests,
// leases, and when each coordinator last read its inbox. Every row carries its
// project slug. `fleetStore` is core's `FleetStore` on it: the dashboard reads
// the fleet here, and the CLI writes it through the Armada API (THE-850,
// `cli-api.ts`). Losing this data loses live detail, never progress: Linear
// stays the record.
import type {
  CoordinatorPresence,
  CoordinatorSeen,
  EventInput,
  FleetStore,
  HistoryEvent,
  InboxItem,
  InboxKind,
  InboxReadEvent,
  InboxRecipient,
  LatestEvent,
  Lease,
  NewRequest,
  PendingLaunch,
  ProjectInput,
  ProjectRecord,
  RequestStore,
  RuntimeHandle,
  SessionRecord,
  StoredInboxItem,
  Validation,
  ValidationDecision,
  ValidationKind,
  ValidationOutcome,
  WorkerProfile,
} from "@armada/core/read";
import { REQUEST_KINDS, TIMELINE_HOURS, UNUSED_LAUNCH_GRACE_MS } from "@armada/core/read";
import { type Database, iso, isoAt, type Queryable, type Row, text, transaction } from "./db";
import { endWorker } from "./workers";

// ------------------------------------------------------------------ projects

/** Registers a project, or updates its name, repository and root. `created_at` is kept. */
export async function upsertProject(db: Queryable, p: ProjectInput, now: Date = new Date()): Promise<void> {
  await db.query(
    `INSERT INTO projects (slug, name, repository, program_root, created_at, updated_at, owner)
     VALUES ($1, $2, $3, $4, $5, $5, $6)
     ON CONFLICT (slug) DO UPDATE SET
       name = excluded.name, repository = excluded.repository,
       program_root = excluded.program_root, updated_at = excluded.updated_at,
       owner = COALESCE(projects.owner, excluded.owner)
     WHERE projects.name IS DISTINCT FROM excluded.name OR projects.repository IS DISTINCT FROM excluded.repository
        OR projects.program_root IS DISTINCT FROM excluded.program_root
        OR (projects.owner IS NULL AND excluded.owner IS NOT NULL)`,
    [p.slug, p.name, p.repository, p.programRoot, now, p.owner ?? null],
  );
}

/** Registers the project only if it is not there yet (claim and report do this). */
export async function ensureProject(db: Queryable, p: ProjectInput, now: Date = new Date()): Promise<void> {
  await db.query(
    `INSERT INTO projects (slug, name, repository, program_root, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (slug) DO NOTHING`,
    [p.slug, p.name, p.repository, p.programRoot, now],
  );
}

/**
 * Makes sure `organization` holds the project a terminal names: registered for
 * it on first contact. A project registered without an organization (`bun run
 * db register`, or before accounts) is the deployment's first organization's
 * (`home`), as on the dashboard: only that one is given it. False when another
 * organization holds it. Reads only, once the project is held.
 */
export async function holdProject(
  db: Queryable,
  p: ProjectInput,
  organization: string,
  home: () => Promise<string | null>,
  now: Date = new Date(),
): Promise<boolean> {
  const owner = async () =>
    (await db.query("SELECT organization_id FROM projects WHERE slug = $1", [p.slug])).rows[0] as Row | undefined;
  const held = await owner();
  if (held) {
    if (held.organization_id !== null) return String(held.organization_id) === organization;
    if ((await home()) !== organization) return false;
    await db.query(
      `UPDATE projects SET organization_id = $2, organization_assigned_at = $3
       WHERE slug = $1 AND organization_id IS NULL`,
      [p.slug, organization, now],
    );
  } else
    await db.query(
      `INSERT INTO projects (slug, name, repository, program_root, created_at, updated_at, organization_id, organization_assigned_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $5) ON CONFLICT (slug) DO NOTHING`,
      [p.slug, p.name, p.repository, p.programRoot, now, organization],
    );
  // Whoever got there first holds it.
  return text((await owner())?.organization_id) === organization;
}

/** Every registered project, by slug, with the organization it belongs to. */
export async function listProjects(db: Queryable): Promise<ProjectRecord[]> {
  const rs = await db.query(
    `SELECT slug, name, repository, program_root, organization_id, created_at, updated_at, owner FROM projects ORDER BY slug`,
  );
  return rs.rows.map((r) => ({
    slug: String(r.slug),
    name: String(r.name),
    repository: String(r.repository),
    programRoot: String(r.program_root),
    organization: text(r.organization_id),
    owner: text(r.owner),
    createdAt: isoAt(r.created_at),
    updatedAt: isoAt(r.updated_at),
  }));
}

/** The projects an organization holds, by slug. */
export async function projectsOf(db: Queryable, organization: string): Promise<ProjectRecord[]> {
  const rs = await db.query(
    `SELECT slug, name, repository, program_root, organization_id, created_at, updated_at, owner FROM projects
     WHERE organization_id = $1 ORDER BY slug`,
    [organization],
  );
  return rs.rows.map((r) => ({
    slug: String(r.slug),
    name: String(r.name),
    repository: String(r.repository),
    programRoot: String(r.program_root),
    organization: text(r.organization_id),
    owner: text(r.owner),
    createdAt: isoAt(r.created_at),
    updatedAt: isoAt(r.updated_at),
  }));
}

/**
 * Gives every project that has no organization to `organization`, and returns
 * how many it assigned. A project that has one keeps it, so running this again,
 * or at once from two servers, changes nothing. The dashboard runs it with the
 * deployment's first organization.
 */
export async function assignUnownedProjects(db: Queryable, organization: string, now: Date = new Date()) {
  const rs = await db.query(
    `UPDATE projects SET organization_id = $1, organization_assigned_at = $2 WHERE organization_id IS NULL`,
    [organization, now],
  );
  return rs.rowCount;
}

// ------------------------------------------------------------------ events

export async function recordEvent(db: Queryable, e: EventInput): Promise<void> {
  if (e.kind === "report")
    await db.query(
      `UPDATE fleet_sessions SET report_at = $3, report_message = $4, report_phase = $5
       WHERE project = $1 AND ticket = $2 AND released_at IS NULL AND claimed_at <= $3
         AND (report_at IS NULL OR report_at <= $3)`,
      [e.project, e.ticket, e.at, e.message ?? null, e.phase ?? null],
    );
  await db.query(
    `INSERT INTO events (project, ticket, kind, phase, message, runtime, handle, pr_url, head_sha, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      e.project,
      e.ticket,
      e.kind,
      e.phase ?? null,
      e.message ?? null,
      e.runtime ?? null,
      e.handle ?? null,
      e.prUrl ?? null,
      e.headSha ?? null,
      e.at,
    ],
  );
}

/** Time of the newest event of every ticket of a project (ISO strings, by ticket id). */
export async function lastEventTimes(db: Queryable, project: string): Promise<Record<string, string>> {
  const rs = await db.query(
    "SELECT ticket, max(created_at) AS at FROM events WHERE project = $1 AND ticket <> '' GROUP BY ticket",
    [project],
  );
  return Object.fromEntries(rs.rows.map((r) => [String(r.ticket), isoAt(r.at)]));
}

/** The newest event of every ticket of a project; with `since`, only tickets with an event since then. */
export async function latestEvents(
  db: Queryable,
  project: string,
  opts: { since?: Date } = {},
): Promise<Record<string, LatestEvent>> {
  const rs = await db.query(
    `SELECT DISTINCT ON (ticket) ticket, kind, phase, message, runtime, handle, pr_url, created_at
     FROM events WHERE project = $1 AND created_at >= $2 AND ticket <> ''
     ORDER BY ticket, created_at DESC, id DESC`,
    [project, opts.since ?? new Date(0)],
  );
  return Object.fromEntries(
    rs.rows.map((r) => [
      String(r.ticket),
      {
        kind: String(r.kind) as LatestEvent["kind"],
        phase: text(r.phase),
        message: text(r.message),
        runtime: text(r.runtime),
        handle: text(r.handle),
        prUrl: text(r.pr_url),
        at: isoAt(r.created_at),
      },
    ]),
  );
}

/** How many of a ticket's events, inbox items and launches an agent's page reads, newest first. */
export const TICKET_HISTORY_LIMIT = 200;

/** A ticket's events, newest first (its claims, reports, releases and merges). */
export async function ticketEvents(db: Queryable, project: string, ticket: string): Promise<LatestEvent[]> {
  const rs = await db.query(
    `SELECT kind, phase, message, runtime, handle, pr_url, created_at FROM events
     WHERE project = $1 AND ticket = $2 ORDER BY created_at DESC, id DESC LIMIT $3`,
    [project, ticket, TICKET_HISTORY_LIMIT],
  );
  return rs.rows.map((r) => ({
    kind: String(r.kind) as LatestEvent["kind"],
    phase: text(r.phase),
    message: text(r.message),
    runtime: text(r.runtime),
    handle: text(r.handle),
    prUrl: text(r.pr_url),
    at: isoAt(r.created_at),
  }));
}

/**
 * The worker events of a project since `since` (claims, reports, releases,
 * merges), oldest first: the history the overview's live timeline draws.
 */
export async function recentEvents(db: Queryable, project: string, since: Date): Promise<HistoryEvent[]> {
  const rs = await db.query(
    `SELECT ticket, kind, phase, message, created_at FROM events
     WHERE project = $1 AND created_at >= $2 AND kind IN ('claim', 'report', 'release', 'merge')
     ORDER BY created_at, id`,
    [project, since],
  );
  return rs.rows.map((r) => ({
    ticket: String(r.ticket),
    kind: String(r.kind),
    phase: text(r.phase),
    message: text(r.message),
    at: isoAt(r.created_at),
  }));
}

// ------------------------------------------------------------------ coordinator presence

/** Records coordinator command activity and, separately, its inbox reads: one presence row per project. */
export async function recordCoordinatorSeen(db: Queryable, seen: CoordinatorSeen): Promise<void> {
  const inboxRead = seen.inboxRead !== false;
  await db.query(
    `WITH presence AS (
       INSERT INTO coordinator_presence (project, handle, seen_at, started_at, inbox_seen_at, harness, model, cli_version)
       VALUES ($1, $2, $3, $3, CASE WHEN $4 THEN $3::timestamptz END, $5, $6, $7)
       ON CONFLICT (project) DO UPDATE SET
         started_at = CASE WHEN excluded.seen_at - coordinator_presence.seen_at >= interval '30 minutes'
                           THEN excluded.seen_at ELSE COALESCE(coordinator_presence.started_at, excluded.seen_at) END,
         handle = CASE WHEN $5::text IS NOT NULL THEN excluded.handle ELSE COALESCE(excluded.handle, coordinator_presence.handle) END,
         seen_at = excluded.seen_at,
         inbox_seen_at = CASE WHEN $4 THEN excluded.seen_at ELSE coordinator_presence.inbox_seen_at END,
         harness = COALESCE(excluded.harness, coordinator_presence.harness),
         model = CASE WHEN $5::text IS NOT NULL THEN excluded.model ELSE coordinator_presence.model END,
         cli_version = COALESCE(excluded.cli_version, coordinator_presence.cli_version)
       WHERE coordinator_presence.seen_at <= excluded.seen_at RETURNING project
     ) INSERT INTO events (project, ticket, kind, handle, created_at)
       SELECT project, '', 'inbox', $2, $3 FROM presence WHERE $4`,
    [
      seen.project,
      seen.facts?.handle ?? seen.handle ?? null,
      seen.at,
      inboxRead,
      seen.facts?.harness ?? null,
      seen.facts?.model ?? null,
      seen.cliVersion ?? seen.facts?.cliVersion ?? null,
    ],
  );
  if (inboxRead)
    await db.query(
      `DELETE FROM events WHERE id IN (SELECT id FROM events WHERE project = $1 AND kind = 'inbox'
       AND created_at < $2 ORDER BY created_at, id LIMIT 1000)`,
      [seen.project, new Date(seen.at.getTime() - 7 * 24 * 60 * 60_000)],
    );
}

export async function getCoordinatorPresence(db: Queryable, project: string): Promise<CoordinatorPresence | null> {
  const result = await db.query("SELECT * FROM coordinator_presence WHERE project = $1", [project]);
  const row = result.rows[0];
  return row
    ? {
        harness: text(row.harness) as CoordinatorPresence["harness"],
        handle: text(row.handle),
        model: text(row.model),
        cliVersion: text(row.cli_version),
        startedAt: isoAt(row.started_at ?? row.seen_at),
        seenAt: isoAt(row.seen_at),
        inboxSeenAt: iso(row.inbox_seen_at),
      }
    : null;
}

/** The inbox reads the live timeline draws: its whole span, and an hour before it for the gap that crosses its start. */
export async function inboxReads(db: Queryable, project: string, now: Date): Promise<InboxReadEvent[]> {
  const result = await db.query(
    "SELECT id, created_at, handle FROM events WHERE project = $1 AND kind = 'inbox' AND created_at >= $2 AND created_at <= $3 ORDER BY created_at, id",
    [project, new Date(now.getTime() - (TIMELINE_HOURS + 1) * 60 * 60_000), now],
  );
  return result.rows.map((row) => ({ id: Number(row.id), at: isoAt(row.created_at), handle: text(row.handle) }));
}

export async function listSessions(db: Queryable, project: string, opts: { since: Date }): Promise<SessionRecord[]> {
  const result = await db.query(
    "SELECT * FROM fleet_sessions WHERE project = $1 AND (released_at IS NULL OR released_at >= $2) ORDER BY claimed_at, ticket, handle",
    [project, opts.since],
  );
  return result.rows.map((row) => ({
    ...handleOf(row),
    agent: text(row.agent),
    model: text(row.model),
    effort: text(row.effort),
    lastReport:
      row.report_at == null
        ? null
        : { at: isoAt(row.report_at), message: text(row.report_message), phase: text(row.report_phase) },
  }));
}

/** When the coordinator of a project last ran a command; null if it never did. */
export async function lastCoordinatorSeen(db: Queryable, project: string): Promise<string | null> {
  return (await coordinatorPresence(db, project))?.seenAt ?? null;
}

/** The coordinator's presence: when it last read its inbox and the CLI it ran; null if it never did. */
export async function coordinatorPresence(
  db: Queryable,
  project: string,
): Promise<{ seenAt: string; cliVersion: string | null } | null> {
  const rs = await db.query("SELECT seen_at, cli_version FROM coordinator_presence WHERE project = $1", [project]);
  const row = rs.rows[0];
  const seenAt = iso(row?.seen_at);
  return seenAt ? { seenAt, cliVersion: text(row?.cli_version) } : null;
}

// ------------------------------------------------------------------ runtime handles and profiles

/** Records the profile of the claim now holding a ticket; null forgets the one of an earlier claim. */
export async function saveWorkerProfile(
  db: Queryable,
  w: { project: string; ticket: string; profile: WorkerProfile | null; at: Date },
): Promise<void> {
  const p = w.profile;
  await db.query(
    "UPDATE fleet_sessions SET profile = $3, agent = $4, model = $5, effort = $6 WHERE project = $1 AND ticket = $2 AND released_at IS NULL",
    [w.project, w.ticket, p?.name ?? null, p?.agent ?? null, p?.model ?? null, p?.effort ?? null],
  );
  if (!p) {
    await db.query("DELETE FROM worker_profiles WHERE project = $1 AND ticket = $2", [w.project, w.ticket]);
    return;
  }
  await db.query(
    `INSERT INTO worker_profiles (project, ticket, profile, agent, model, effort, fast_mode, routed, reason, why, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (project, ticket) DO UPDATE SET
       profile = excluded.profile, agent = excluded.agent, model = excluded.model, effort = excluded.effort,
       fast_mode = excluded.fast_mode, routed = excluded.routed, reason = excluded.reason, why = excluded.why,
       recorded_at = excluded.recorded_at`,
    [w.project, w.ticket, p.name, p.agent, p.model, p.effort, p.fastMode, p.routed, p.reason, p.why, w.at],
  );
}

/** The profile recorded for a ticket's claim, or null. */
export async function getWorkerProfile(db: Queryable, project: string, ticket: string): Promise<WorkerProfile | null> {
  const rs = await db.query(
    `SELECT profile, agent, model, effort, fast_mode, routed, reason, why
     FROM worker_profiles WHERE project = $1 AND ticket = $2`,
    [project, ticket],
  );
  const r = rs.rows[0];
  return r
    ? {
        name: String(r.profile),
        agent: String(r.agent),
        model: String(r.model),
        effort: String(r.effort),
        fastMode: r.fast_mode === true,
        routed: text(r.routed),
        reason: text(r.reason),
        why: String(r.why),
      }
    : null;
}

/** Records the session now holding a ticket; a new claim replaces a released one, the same session keeps its claim time. */
export async function saveRuntimeHandle(
  db: Queryable,
  h: { project: string; ticket: string; runtime: string; handle: string; branch: string | null; at: Date },
): Promise<void> {
  await db.query(
    `WITH previous_sessions AS (
       UPDATE fleet_sessions SET released_at = $6 WHERE project = $1 AND ticket = $2 AND released_at IS NULL AND handle <> $4
     ), current_handle AS (
       INSERT INTO runtime_handles (project, ticket, runtime, handle, branch, claimed_at, released_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL)
     ON CONFLICT (project, ticket) DO UPDATE SET
       claimed_at = CASE WHEN runtime_handles.handle = excluded.handle AND runtime_handles.released_at IS NULL
                         THEN runtime_handles.claimed_at ELSE excluded.claimed_at END,
       runtime = excluded.runtime, handle = excluded.handle, branch = excluded.branch, released_at = NULL
       RETURNING project, ticket, runtime, handle, branch, claimed_at
     ) INSERT INTO fleet_sessions (project, ticket, runtime, handle, branch, claimed_at)
     SELECT project, ticket, runtime, handle, branch, claimed_at FROM current_handle
     ON CONFLICT (project, ticket, handle, claimed_at) DO UPDATE SET branch = excluded.branch`,
    [h.project, h.ticket, h.runtime, h.handle, h.branch, h.at],
  );
}

/** Marks the session as gone (release or merge) and forgets the profile its claim recorded. */
export async function releaseRuntimeHandle(db: Database, project: string, ticket: string, at: Date): Promise<void> {
  await transaction(db, async (tx) => {
    await tx.query(
      "UPDATE fleet_sessions SET released_at = $3 WHERE project = $1 AND ticket = $2 AND released_at IS NULL",
      [project, ticket, at],
    );
    await tx.query(
      "UPDATE runtime_handles SET released_at = $1 WHERE project = $2 AND ticket = $3 AND released_at IS NULL",
      [at, project, ticket],
    );
    await tx.query("DELETE FROM worker_profiles WHERE project = $1 AND ticket = $2", [project, ticket]);
  });
}

const HANDLE_SELECT = `SELECT h.project, h.ticket, h.runtime, h.handle, h.branch, h.claimed_at, h.released_at, p.profile
  FROM runtime_handles h LEFT JOIN worker_profiles p ON p.project = h.project AND p.ticket = h.ticket`;

const handleOf = (r: Row): RuntimeHandle => ({
  project: String(r.project),
  ticket: String(r.ticket),
  runtime: String(r.runtime),
  handle: String(r.handle),
  branch: text(r.branch),
  claimedAt: isoAt(r.claimed_at),
  releasedAt: iso(r.released_at),
  profile: text(r.profile),
});

/** Sessions still holding a ticket of the project (not released), by ticket id. */
export async function openRuntimeHandles(db: Queryable, project: string): Promise<RuntimeHandle[]> {
  const rs = await db.query(`${HANDLE_SELECT} WHERE h.project = $1 AND h.released_at IS NULL ORDER BY h.ticket`, [
    project,
  ]);
  return rs.rows.map(handleOf);
}

export async function getRuntimeHandle(db: Queryable, project: string, ticket: string): Promise<RuntimeHandle | null> {
  const rs = await db.query(`${HANDLE_SELECT} WHERE h.project = $1 AND h.ticket = $2`, [project, ticket]);
  const r = rs.rows[0];
  return r ? handleOf(r) : null;
}

// ------------------------------------------------------------------ inbox

const INBOX_COLUMNS = `id, project, ticket, kind, recipient, author, body, created_at, resolved_at, resolution,
  request_question, request_profile, request_pr, request_validation`;

const inboxRow = (r: Row): StoredInboxItem => ({
  id: Number(r.id),
  project: String(r.project),
  ticket: text(r.ticket),
  kind: String(r.kind) as InboxKind,
  recipient: String(r.recipient) as InboxRecipient,
  author: text(r.author),
  body: String(r.body),
  createdAt: isoAt(r.created_at),
  ...(REQUEST_KINDS.includes(String(r.kind) as InboxKind & (typeof REQUEST_KINDS)[number])
    ? {
        request: {
          question: r.request_question === null ? null : Number(r.request_question),
          profile: text(r.request_profile),
          ...(r.request_pr == null ? {} : { pr: Number(r.request_pr) }),
        },
      }
    : {}),
  ...(r.kind === "decision"
    ? {
        request: {
          question: null,
          profile: null,
          validation: r.request_validation == null ? null : Number(r.request_validation),
        },
      }
    : {}),
  resolvedAt: iso(r.resolved_at),
  resolution: text(r.resolution),
});

const inboxItem = (r: Row): InboxItem => {
  const { resolvedAt: _r, resolution: _s, ...item } = inboxRow(r);
  return item;
};

export async function addInboxItem(
  db: Queryable,
  item: Omit<InboxItem, "id" | "createdAt" | "request"> & { at: Date },
): Promise<number> {
  const rs = await db.query<{ id: unknown }>(
    `INSERT INTO inbox_items (project, ticket, kind, recipient, author, body, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [item.project, item.ticket, item.kind, item.recipient, item.author, item.body, item.at],
  );
  return Number(rs.rows[0]?.id);
}

/**
 * Adds a dashboard request for the coordinator, in one statement: nothing is
 * added when the same request is already open (an answer to that question, a
 * launch of that ticket; a unique index settles races) or when the question
 * it answers is no longer open. Returns the new item id, or null.
 */
export async function addRequest(db: Queryable, r: NewRequest): Promise<number | null> {
  const questionOpen =
    r.kind === "answer-request" || r.kind === "plan-changes"
      ? `AND EXISTS (SELECT 1 FROM inbox_items q WHERE q.project = $1 AND q.id = $7 AND q.kind IN ('question', 'plan')
                     AND q.recipient = 'coordinator' AND q.resolved_at IS NULL AND ($3 <> 'plan-changes' OR q.kind = 'plan'))`
      : "";
  const rs = await db.query<{ id: unknown }>(
    `INSERT INTO inbox_items (project, ticket, kind, recipient, author, body, created_at, request_question, request_profile, request_pr)
     SELECT $1, $2, $3::text, 'coordinator', $4, $5, $6, $7::bigint, $8, $9::bigint WHERE true ${questionOpen}
     ON CONFLICT DO NOTHING RETURNING id`,
    [r.project, r.ticket, r.kind, r.author, r.body, r.at, r.question, r.profile, r.pr ?? null],
  );
  const id = rs.rows[0]?.id;
  return id === undefined ? null : Number(id);
}

/** Adds the ticket's plan for the coordinator, unless one is already open. */
export async function putPlan(
  db: Queryable,
  item: { project: string; ticket: string; author: string | null; body: string; at: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO inbox_items (project, ticket, kind, recipient, author, body, created_at)
     VALUES ($1, $2, 'plan', 'coordinator', $3, $4, $5) ON CONFLICT DO NOTHING`,
    [item.project, item.ticket, item.author, item.body, item.at],
  );
}

/** Adds the coordinator's hand-back item for a ticket, or refreshes the unresolved one. */
export async function putHandBack(
  db: Queryable,
  item: { project: string; ticket: string; author: string | null; body: string; at: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO inbox_items (project, ticket, kind, recipient, author, body, created_at)
     VALUES ($1, $2, 'hand-back', 'coordinator', $3, $4, $5)
     ON CONFLICT (project, ticket, kind) WHERE resolved_at IS NULL AND kind IN ('plan', 'hand-back', 'launch-request')
     DO UPDATE SET body = excluded.body, author = excluded.author, created_at = excluded.created_at`,
    [item.project, item.ticket, item.author, item.body, item.at],
  );
}

/** Unresolved items of a project for one recipient, optionally for one ticket, oldest first. */
export async function openInboxItems(
  db: Queryable,
  q: { project: string; recipient: InboxRecipient; ticket?: string },
): Promise<InboxItem[]> {
  const rs = await db.query(
    `SELECT ${INBOX_COLUMNS} FROM inbox_items
     WHERE project = $1 AND recipient = $2 AND resolved_at IS NULL ${q.ticket ? "AND ticket = $3" : ""}
     ORDER BY created_at, id`,
    q.ticket ? [q.project, q.recipient, q.ticket] : [q.project, q.recipient],
  );
  return rs.rows.map(inboxItem);
}

/** Every inbox item of a ticket, open or resolved, newest first. */
export async function ticketInboxItems(db: Queryable, project: string, ticket: string): Promise<StoredInboxItem[]> {
  const rs = await db.query(
    `SELECT ${INBOX_COLUMNS} FROM inbox_items WHERE project = $1 AND ticket = $2
     ORDER BY created_at DESC, id DESC LIMIT $3`,
    [project, ticket, TICKET_HISTORY_LIMIT],
  );
  return rs.rows.map(inboxRow);
}

/** Who asked Armada to launch a worker on a ticket (`armada brief`), and when; newest first. */
export async function ticketLaunches(
  db: Queryable,
  project: string,
  ticket: string,
): Promise<{ at: string; by: string }[]> {
  const rs = await db.query(
    `SELECT "launchedByLabel", "createdAt" FROM "armada_worker" WHERE "project" = $1 AND "ticket" = $2
     ORDER BY "createdAt" DESC LIMIT $3`,
    [project, ticket, TICKET_HISTORY_LIMIT],
  );
  return rs.rows.map((r) => ({ at: isoAt(r.createdAt), by: String(r.launchedByLabel) }));
}

/** One inbox item of a project, open or resolved; null when the project has no such item. */
export async function getInboxItem(db: Queryable, project: string, id: number): Promise<StoredInboxItem | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const rs = await db.query(`SELECT ${INBOX_COLUMNS} FROM inbox_items WHERE project = $1 AND id = $2`, [project, id]);
  const r = rs.rows[0];
  return r ? inboxRow(r) : null;
}

/** Resolves one open item; false when it was already resolved. */
export async function resolveInboxItem(
  db: Queryable,
  q: { project: string; id: number; resolution: string; at: Date },
): Promise<boolean> {
  const rs = await db.query(
    "UPDATE inbox_items SET resolved_at = $1, resolution = $2 WHERE project = $3 AND id = $4 AND resolved_at IS NULL",
    [q.at, q.resolution, q.project, q.id],
  );
  return rs.rowCount > 0;
}

/** When the newest question or plan of each ticket was resolved, by ticket id; with `since`, only answers since then. */
export async function lastAnsweredAt(
  db: Queryable,
  project: string,
  opts: { since?: Date } = {},
): Promise<Record<string, string>> {
  const rs = await db.query(
    `SELECT ticket, max(resolved_at) AS at FROM inbox_items
     WHERE project = $1 AND kind IN ('question', 'plan') AND ticket IS NOT NULL AND resolved_at >= $2
     GROUP BY ticket`,
    [project, opts.since ?? new Date(0)],
  );
  return Object.fromEntries(rs.rows.map((r) => [String(r.ticket), isoAt(r.at)]));
}

/** Resolves the open items of one kind for a ticket (e.g. its hand-back once merged); returns how many. */
export async function resolveInboxItems(
  db: Queryable,
  q: { project: string; ticket: string; kind: InboxKind; resolution: string; at: Date },
): Promise<number> {
  const rs = await db.query(
    `UPDATE inbox_items SET resolved_at = $1, resolution = $2
     WHERE project = $3 AND ticket = $4 AND kind = $5 AND resolved_at IS NULL`,
    [q.at, q.resolution, q.project, q.ticket, q.kind],
  );
  return rs.rowCount;
}

/** Resolves the open answer-requests for one question (it was answered or closed); returns how many. */
export async function resolveAnswerRequests(
  db: Queryable,
  q: { project: string; question: number; resolution: string; at: Date },
): Promise<number> {
  const rs = await db.query(
    `UPDATE inbox_items SET resolved_at = $1, resolution = $2
     WHERE project = $3 AND kind = 'answer-request' AND resolved_at IS NULL AND request_question = $4`,
    [q.at, q.resolution, q.project, q.question],
  );
  return rs.rowCount;
}

/** Resolves a ticket's open plan and the answer-requests waiting on it; returns how many plans. */
export async function resolvePlans(
  db: Database,
  input: { project: string; ticket: string; resolution: string; at: Date },
): Promise<number> {
  return transaction(db, async (tx) => {
    await tx.query(
      `UPDATE inbox_items SET resolved_at = $1, resolution = $2
       WHERE project = $3 AND kind = 'answer-request' AND resolved_at IS NULL
         AND request_question IN (SELECT id FROM inbox_items WHERE project = $3 AND ticket = $4 AND kind = 'plan'
                                  AND resolved_at IS NULL)`,
      [input.at, input.resolution, input.project, input.ticket],
    );
    const rs = await tx.query(
      `UPDATE inbox_items SET resolved_at = $1, resolution = $2
       WHERE project = $3 AND ticket = $4 AND kind = 'plan' AND resolved_at IS NULL`,
      [input.at, input.resolution, input.project, input.ticket],
    );
    return rs.rowCount;
  });
}

// ------------------------------------------------------------------ leases

const leaseOf = (r: Row): Lease => ({
  project: String(r.project),
  name: String(r.name),
  holder: String(r.holder),
  acquiredAt: isoAt(r.acquired_at),
  expiresAt: isoAt(r.expires_at),
});

/**
 * Takes the lease `name` of a project for `ttlMs`, in one transaction: the
 * lease row is locked (`SELECT ... FOR UPDATE`), so of two callers one waits
 * and then sees the other's lease. Granted when the lease is free, expired, or
 * already ours (which renews it and keeps when it was first taken). When
 * refused, `held` is the lease that keeps it.
 */
export async function acquireLease(
  db: Database,
  l: { project: string; name: string; holder: string; ttlMs: number; at: Date },
): Promise<{ acquired: true } | { acquired: false; held: Lease | null }> {
  const expires = new Date(l.at.getTime() + l.ttlMs);
  return transaction(db, async (tx) => {
    // A lease released between the insert and the lock leaves no row to update: insert again.
    for (let attempt = 0; attempt < 3; attempt++) {
      const inserted = await tx.query(
        `INSERT INTO leases (project, name, holder, acquired_at, expires_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project, name) DO NOTHING`,
        [l.project, l.name, l.holder, l.at, expires],
      );
      if (inserted.rowCount) return { acquired: true } as const;
      const rs = await tx.query(
        "SELECT project, name, holder, acquired_at, expires_at FROM leases WHERE project = $1 AND name = $2 FOR UPDATE",
        [l.project, l.name],
      );
      const row = rs.rows[0];
      if (!row) continue;
      const held = leaseOf(row);
      if (held.holder !== l.holder && Date.parse(held.expiresAt) > l.at.getTime())
        return { acquired: false, held } as const;
      const updated = await tx.query(
        `UPDATE leases SET holder = $3, expires_at = $5,
           acquired_at = CASE WHEN holder = $3 THEN acquired_at ELSE $4 END
         WHERE project = $1 AND name = $2`,
        [l.project, l.name, l.holder, l.at, expires],
      );
      if (updated.rowCount) return { acquired: true } as const;
    }
    return { acquired: false, held: null } as const;
  });
}

export async function getLease(db: Queryable, project: string, name: string): Promise<Lease | null> {
  const rs = await db.query(
    "SELECT project, name, holder, acquired_at, expires_at FROM leases WHERE project = $1 AND name = $2",
    [project, name],
  );
  const r = rs.rows[0];
  return r ? leaseOf(r) : null;
}

/** Extends a lease we hold; false when it expired and someone else took it. */
export async function renewLease(
  db: Queryable,
  l: { project: string; name: string; holder: string; ttlMs: number; at: Date },
): Promise<boolean> {
  const rs = await db.query("UPDATE leases SET expires_at = $1 WHERE project = $2 AND name = $3 AND holder = $4", [
    new Date(l.at.getTime() + l.ttlMs),
    l.project,
    l.name,
    l.holder,
  ]);
  return rs.rowCount > 0;
}

/** Gives a lease back; a lease someone else took after ours expired is left alone. */
export async function releaseLease(db: Queryable, l: { project: string; name: string; holder: string }) {
  await db.query("DELETE FROM leases WHERE project = $1 AND name = $2 AND holder = $3", [l.project, l.name, l.holder]);
}

// ------------------------------------------------------------------ launches

/**
 * The project's launches since `since` (`armada_worker`, written by
 * `workers.ts`), newest per ticket, that have not ended and that no claim of
 * their ticket followed, on tickets no session holds: the workers launched
 * that have not started (THE-872).
 */
export async function pendingLaunches(db: Queryable, project: string, since: Date): Promise<PendingLaunch[]> {
  const rs = await db.query(
    `SELECT w."ticket", w."createdAt", w."tokenUsedAt", w."tokenExpiresAt", w."runtimeHandle" FROM (
       SELECT DISTINCT ON ("ticket") "ticket", "createdAt", "tokenUsedAt", "tokenExpiresAt", "runtimeHandle", "endedAt"
       FROM "armada_worker" WHERE "project" = $1 AND "createdAt" >= $2
       ORDER BY "ticket", "createdAt" DESC, "id" DESC
     ) w
     WHERE w."endedAt" IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM events e
         WHERE e.project = $1 AND e.ticket = w."ticket" AND e.kind = 'claim' AND e.created_at >= w."createdAt"
       )
       AND NOT EXISTS (
         SELECT 1 FROM runtime_handles h WHERE h.project = $1 AND h.ticket = w."ticket" AND h.released_at IS NULL
       )
     ORDER BY w."createdAt", w."ticket"`,
    [project, since],
  );
  return rs.rows.map((r) => ({
    ticket: String(r.ticket),
    launchedAt: isoAt(r.createdAt),
    tokenUsedAt: iso(r.tokenUsedAt),
    tokenExpiresAt: isoAt(r.tokenExpiresAt),
    handle: text(r.runtimeHandle),
  }));
}

export async function expireUnusedLaunches(db: Database, project: string, now: Date): Promise<PendingLaunch[]> {
  return transaction(db, async (tx) => {
    const candidates = await tx.query(
      `SELECT w."id", w."organizationId", w."ticket", w."createdAt", w."tokenExpiresAt", w."runtimeHandle"
       FROM "armada_worker" w
       WHERE w."project" = $1 AND w."organizationId" = (SELECT organization_id FROM projects WHERE slug = $1)
         AND w."endedAt" IS NULL AND w."tokenUsedAt" IS NULL AND w."tokenExpiresAt" < $2
         AND NOT EXISTS (
           SELECT 1 FROM "armada_worker" newer
           WHERE newer."organizationId" = w."organizationId" AND newer."project" = w."project" AND newer."ticket" = w."ticket"
             AND (newer."createdAt", newer."id") > (w."createdAt", w."id")
         )
         AND NOT EXISTS (
           SELECT 1 FROM events e WHERE e.project = $1 AND e.ticket = w."ticket" AND e.kind = 'claim' AND e.created_at >= w."createdAt"
         )
         AND NOT EXISTS (
           SELECT 1 FROM runtime_handles h WHERE h.project = $1 AND h.ticket = w."ticket" AND h.released_at IS NULL
         )
       ORDER BY w."createdAt", w."ticket" FOR UPDATE OF w`,
      [project, new Date(now.getTime() - UNUSED_LAUNCH_GRACE_MS)],
    );
    const expired: PendingLaunch[] = [];
    for (const row of candidates.rows) {
      const ended = await endWorker(tx, {
        organization: String(row.organizationId),
        id: String(row.id),
        reason: "expired",
        by: { kind: "dashboard", id: "", label: "Armada (token expired)" },
        now,
      });
      if (ended)
        expired.push({
          ticket: ended.ticket,
          launchedAt: ended.createdAt,
          tokenExpiresAt: ended.tokenExpiresAt,
          tokenUsedAt: null,
          handle: ended.handle,
        });
    }
    return expired;
  });
}

// ------------------------------------------------------------------ the store

/** Core's `FleetStore` on the app's database: what the Armada API runs the CLI's operations on. */
export const fleetStore = (db: Database): FleetStore => ({
  ensureProject: (p, at) => ensureProject(db, p, at),
  upsertProject: (p, at) => upsertProject(db, p, at),
  listProjects: () => listProjects(db),
  recordEvent: (e) => recordEvent(db, e),
  lastEventTimes: (project) => lastEventTimes(db, project),
  latestEvents: (project, opts) => latestEvents(db, project, opts),
  recordCoordinatorSeen: (seen) => recordCoordinatorSeen(db, seen),
  lastCoordinatorSeen: (project) => lastCoordinatorSeen(db, project),
  getCoordinatorPresence: (project) => getCoordinatorPresence(db, project),
  inboxReads: (project, now) => inboxReads(db, project, now),
  listSessions: (project, opts) => listSessions(db, project, opts),
  saveWorkerProfile: (w) => saveWorkerProfile(db, w),
  getWorkerProfile: (project, ticket) => getWorkerProfile(db, project, ticket),
  saveRuntimeHandle: (h) => saveRuntimeHandle(db, h),
  releaseRuntimeHandle: (project, ticket, at) => releaseRuntimeHandle(db, project, ticket, at),
  openRuntimeHandles: (project) => openRuntimeHandles(db, project),
  getRuntimeHandle: (project, ticket) => getRuntimeHandle(db, project, ticket),
  addInboxItem: (item) => addInboxItem(db, item),
  addRequest: (r) => addRequest(db, r),
  putPlan: (item) => putPlan(db, item),
  putHandBack: (item) => putHandBack(db, item),
  openInboxItems: (q) => openInboxItems(db, q),
  getInboxItem: (project, id) => getInboxItem(db, project, id),
  resolveInboxItem: (q) => resolveInboxItem(db, q),
  lastAnsweredAt: (project, opts) => lastAnsweredAt(db, project, opts),
  resolveInboxItems: (q) => resolveInboxItems(db, q),
  resolveAnswerRequests: (q) => resolveAnswerRequests(db, q),
  resolvePlans: (q) => resolvePlans(db, q),
  acquireLease: (l) => acquireLease(db, l),
  getLease: (project, name) => getLease(db, project, name),
  renewLease: (l) => renewLease(db, l),
  releaseLease: (l) => releaseLease(db, l),
  pendingLaunches: (project, since) => pendingLaunches(db, project, since),
  expireUnusedLaunches: (project, now) => expireUnusedLaunches(db, project, now),
  addValidation: (v) => addValidation(db, v),
  listValidations: (q) => listValidations(db, q),
  getValidation: (project, id) => getValidation(db, project, id),
  decideValidation: (d) => decideValidation(db, d),
});

// ------------------------------------------------------------------ validations (THE-885)

const VALIDATION_COLUMNS = `id, project, ticket, kind, what, reason, choices, pr, attachments, author, created_at,
  decided_at, outcome, answer, note, decided_by`;

const json = <T>(v: unknown): T | null => (v == null ? null : typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

export const validationRow = (r: Row): Validation => ({
  id: Number(r.id),
  project: String(r.project),
  ticket: String(r.ticket),
  kind: String(r.kind) as ValidationKind,
  what: String(r.what),
  reason: text(r.reason),
  choices: json<string[]>(r.choices),
  pr: json<Validation["pr"]>(r.pr),
  attachments: json<string[]>(r.attachments) ?? [],
  author: text(r.author),
  createdAt: isoAt(r.created_at),
  decision: r.decided_at
    ? {
        outcome: String(r.outcome) as ValidationOutcome,
        answer: text(r.answer),
        note: text(r.note),
        by: text(r.decided_by),
        at: isoAt(r.decided_at),
      }
    : null,
});

/** Adds a validation; the open one it repeats is superseded in the same transaction. */
export async function addValidation(db: Database, v: Parameters<FleetStore["addValidation"]>[0]): Promise<Validation> {
  return transaction(db, async (tx) => {
    if (v.kind === "merge" && v.pr)
      await tx.query(
        `UPDATE validations SET decided_at = $3, outcome = 'superseded'
         WHERE project = $1 AND kind = 'merge' AND pr_number = $2 AND decided_at IS NULL`,
        [v.project, v.pr.number, v.at],
      );
    else if (v.kind === "validation")
      await tx.query(
        `UPDATE validations SET decided_at = $3, outcome = 'superseded'
         WHERE project = $1 AND kind = 'validation' AND ticket = $2 AND decided_at IS NULL`,
        [v.project, v.ticket, v.at],
      );
    const rs = await tx.query(
      `INSERT INTO validations (project, ticket, kind, what, reason, choices, pr, pr_number, attachments, author, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10, $11) RETURNING ${VALIDATION_COLUMNS}`,
      [
        v.project,
        v.ticket,
        v.kind,
        v.what,
        v.reason,
        v.choices ? JSON.stringify(v.choices) : null,
        v.pr ? JSON.stringify(v.pr) : null,
        v.pr?.number ?? null,
        JSON.stringify(v.attachments),
        v.author,
        v.at,
      ],
    );
    return validationRow(rs.rows[0] ?? {});
  });
}

export async function listValidations(
  db: Queryable,
  q: { project: string; ticket?: string; pr?: number; decidedSince?: Date },
): Promise<Validation[]> {
  const rs = await db.query(
    `SELECT ${VALIDATION_COLUMNS} FROM validations
     WHERE project = $1 AND ($2::text IS NULL OR ticket = $2) AND ($3::bigint IS NULL OR pr_number = $3)
       AND (decided_at IS NULL OR $4::timestamptz IS NULL OR decided_at >= $4)
     ORDER BY created_at DESC, id DESC LIMIT 200`,
    [q.project, q.ticket ?? null, q.pr ?? null, q.decidedSince ?? null],
  );
  return rs.rows.map(validationRow);
}

export async function getValidation(db: Queryable, project: string, id: number): Promise<Validation | null> {
  const rs = await db.query(`SELECT ${VALIDATION_COLUMNS} FROM validations WHERE project = $1 AND id = $2`, [
    project,
    id,
  ]);
  return rs.rows[0] ? validationRow(rs.rows[0]) : null;
}

/** The owner's decision and its inbox item for the coordinator, in one transaction; null when already decided. */
export async function decideValidation(
  db: Database,
  d: { project: string; id: number; decision: Omit<ValidationDecision, "at">; body: string; at: Date },
): Promise<{ item: number } | null> {
  return transaction(db, async (tx) => {
    const rs = await tx.query<{ ticket: unknown }>(
      `UPDATE validations SET decided_at = $3, outcome = $4, answer = $5, note = $6, decided_by = $7
       WHERE project = $1 AND id = $2 AND decided_at IS NULL RETURNING ticket`,
      [d.project, d.id, d.at, d.decision.outcome, d.decision.answer, d.decision.note, d.decision.by],
    );
    const ticket = rs.rows[0]?.ticket;
    if (ticket === undefined) return null;
    const item = await tx.query<{ id: unknown }>(
      `INSERT INTO inbox_items (project, ticket, kind, recipient, author, body, created_at, request_validation)
       VALUES ($1, $2, 'decision', 'coordinator', $3, $4, $5, $6) RETURNING id`,
      [d.project, String(ticket), d.decision.by, d.body, d.at, d.id],
    );
    return { item: Number(item.rows[0]?.id) };
  });
}

// ------------------------------------------------------------------ what the dashboard reads

/** What the Fleet view reads on each poll, and what its requests write. */
export interface LiveStore extends RequestStore {
  getCoordinatorPresence(project: string): Promise<CoordinatorPresence | null>;
  inboxReads(project: string, now: Date): Promise<InboxReadEvent[]>;
  listSessions(project: string, opts: { since: Date }): Promise<SessionRecord[]>;
  listProjects(): Promise<ProjectRecord[]>;
  assignUnownedProjects(organization: string, now: Date): Promise<number>;
  latestEvents(project: string, opts: { since: Date }): Promise<Record<string, LatestEvent>>;
  recentEvents(project: string, since: Date): Promise<HistoryEvent[]>;
  openRuntimeHandles(project: string): Promise<RuntimeHandle[]>;
  pendingLaunches(project: string, since: Date): Promise<PendingLaunch[]>;
  openInboxItems(q: { project: string; recipient: InboxRecipient }): Promise<InboxItem[]>;
  coordinatorPresence(project: string): Promise<{ seenAt: string; cliVersion: string | null } | null>;
  /** What an agent's page shows of its ticket's history. */
  ticketHistory(project: string, ticket: string): Promise<TicketHistory>;
  listValidations(q: { project: string; ticket?: string; pr?: number; decidedSince?: Date }): Promise<Validation[]>;
}

/** A ticket's history in the app's database: its events, inbox items and launches. */
export interface TicketHistory {
  events: LatestEvent[];
  inbox: StoredInboxItem[];
  launches: { at: string; by: string }[];
}

export const liveStore = (db: Database): LiveStore => ({
  getCoordinatorPresence: (project) => getCoordinatorPresence(db, project),
  inboxReads: (project, now) => inboxReads(db, project, now),
  listSessions: (project, opts) => listSessions(db, project, opts),
  listProjects: () => listProjects(db),
  assignUnownedProjects: (organization, now) => assignUnownedProjects(db, organization, now),
  latestEvents: (project, opts) => latestEvents(db, project, opts),
  recentEvents: (project, since) => recentEvents(db, project, since),
  openRuntimeHandles: (project) => openRuntimeHandles(db, project),
  pendingLaunches: (project, since) => pendingLaunches(db, project, since),
  openInboxItems: (q) => openInboxItems(db, q),
  coordinatorPresence: (project) => coordinatorPresence(db, project),
  ticketHistory: async (project, ticket) => {
    const [events, inbox, launches] = await Promise.all([
      ticketEvents(db, project, ticket),
      ticketInboxItems(db, project, ticket),
      ticketLaunches(db, project, ticket),
    ]);
    return { events, inbox, launches };
  },
  getInboxItem: (project, id) => getInboxItem(db, project, id),
  getRuntimeHandle: (project, ticket) => getRuntimeHandle(db, project, ticket),
  addRequest: (r) => addRequest(db, r),
  listValidations: (q) => listValidations(db, q),
  getValidation: (project, id) => getValidation(db, project, id),
  decideValidation: (d) => decideValidation(db, d),
});
