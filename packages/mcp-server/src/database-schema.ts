import type { Sql } from "@armada/core";
import { REQUIRED_MIGRATION } from "./required-migration.ts";

/** Read only Supabase's version index, not application tables or migration SQL. */
export async function requireDatabaseSchema(sql: Sql): Promise<void> {
  const { rows } = await sql.query<{ version: string | null }>(
    "select max(version) as version from supabase_migrations.schema_migrations",
  );
  const applied = rows[0]?.version;
  if (typeof applied !== "string" || !/^\d{14}$/.test(applied) || applied < REQUIRED_MIGRATION) {
    // Never include driver text, connection details, or unvalidated database values.
    throw new Error(`Database schema behind running code; requires migration ${REQUIRED_MIGRATION}.`);
  }
}
