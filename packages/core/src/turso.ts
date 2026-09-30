// Turso (libSQL) adapter: live telemetry and the mailbox of every project of
// one organization. One database is shared by every project, so every row
// carries its project slug and leases are scoped per project. Losing this
// database loses live detail, never progress: Linear stays the record.
import type { Client, InStatement } from "@libsql/client";

export type Db = Client;

/**
 * Each migration is applied once, in order, inside one write transaction.
 * Statements must be idempotent (IF NOT EXISTS, OR IGNORE): two processes may
 * migrate at once, and the second one replays them. Never edit an applied
 * migration; add a new version.
 */
const MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS projects (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repository TEXT NOT NULL,
        program_root TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // kind: claim | report | release (later slices add more).
      `CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        ticket TEXT NOT NULL,
        kind TEXT NOT NULL,
        phase TEXT,
        message TEXT,
        runtime TEXT,
        handle TEXT,
        pr_url TEXT,
        head_sha TEXT,
        created_at TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS events_by_ticket ON events (project, ticket, created_at)",
      // The runtime session holding a ticket, so any later coordinator finds it.
      `CREATE TABLE IF NOT EXISTS runtime_handles (
        project TEXT NOT NULL,
        ticket TEXT NOT NULL,
        runtime TEXT NOT NULL,
        handle TEXT NOT NULL,
        branch TEXT,
        claimed_at TEXT NOT NULL,
        released_at TEXT,
        PRIMARY KEY (project, ticket)
      )`,
      // kind: question | request | hand-back | note; recipient: coordinator | worker.
      `CREATE TABLE IF NOT EXISTS inbox_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        ticket TEXT,
        kind TEXT NOT NULL,
        recipient TEXT NOT NULL,
        author TEXT,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS inbox_open ON inbox_items (project, recipient, resolved_at)",
      `CREATE TABLE IF NOT EXISTS leases (
        project TEXT NOT NULL,
        name TEXT NOT NULL,
        holder TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (project, name)
      )`,
    ],
  },
  {
    // The dashboard reads recent events and the coordinator's last inbox read
    // on every poll; without these, both scan every event of the project.
    version: 2,
    statements: [
      "CREATE INDEX IF NOT EXISTS events_by_time ON events (project, created_at)",
      "CREATE INDEX IF NOT EXISTS events_by_kind ON events (project, kind, created_at)",
    ],
  },
  {
    version: 3,
    statements: [
      // The Conductor profile a claim named (`armada claim --profile`), and how it was chosen.
      `CREATE TABLE IF NOT EXISTS worker_profiles (
        project TEXT NOT NULL,
        ticket TEXT NOT NULL,
        profile TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        fast_mode INTEGER NOT NULL,
        routed TEXT,
        reason TEXT,
        why TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (project, ticket)
      )`,
    ],
  },
  {
    version: 4,
    statements: [
      // What a dashboard request is about: the question an answer-request
      // answers, the profile a launch-request asks for. A table of its own, not
      // new inbox_items columns, so replaying the migration stays idempotent.
      `CREATE TABLE IF NOT EXISTS inbox_requests (
        item INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        question INTEGER,
        profile TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS inbox_requests_by_question ON inbox_requests (project, question)",
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export class TursoError extends Error {
  override name = "TursoError";
}

export interface TursoOptions {
  /** libsql://…, https://… or file:… (a local file for development and tests). */
  url: string;
  /** Required for remote databases; ignored for file: URLs. */
  token?: string | null;
}

/** An error message without the token, even if the URL carried one (`?authToken=`). */
export function redact(err: unknown, token?: string | null): string {
  let message = err instanceof Error ? err.message : String(err);
  if (token) message = message.split(token).join("***");
  return message.replace(/(authToken=)[^&\s"']+/gi, "$1***");
}

/** Opens the database and brings its schema up to date. */
export async function openTurso({ url, token }: TursoOptions): Promise<Db> {
  let db: Db;
  try {
    // Loaded on first use: the client pulls a native module that commands
    // without Turso never need.
    const { createClient } = await import("@libsql/client");
    db = createClient(token ? { url, authToken: token } : { url });
  } catch (err) {
    throw new TursoError(`cannot open the Turso database: ${redact(err, token)}`);
  }
  try {
    await migrate(db);
  } catch (err) {
    db.close();
    throw new TursoError(`Turso database unavailable: ${redact(err, token)}`);
  }
  return db;
}

/**
 * Applies pending migrations and returns the schema version. Safe when several
 * processes migrate at once: statements are idempotent and each version is
 * recorded with INSERT OR IGNORE in the same transaction.
 */
export async function migrate(db: Db): Promise<number> {
  await db.execute(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const current = Number((await db.execute("SELECT max(version) AS v FROM schema_migrations")).rows[0]?.v ?? 0);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const stmts: InStatement[] = [
      ...m.statements,
      {
        sql: "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        args: [m.version, new Date().toISOString()],
      },
    ];
    await db.batch(stmts, "write");
  }
  return Math.max(current, SCHEMA_VERSION);
}

// ------------------------------------------------------------------ projects

export interface ProjectInput {
  slug: string;
  name: string;
  /** owner/name */
  repository: string;
  /** Linear identifier of the program root, e.g. ABC-1. */
  programRoot: string;
}

export interface ProjectRecord extends ProjectInput {
  createdAt: string;
  updatedAt: string;
}

/** Registers a project, or updates its name, repository and root. `created_at` is kept. */
export async function upsertProject(db: Db, p: ProjectInput, now: Date = new Date()): Promise<void> {
  const at = now.toISOString();
  await db.execute({
    sql: `INSERT INTO projects (slug, name, repository, program_root, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (slug) DO UPDATE SET
            name = excluded.name, repository = excluded.repository,
            program_root = excluded.program_root, updated_at = excluded.updated_at
          WHERE name IS NOT excluded.name OR repository IS NOT excluded.repository
             OR program_root IS NOT excluded.program_root`,
    args: [p.slug, p.name, p.repository, p.programRoot, at, at],
  });
}

/** Registers the project only if it is not there yet (claim and report do this). */
export async function ensureProject(db: Db, p: ProjectInput, now: Date = new Date()): Promise<void> {
  const at = now.toISOString();
  await db.execute({
    sql: `INSERT OR IGNORE INTO projects (slug, name, repository, program_root, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [p.slug, p.name, p.repository, p.programRoot, at, at],
  });
}

/** Every registered project, by slug. */
export async function listProjects(db: Db): Promise<ProjectRecord[]> {
  const rs = await db.execute(
    "SELECT slug, name, repository, program_root, created_at, updated_at FROM projects ORDER BY slug",
  );
  return rs.rows.map((r) => ({
    slug: String(r.slug),
    name: String(r.name),
    repository: String(r.repository),
    programRoot: String(r.program_root),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

// ------------------------------------------------------------------ events

/** `inbox`: the coordinator read its inbox; it carries no ticket (see `recordCoordinatorSeen`). */
export type EventKind = "claim" | "report" | "release" | "merge" | "inbox";

/** Ticket value of events that belong to the project rather than to one ticket. */
export const NO_TICKET = "";

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

export async function recordEvent(db: Db, e: EventInput): Promise<void> {
  await db.execute({
    sql: `INSERT INTO events (project, ticket, kind, phase, message, runtime, handle, pr_url, head_sha, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      e.project,
      e.ticket,
      e.kind,
      e.phase ?? null,
      e.message ?? null,
      e.runtime ?? null,
      e.handle ?? null,
      e.prUrl ?? null,
      e.headSha ?? null,
      e.at.toISOString(),
    ],
  });
}

/** Time of the newest event of every ticket of a project (ISO strings, by ticket id). */
export async function lastEventTimes(db: Db, project: string): Promise<Record<string, string>> {
  const rs = await db.execute({
    sql: "SELECT ticket, max(created_at) AS at FROM events WHERE project = ? AND ticket <> '' GROUP BY ticket",
    args: [project],
  });
  return Object.fromEntries(rs.rows.map((r) => [String(r.ticket), String(r.at)]));
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

/**
 * The newest event of every ticket of a project, by ticket id. With `since`,
 * only tickets with an event at or after it: the read stays bounded as the
 * table grows.
 */
export async function latestEvents(
  db: Db,
  project: string,
  opts: { since?: Date } = {},
): Promise<Record<string, LatestEvent>> {
  const rs = await db.execute({
    sql: `SELECT ticket, kind, phase, message, runtime, handle, pr_url, created_at FROM (
            SELECT *, row_number() OVER (PARTITION BY ticket ORDER BY created_at DESC, id DESC) AS n
            FROM events WHERE project = ? AND created_at >= ? AND ticket <> ''
          ) WHERE n = 1`,
    args: [project, opts.since?.toISOString() ?? ""],
  });
  const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return Object.fromEntries(
    rs.rows.map((r) => [
      String(r.ticket),
      {
        kind: String(r.kind) as EventKind,
        phase: text(r.phase),
        message: text(r.message),
        runtime: text(r.runtime),
        handle: text(r.handle),
        prUrl: text(r.pr_url),
        at: String(r.created_at),
      },
    ]),
  );
}

/**
 * Records that the coordinator of a project is at work (it read its inbox).
 * The dashboard shows a coordinator as active from the newest of these.
 */
export async function recordCoordinatorSeen(
  db: Db,
  seen: { project: string; handle?: string | null; at: Date },
): Promise<void> {
  await recordEvent(db, {
    project: seen.project,
    ticket: NO_TICKET,
    kind: "inbox",
    handle: seen.handle ?? null,
    at: seen.at,
  });
}

/** When the coordinator of a project last read its inbox; null if it never did. */
export async function lastCoordinatorSeen(db: Db, project: string): Promise<string | null> {
  const rs = await db.execute({
    sql: "SELECT max(created_at) AS at FROM events WHERE project = ? AND kind = 'inbox'",
    args: [project],
  });
  const at = rs.rows[0]?.at;
  return at === null || at === undefined ? null : String(at);
}

// ------------------------------------------------------------------ runtime handles

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

/** Records the profile of the claim now holding a ticket; null forgets the one of an earlier claim. */
export async function saveWorkerProfile(
  db: Db,
  w: { project: string; ticket: string; profile: WorkerProfile | null; at: Date },
): Promise<void> {
  const p = w.profile;
  if (!p) {
    await db.execute({
      sql: "DELETE FROM worker_profiles WHERE project = ? AND ticket = ?",
      args: [w.project, w.ticket],
    });
    return;
  }
  await db.execute({
    sql: `INSERT OR REPLACE INTO worker_profiles
            (project, ticket, profile, agent, model, effort, fast_mode, routed, reason, why, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      w.project,
      w.ticket,
      p.name,
      p.agent,
      p.model,
      p.effort,
      p.fastMode ? 1 : 0,
      p.routed,
      p.reason,
      p.why,
      w.at.toISOString(),
    ],
  });
}

/** The profile recorded for a ticket's claim, or null. */
export async function getWorkerProfile(db: Db, project: string, ticket: string): Promise<WorkerProfile | null> {
  const rs = await db.execute({
    sql: `SELECT profile, agent, model, effort, fast_mode, routed, reason, why
          FROM worker_profiles WHERE project = ? AND ticket = ?`,
    args: [project, ticket],
  });
  const r = rs.rows[0];
  return r
    ? {
        name: String(r.profile),
        agent: String(r.agent),
        model: String(r.model),
        effort: String(r.effort),
        fastMode: Number(r.fast_mode) === 1,
        routed: r.routed === null ? null : String(r.routed),
        reason: r.reason === null ? null : String(r.reason),
        why: String(r.why),
      }
    : null;
}

/** Records the session now holding a ticket; a new claim replaces a released one. */
export async function saveRuntimeHandle(
  db: Db,
  h: { project: string; ticket: string; runtime: string; handle: string; branch: string | null; at: Date },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO runtime_handles (project, ticket, runtime, handle, branch, claimed_at, released_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT (project, ticket) DO UPDATE SET
            claimed_at = CASE WHEN handle = excluded.handle AND released_at IS NULL
                              THEN claimed_at ELSE excluded.claimed_at END,
            runtime = excluded.runtime, handle = excluded.handle, branch = excluded.branch,
            released_at = NULL`,
    args: [h.project, h.ticket, h.runtime, h.handle, h.branch, h.at.toISOString()],
  });
}

/** Marks the session as gone (release or merge) and forgets the profile its claim recorded. */
export async function releaseRuntimeHandle(db: Db, project: string, ticket: string, at: Date): Promise<void> {
  await db.batch(
    [
      {
        sql: "UPDATE runtime_handles SET released_at = ? WHERE project = ? AND ticket = ? AND released_at IS NULL",
        args: [at.toISOString(), project, ticket],
      },
      { sql: "DELETE FROM worker_profiles WHERE project = ? AND ticket = ?", args: [project, ticket] },
    ],
    "write",
  );
}

/** Sessions still holding a ticket of the project (not released), by ticket id. */
export async function openRuntimeHandles(db: Db, project: string): Promise<RuntimeHandle[]> {
  const rs = await db.execute({
    sql: `SELECT h.project, h.ticket, h.runtime, h.handle, h.branch, h.claimed_at, h.released_at, p.profile
          FROM runtime_handles h
          LEFT JOIN worker_profiles p ON p.project = h.project AND p.ticket = h.ticket
          WHERE h.project = ? AND h.released_at IS NULL ORDER BY h.ticket`,
    args: [project],
  });
  return rs.rows.map((r) => ({
    project: String(r.project),
    ticket: String(r.ticket),
    runtime: String(r.runtime),
    handle: String(r.handle),
    branch: r.branch === null ? null : String(r.branch),
    claimedAt: String(r.claimed_at),
    releasedAt: null,
    profile: r.profile === null ? null : String(r.profile),
  }));
}

export async function getRuntimeHandle(db: Db, project: string, ticket: string): Promise<RuntimeHandle | null> {
  const rs = await db.execute({
    sql: `SELECT h.project, h.ticket, h.runtime, h.handle, h.branch, h.claimed_at, h.released_at, p.profile
          FROM runtime_handles h
          LEFT JOIN worker_profiles p ON p.project = h.project AND p.ticket = h.ticket
          WHERE h.project = ? AND h.ticket = ?`,
    args: [project, ticket],
  });
  const r = rs.rows[0];
  return r
    ? {
        project: String(r.project),
        ticket: String(r.ticket),
        runtime: String(r.runtime),
        handle: String(r.handle),
        branch: r.branch === null ? null : String(r.branch),
        claimedAt: String(r.claimed_at),
        releasedAt: r.released_at === null ? null : String(r.released_at),
        profile: r.profile === null ? null : String(r.profile),
      }
    : null;
}

// ------------------------------------------------------------------ inbox

/**
 * `note`: an unsolicited coordinator message to a worker, stored already resolved as a record.
 * `answer-request` and `launch-request`: the owner's requests from the dashboard, which the
 * coordinator carries out (it delivers the answer, or launches the ticket) and then resolves.
 * `request` is an older generic kind, kept readable.
 */
export type InboxKind = "question" | "request" | "hand-back" | "note" | "answer-request" | "launch-request";
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
  /** Set on dashboard requests: the question an answer-request answers, the profile a launch-request asks for. */
  request?: { question: number | null; profile: string | null };
}

export async function addInboxItem(
  db: Db,
  item: Omit<InboxItem, "id" | "createdAt" | "request"> & { at: Date },
): Promise<number> {
  const rs = await db.execute({
    sql: `INSERT INTO inbox_items (project, ticket, kind, recipient, author, body, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [item.project, item.ticket, item.kind, item.recipient, item.author, item.body, item.at.toISOString()],
  });
  return Number(rs.lastInsertRowid);
}

export interface NewRequest {
  project: string;
  ticket: string;
  kind: RequestKind;
  author: string;
  body: string;
  /** answer-request: the question item it answers. */
  question: number | null;
  /** launch-request: the profile asked for. */
  profile: string | null;
  at: Date;
}

/**
 * Adds a dashboard request for the coordinator, in one write: nothing is added
 * when the same request is already open (an answer to that question, a launch
 * of that ticket) or when the question it answers is no longer open. Returns
 * the new item id, or null when nothing was added.
 */
export async function addRequest(db: Db, r: NewRequest): Promise<number | null> {
  const open = "i.project = ? AND i.kind = ? AND i.resolved_at IS NULL";
  const guard =
    r.kind === "answer-request"
      ? {
          sql: `NOT EXISTS (SELECT 1 FROM inbox_items i JOIN inbox_requests q ON q.item = i.id
                            WHERE ${open} AND q.question = ?)
                AND EXISTS (SELECT 1 FROM inbox_items i
                            WHERE i.project = ? AND i.id = ? AND i.kind = 'question' AND i.resolved_at IS NULL)`,
          args: [r.project, r.kind, r.question, r.project, r.question],
        }
      : {
          sql: `NOT EXISTS (SELECT 1 FROM inbox_items i WHERE ${open} AND i.ticket = ?)`,
          args: [r.project, r.kind, r.ticket],
        };
  const [added] = await db.batch(
    [
      {
        sql: `INSERT INTO inbox_items (project, ticket, kind, recipient, author, body, created_at)
              SELECT ?, ?, ?, 'coordinator', ?, ?, ? WHERE ${guard.sql}`,
        args: [r.project, r.ticket, r.kind, r.author, r.body, r.at.toISOString(), ...guard.args],
      },
      // changes() is the row count of the insert above: no row, no detail.
      {
        sql: `INSERT INTO inbox_requests (item, project, question, profile)
              SELECT last_insert_rowid(), ?, ?, ? WHERE changes() = 1`,
        args: [r.project, r.question, r.profile],
      },
    ],
    "write",
  );
  return added?.rowsAffected ? Number(added.lastInsertRowid) : null;
}

/** Adds the coordinator's hand-back item for a ticket, or refreshes the unresolved one. */
export async function putHandBack(
  db: Db,
  item: { project: string; ticket: string; author: string | null; body: string; at: Date },
): Promise<void> {
  const updated = await db.execute({
    sql: `UPDATE inbox_items SET body = ?, author = ?, created_at = ?
          WHERE project = ? AND ticket = ? AND kind = 'hand-back' AND resolved_at IS NULL`,
    args: [item.body, item.author, item.at.toISOString(), item.project, item.ticket],
  });
  if (!updated.rowsAffected) await addInboxItem(db, { ...item, kind: "hand-back", recipient: "coordinator" });
}

const INBOX_COLUMNS = `i.id, i.project, i.ticket, i.kind, i.recipient, i.author, i.body, i.created_at,
  i.resolved_at, i.resolution, q.item AS request_item, q.question AS request_question, q.profile AS request_profile`;
const INBOX_FROM = "inbox_items i LEFT JOIN inbox_requests q ON q.item = i.id";

const inboxItem = (r: Record<string, unknown>): InboxItem => ({
  id: Number(r.id),
  project: String(r.project),
  ticket: r.ticket === null ? null : String(r.ticket),
  kind: String(r.kind) as InboxKind,
  recipient: String(r.recipient) as InboxRecipient,
  author: r.author === null ? null : String(r.author),
  body: String(r.body),
  createdAt: String(r.created_at),
  ...(r.request_item === null || r.request_item === undefined
    ? {}
    : {
        request: {
          question: r.request_question === null ? null : Number(r.request_question),
          profile: r.request_profile === null ? null : String(r.request_profile),
        },
      }),
});

/** Unresolved items of a project for one recipient, optionally for one ticket, oldest first. */
export async function openInboxItems(
  db: Db,
  q: { project: string; recipient: InboxRecipient; ticket?: string },
): Promise<InboxItem[]> {
  const rs = await db.execute({
    sql: `SELECT ${INBOX_COLUMNS} FROM ${INBOX_FROM}
          WHERE i.project = ? AND i.recipient = ? AND i.resolved_at IS NULL ${q.ticket ? "AND i.ticket = ?" : ""}
          ORDER BY i.created_at, i.id`,
    args: q.ticket ? [q.project, q.recipient, q.ticket] : [q.project, q.recipient],
  });
  return rs.rows.map(inboxItem);
}

/** An inbox item with its resolution: when it was resolved, and the answer or reason. */
export interface StoredInboxItem extends InboxItem {
  resolvedAt: string | null;
  resolution: string | null;
}

const inboxRow = (r: Record<string, unknown>): StoredInboxItem => ({
  ...inboxItem(r),
  resolvedAt: r.resolved_at === null ? null : String(r.resolved_at),
  resolution: r.resolution === null ? null : String(r.resolution),
});

/** One inbox item of a project, open or resolved; null when the project has no such item. */
export async function getInboxItem(db: Db, project: string, id: number): Promise<StoredInboxItem | null> {
  const rs = await db.execute({
    sql: `SELECT ${INBOX_COLUMNS} FROM ${INBOX_FROM} WHERE i.project = ? AND i.id = ?`,
    args: [project, id],
  });
  const r = rs.rows[0];
  return r ? inboxRow(r) : null;
}

/** Resolves one open item; false when it was already resolved. */
export async function resolveInboxItem(
  db: Db,
  q: { project: string; id: number; resolution: string; at: Date },
): Promise<boolean> {
  const rs = await db.execute({
    sql: "UPDATE inbox_items SET resolved_at = ?, resolution = ? WHERE project = ? AND id = ? AND resolved_at IS NULL",
    args: [q.at.toISOString(), q.resolution, q.project, q.id],
  });
  return rs.rowsAffected > 0;
}

/** When the newest question of each ticket was resolved, by ticket id (answered, released or merged). */
export async function lastAnsweredAt(db: Db, project: string): Promise<Record<string, string>> {
  const rs = await db.execute({
    sql: `SELECT ticket, max(resolved_at) AS at FROM inbox_items
          WHERE project = ? AND kind = 'question' AND ticket IS NOT NULL AND resolved_at IS NOT NULL
          GROUP BY ticket`,
    args: [project],
  });
  return Object.fromEntries(rs.rows.map((r) => [String(r.ticket), String(r.at)]));
}

/** Resolves the open items of one kind for a ticket (e.g. its hand-back once merged); returns how many. */
export async function resolveInboxItems(
  db: Db,
  q: { project: string; ticket: string; kind: InboxKind; resolution: string; at: Date },
): Promise<number> {
  const rs = await db.execute({
    sql: `UPDATE inbox_items SET resolved_at = ?, resolution = ?
          WHERE project = ? AND ticket = ? AND kind = ? AND resolved_at IS NULL`,
    args: [q.at.toISOString(), q.resolution, q.project, q.ticket, q.kind],
  });
  return rs.rowsAffected;
}

/** Resolves the open answer-requests for one question (the question was answered or closed); returns how many. */
export async function resolveAnswerRequests(
  db: Db,
  q: { project: string; question: number; resolution: string; at: Date },
): Promise<number> {
  const rs = await db.execute({
    sql: `UPDATE inbox_items SET resolved_at = ?, resolution = ?
          WHERE project = ? AND kind = 'answer-request' AND resolved_at IS NULL
            AND id IN (SELECT item FROM inbox_requests WHERE project = ? AND question = ?)`,
    args: [q.at.toISOString(), q.resolution, q.project, q.project, q.question],
  });
  return rs.rowsAffected;
}

// ------------------------------------------------------------------ leases

export interface Lease {
  project: string;
  name: string;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
}

/**
 * Takes the lease `name` of a project for `ttlMs`, in one statement: the row
 * is written only when the lease is free, expired, or already ours (which
 * renews it). When refused, `held` is the lease that keeps it.
 */
export async function acquireLease(
  db: Db,
  l: { project: string; name: string; holder: string; ttlMs: number; at: Date },
): Promise<{ acquired: true } | { acquired: false; held: Lease | null }> {
  const at = l.at.toISOString();
  const expires = new Date(l.at.getTime() + l.ttlMs).toISOString();
  const rs = await db.execute({
    sql: `INSERT INTO leases (project, name, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (project, name) DO UPDATE SET
            acquired_at = CASE WHEN leases.holder = excluded.holder THEN leases.acquired_at ELSE excluded.acquired_at END,
            holder = excluded.holder, expires_at = excluded.expires_at
          WHERE leases.holder = excluded.holder OR leases.expires_at <= ?`,
    args: [l.project, l.name, l.holder, at, expires, at],
  });
  if (rs.rowsAffected) return { acquired: true };
  return { acquired: false, held: await getLease(db, l.project, l.name) };
}

export async function getLease(db: Db, project: string, name: string): Promise<Lease | null> {
  const rs = await db.execute({
    sql: "SELECT project, name, holder, acquired_at, expires_at FROM leases WHERE project = ? AND name = ?",
    args: [project, name],
  });
  const r = rs.rows[0];
  return r
    ? {
        project: String(r.project),
        name: String(r.name),
        holder: String(r.holder),
        acquiredAt: String(r.acquired_at),
        expiresAt: String(r.expires_at),
      }
    : null;
}

/** Extends a lease we hold; false when it expired and someone else took it. */
export async function renewLease(
  db: Db,
  l: { project: string; name: string; holder: string; ttlMs: number; at: Date },
): Promise<boolean> {
  const rs = await db.execute({
    sql: "UPDATE leases SET expires_at = ? WHERE project = ? AND name = ? AND holder = ?",
    args: [new Date(l.at.getTime() + l.ttlMs).toISOString(), l.project, l.name, l.holder],
  });
  return rs.rowsAffected > 0;
}

/** Gives a lease back; a lease someone else took after ours expired is left alone. */
export async function releaseLease(db: Db, l: { project: string; name: string; holder: string }): Promise<void> {
  await db.execute({
    sql: "DELETE FROM leases WHERE project = ? AND name = ? AND holder = ?",
    args: [l.project, l.name, l.holder],
  });
}
