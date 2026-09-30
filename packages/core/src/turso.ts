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
      // kind: question | request | hand-back; recipient: coordinator | worker.
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

export type EventKind = "claim" | "report" | "release";

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
    sql: "SELECT ticket, max(created_at) AS at FROM events WHERE project = ? GROUP BY ticket",
    args: [project],
  });
  return Object.fromEntries(rs.rows.map((r) => [String(r.ticket), String(r.at)]));
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

export async function releaseRuntimeHandle(db: Db, project: string, ticket: string, at: Date): Promise<void> {
  await db.execute({
    sql: "UPDATE runtime_handles SET released_at = ? WHERE project = ? AND ticket = ? AND released_at IS NULL",
    args: [at.toISOString(), project, ticket],
  });
}

export async function getRuntimeHandle(db: Db, project: string, ticket: string): Promise<RuntimeHandle | null> {
  const rs = await db.execute({
    sql: `SELECT project, ticket, runtime, handle, branch, claimed_at, released_at
          FROM runtime_handles WHERE project = ? AND ticket = ?`,
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
      }
    : null;
}

// ------------------------------------------------------------------ inbox

export type InboxKind = "question" | "request" | "hand-back";
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
}

export async function addInboxItem(db: Db, item: Omit<InboxItem, "id" | "createdAt"> & { at: Date }): Promise<number> {
  const rs = await db.execute({
    sql: `INSERT INTO inbox_items (project, ticket, kind, recipient, author, body, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [item.project, item.ticket, item.kind, item.recipient, item.author, item.body, item.at.toISOString()],
  });
  return Number(rs.lastInsertRowid);
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

/** Unresolved items of a project for one recipient, optionally for one ticket, oldest first. */
export async function openInboxItems(
  db: Db,
  q: { project: string; recipient: InboxRecipient; ticket?: string },
): Promise<InboxItem[]> {
  const rs = await db.execute({
    sql: `SELECT id, project, ticket, kind, recipient, author, body, created_at FROM inbox_items
          WHERE project = ? AND recipient = ? AND resolved_at IS NULL ${q.ticket ? "AND ticket = ?" : ""}
          ORDER BY created_at, id`,
    args: q.ticket ? [q.project, q.recipient, q.ticket] : [q.project, q.recipient],
  });
  return rs.rows.map((r) => ({
    id: Number(r.id),
    project: String(r.project),
    ticket: r.ticket === null ? null : String(r.ticket),
    kind: String(r.kind) as InboxKind,
    recipient: String(r.recipient) as InboxRecipient,
    author: r.author === null ? null : String(r.author),
    body: String(r.body),
    createdAt: String(r.created_at),
  }));
}
