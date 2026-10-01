// The app's database for tests: Postgres in the process (PGlite), migrated,
// one per test file. No network, no server.
//
// ARMADA_TEST_DATABASE_URL (a direct, not pooled, Postgres URL: a Neon branch
// made for it, never production) runs the same tests on real Postgres
// instead, each database in a schema of its own, dropped at the end.
import { randomBytes } from "node:crypto";
import { type Database, migrateDatabase, openDatabase, pgliteDatabase } from "../lib/db.ts";

export async function tempDatabase(): Promise<Database> {
  const real = process.env.ARMADA_TEST_DATABASE_URL;
  if (!real) {
    const db = await pgliteDatabase();
    await migrateDatabase(db);
    return db;
  }
  const schema = `armada_test_${randomBytes(6).toString("hex")}`;
  const url = new URL(real);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const admin = await openDatabase(real, { migrate: false });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const db = await openDatabase(url.toString());
  return {
    ...db,
    async end() {
      await db.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
      await db.end();
    },
  };
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
