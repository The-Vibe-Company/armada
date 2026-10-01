// The fleet's live data in the app's database (THE-849): the project
// registry, events, the runtime session holding each ticket and the profile
// its claim named, the coordinators' inboxes with the dashboard's requests,
// leases, and when each coordinator last read its inbox. Every row carries its
// project slug. The same operations as core's Turso adapter (`turso.ts`), with
// the same results, so the dashboard reads the fleet here today and the CLI's
// calls through the app (THE-850) write it here next. Losing this data loses
// live detail, never progress: Linear stays the record.
import type {
  EventInput,
  InboxItem,
  InboxKind,
  InboxRecipient,
  LatestEvent,
  Lease,
  NewRequest,
  ProjectInput,
  ProjectRecord,
  RequestStore,
  RuntimeHandle,
  StoredInboxItem,
  WorkerProfile,
} from "@armada/core/read";
import { type Database, iso, isoAt, type Queryable, type Row, text, transaction } from "./db";

// ------------------------------------------------------------------ projects

/** Registers a project, or updates its name, repository and root. `created_at` is kept. */
export async function upsertProject(db: Queryable, p: ProjectInput, now: Date = new Date()): Promise<void> {
  await db.query(
    `INSERT INTO projects (slug, name, repository, program_root, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (slug) DO UPDATE SET
       name = excluded.name, repository = excluded.repository,
       program_root = excluded.program_root, updated_at = excluded.updated_at
     WHERE projects.name IS DISTINCT FROM excluded.name OR projects.repository IS DISTINCT FROM excluded.repository
        OR projects.program_root IS DISTINCT FROM excluded.program_root`,
    [p.slug, p.name, p.repository, p.programRoot, now],
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

/** Every registered project, by slug, with the organization it belongs to. */
export async function listProjects(db: Queryable): Promise<ProjectRecord[]> {
  const rs = await db.query(
    `SELECT slug, name, repository, program_root, organization_id, created_at, updated_at FROM projects ORDER BY slug`,
  );
  return rs.rows.map((r) => ({
    slug: String(r.slug),
    name: String(r.name),
    repository: String(r.repository),
    programRoot: String(r.program_root),
    organization: text(r.organization_id),
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

// ------------------------------------------------------------------ coordinator presence

/** Records that the coordinator of a project is at work (it read its inbox): one row per project. */
export async function recordCoordinatorSeen(
  db: Queryable,
  seen: { project: string; handle?: string | null; at: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO coordinator_presence (project, handle, seen_at) VALUES ($1, $2, $3)
     ON CONFLICT (project) DO UPDATE SET handle = excluded.handle, seen_at = excluded.seen_at
     WHERE coordinator_presence.seen_at <= excluded.seen_at`,
    [seen.project, seen.handle ?? null, seen.at],
  );
}

/** When the coordinator of a project last read its inbox; null if it never did. */
export async function lastCoordinatorSeen(db: Queryable, project: string): Promise<string | null> {
  const rs = await db.query("SELECT seen_at FROM coordinator_presence WHERE project = $1", [project]);
  return iso(rs.rows[0]?.seen_at);
}

// ------------------------------------------------------------------ runtime handles and profiles

/** Records the profile of the claim now holding a ticket; null forgets the one of an earlier claim. */
export async function saveWorkerProfile(
  db: Queryable,
  w: { project: string; ticket: string; profile: WorkerProfile | null; at: Date },
): Promise<void> {
  const p = w.profile;
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
    `INSERT INTO runtime_handles (project, ticket, runtime, handle, branch, claimed_at, released_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL)
     ON CONFLICT (project, ticket) DO UPDATE SET
       claimed_at = CASE WHEN runtime_handles.handle = excluded.handle AND runtime_handles.released_at IS NULL
                         THEN runtime_handles.claimed_at ELSE excluded.claimed_at END,
       runtime = excluded.runtime, handle = excluded.handle, branch = excluded.branch, released_at = NULL`,
    [h.project, h.ticket, h.runtime, h.handle, h.branch, h.at],
  );
}

/** Marks the session as gone (release or merge) and forgets the profile its claim recorded. */
export async function releaseRuntimeHandle(db: Database, project: string, ticket: string, at: Date): Promise<void> {
  await transaction(db, async (tx) => {
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
  request_question, request_profile`;

const REQUEST_KINDS: readonly string[] = ["answer-request", "launch-request"];

const inboxRow = (r: Row): StoredInboxItem => ({
  id: Number(r.id),
  project: String(r.project),
  ticket: text(r.ticket),
  kind: String(r.kind) as InboxKind,
  recipient: String(r.recipient) as InboxRecipient,
  author: text(r.author),
  body: String(r.body),
  createdAt: isoAt(r.created_at),
  ...(REQUEST_KINDS.includes(String(r.kind))
    ? {
        request: {
          question: r.request_question === null ? null : Number(r.request_question),
          profile: text(r.request_profile),
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
    r.kind === "answer-request"
      ? `AND EXISTS (SELECT 1 FROM inbox_items q WHERE q.project = $1 AND q.id = $7 AND q.kind IN ('question', 'plan')
                     AND q.recipient = 'coordinator' AND q.resolved_at IS NULL)`
      : "";
  const rs = await db.query<{ id: unknown }>(
    `INSERT INTO inbox_items (project, ticket, kind, recipient, author, body, created_at, request_question, request_profile)
     SELECT $1, $2, $3::text, 'coordinator', $4, $5, $6, $7::bigint, $8 WHERE true ${questionOpen}
     ON CONFLICT DO NOTHING RETURNING id`,
    [r.project, r.ticket, r.kind, r.author, r.body, r.at, r.question, r.profile],
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

/** When the newest question or plan of each ticket was resolved, by ticket id. */
export async function lastAnsweredAt(db: Queryable, project: string): Promise<Record<string, string>> {
  const rs = await db.query(
    `SELECT ticket, max(resolved_at) AS at FROM inbox_items
     WHERE project = $1 AND kind IN ('question', 'plan') AND ticket IS NOT NULL AND resolved_at IS NOT NULL
     GROUP BY ticket`,
    [project],
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

// ------------------------------------------------------------------ what the dashboard reads

/** What the Fleet view reads on each poll, and what its requests write. */
export interface LiveStore extends RequestStore {
  listProjects(): Promise<ProjectRecord[]>;
  assignUnownedProjects(organization: string, now: Date): Promise<number>;
  latestEvents(project: string, opts: { since: Date }): Promise<Record<string, LatestEvent>>;
  openRuntimeHandles(project: string): Promise<RuntimeHandle[]>;
  openInboxItems(q: { project: string; recipient: InboxRecipient }): Promise<InboxItem[]>;
  lastCoordinatorSeen(project: string): Promise<string | null>;
}

export const liveStore = (db: Queryable): LiveStore => ({
  listProjects: () => listProjects(db),
  assignUnownedProjects: (organization, now) => assignUnownedProjects(db, organization, now),
  latestEvents: (project, opts) => latestEvents(db, project, opts),
  openRuntimeHandles: (project) => openRuntimeHandles(db, project),
  openInboxItems: (q) => openInboxItems(db, q),
  lastCoordinatorSeen: (project) => lastCoordinatorSeen(db, project),
  getInboxItem: (project, id) => getInboxItem(db, project, id),
  getRuntimeHandle: (project, ticket) => getRuntimeHandle(db, project, ticket),
  addRequest: (r) => addRequest(db, r),
});
