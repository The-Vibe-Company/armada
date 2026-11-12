import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = fileURLToPath(new URL("../..", import.meta.url));

export const migrationsDir = join(root, "supabase", "migrations");
const prereqPath = fileURLToPath(new URL("./supabase-prereq.sql", import.meta.url));

/** A fresh in-memory Postgres with the Supabase prerequisites, and no Armada tables yet. */
export async function openDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.waitReady;
  return db;
}

/** Applies the Supabase prerequisites and every migration, in filename order. */
export async function applyMigrations(db: PGlite): Promise<string[]> {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error("no migrations in supabase/migrations");
  await execFile(db, prereqPath, "supabase prerequisites");
  for (const file of files) {
    await execFile(db, join(migrationsDir, file), file);
  }
  await db.exec("create schema if not exists supabase_migrations");
  await db.exec("create table if not exists supabase_migrations.schema_migrations (version text primary key)");
  for (const file of files) {
    await db.query("insert into supabase_migrations.schema_migrations(version) values ($1)", [file.slice(0, 14)]);
  }
  return files;
}

async function execFile(db: PGlite, path: string, name: string): Promise<void> {
  const sql = await Bun.file(path).text();
  try {
    await db.exec(sql);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} failed: ${detail}`, { cause: error });
  }
}
