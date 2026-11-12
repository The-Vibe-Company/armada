import { afterAll, beforeAll } from "bun:test";
import { openMigratedDatabase } from "../../../scripts/test-support/migrated-database.ts";
import { seedDatabase } from "./support.ts";

/**
 * One database per serial, row-only suite. Do not use for schema/role/settings
 * mutations or overlapping fixtures. Drain async work before the next call.
 * Reset per fixture, not per test: a single test can build several fixtures.
 */
export function rowOnlyDatabase() {
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
    await db.exec(reset);
    return seedDatabase(db);
  };
}
