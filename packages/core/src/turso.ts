// Turso (libSQL) adapter: live telemetry and the mailbox of every project of
// one organization. One database is shared by every project, so every row
// carries its project slug and leases are scoped per project. Losing this
// database loses live detail, never progress: Linear stays the record.
import { type Client, createClient, type InStatement } from "@libsql/client";

export type Db = Client;

/** Each migration is applied once, in order, inside one write transaction. */
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

/** Opens the database and brings its schema up to date. */
export async function openTurso({ url, token }: TursoOptions): Promise<Db> {
  let db: Db;
  try {
    db = createClient(token ? { url, authToken: token } : { url });
  } catch (err) {
    // The message may quote the URL, never the token.
    throw new TursoError(`cannot open the Turso database: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await migrate(db);
  } catch (err) {
    db.close();
    throw new TursoError(`Turso database unavailable: ${err instanceof Error ? err.message : String(err)}`);
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
