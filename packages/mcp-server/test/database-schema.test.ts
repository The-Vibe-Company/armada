import { expect, test } from "bun:test";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { createDatabaseReadiness } from "../src/database-readiness.ts";
import { requireDatabaseSchema } from "../src/database-schema.ts";
import { REQUIRED_MIGRATION } from "../src/required-migration.ts";

test("schema readiness rejects missing, empty and behind history, accepting current and newer databases", async () => {
  const db = await openDatabase();
  try {
    // A reachable database without Supabase history must not be considered ready.
    expect(await createDatabaseReadiness(db)()).toBe(false);
    await db.exec(
      "create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key)",
    );
    expect(await createDatabaseReadiness(db)()).toBe(false);
    await db.query("insert into supabase_migrations.schema_migrations values ($1)", ["20000101000000"]);
    await expect(requireDatabaseSchema(db)).rejects.toThrow("Database schema behind running code");
    expect(await createDatabaseReadiness(db)()).toBe(false);
    await db.query("insert into supabase_migrations.schema_migrations values ($1)", [REQUIRED_MIGRATION]);
    expect(await createDatabaseReadiness(db)()).toBe(true);
    await db.query("insert into supabase_migrations.schema_migrations values ($1)", ["99991231235959"]);
    expect(await createDatabaseReadiness(db)()).toBe(true);
  } finally {
    await db.close();
  }
});

test("the fixture migration runner records successfully applied versions like Supabase", async () => {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    await expect(requireDatabaseSchema(db)).resolves.toBeUndefined();
  } finally {
    await db.close();
  }
});
