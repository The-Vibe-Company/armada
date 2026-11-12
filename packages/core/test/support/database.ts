import { afterAll, beforeAll, beforeEach } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../../../../scripts/db/apply.ts";

/**
 * One real migrated database per serial test file, with empty application rows
 * before each case. Use only for row-mutating tests: schema, roles, settings and
 * migration tests still need their own database. Native transactions stay real.
 */
export function migratedDatabase(): () => PGlite {
  let db: PGlite | undefined;
  let reset: string;
  beforeAll(async () => {
    db = await openDatabase();
    await applyMigrations(db);
    const tables = await db.query<{ name: string }>(
      `select format('%I.%I', schemaname, tablename) as name
       from pg_tables where schemaname in ('public', 'auth')`,
    );
    reset = `truncate table ${tables.rows.map((row) => row.name).join(", ")} restart identity cascade`;
  });
  beforeEach(async () => {
    // This disposable fixture is the database owner, not an application writer.
    // Temporarily allow its whole-database reset, then restore journal protection
    // atomically before any test can run. UPDATE/DELETE guards remain enabled.
    await db!.transaction(async (tx) => {
      await tx.exec("alter table public.otto_facts disable trigger otto_facts_no_truncate");
      await tx.exec(reset);
      await tx.exec("alter table public.otto_facts enable trigger otto_facts_no_truncate");
    });
  });
  afterAll(async () => {
    await db?.close();
  });
  return () => {
    if (!db) throw new Error("Database requested before beforeAll");
    return db;
  };
}
