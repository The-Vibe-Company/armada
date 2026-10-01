// The app's database for tests: Postgres in the process (PGlite), migrated,
// one per test file. No network, no server.
import { type Database, migrateDatabase, pgliteDatabase } from "../lib/db.ts";

export async function tempDatabase(): Promise<Database> {
  const db = await pgliteDatabase();
  await migrateDatabase(db);
  return db;
}

/** One number from a query, e.g. a count. */
export async function scalar(db: Database, sql: string, params: unknown[] = []): Promise<number> {
  const rs = await db.query<Record<string, unknown>>(sql, params);
  return Number(Object.values(rs.rows[0] ?? {})[0] ?? 0);
}

/** Organizations the fleet's rows may name, as Better Auth would have made them. */
export async function addOrganizations(db: Database, ...ids: string[]): Promise<void> {
  for (const id of ids)
    await db.query(
      `INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ($1, $1, $1, now()) ON CONFLICT DO NOTHING`,
      [id],
    );
}
