import { afterAll, beforeAll } from "bun:test";
import { openMigratedDatabase, resetMigratedDatabaseRows } from "../../../scripts/test-support/migrated-database.ts";
import { seedDatabase } from "./support.ts";

/**
 * One database per serial, row-only suite. Do not use for schema/role/settings
 * mutations or overlapping fixtures. Drain async work before the next call.
 * Reset per fixture, not per test: a single test can build several fixtures.
 */
export function rowOnlyDatabase() {
  const connection = rowOnlyConnection();
  return async () => seedDatabase(await connection());
}

/**
 * One raw database connection per serial row-only suite. Callers own fixture
 * seeding; this helper only resets rows before each fixture and closes the
 * connection from the suite's afterAll hook. The same no-schema/settings-mutation
 * and no-overlapping-fixture restrictions apply.
 */
export function rowOnlyConnection() {
  let db: Awaited<ReturnType<typeof openMigratedDatabase>>;
  let reset: string;
  beforeAll(async () => {
    db = await openMigratedDatabase();
    const tables = await db.query<{ name: string }>(
      "select format('%I.%I', schemaname, tablename) as name from pg_tables where schemaname in ('public', 'auth')",
    );
    reset = `truncate table ${tables.rows.map((row) => row.name).join(", ")} restart identity cascade`;
  });
  afterAll(async () => {
    await db?.close();
  });
  return async () => {
    await resetMigratedDatabaseRows(db, reset);
    return db;
  };
}
