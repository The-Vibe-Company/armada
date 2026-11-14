import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../db/apply.ts";

let template: Promise<Blob> | undefined;

async function migratedTemplate(): Promise<Blob> {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    // Match PGlite.clone(): in-process templates need no gzip/stream decompression.
    return await db.dumpDataDir("none");
  } finally {
    await db.close();
  }
}

/** Share only immutable schema bytes within this worker, never a live connection or test data. */
export async function openMigratedDatabase(): Promise<PGlite> {
  template ??= migratedTemplate();
  const db = new PGlite({ loadDataDir: await template });
  try {
    await db.waitReady;
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

/** Owner-only maintenance of a disposable fixture; all guards return before a test runs. */
export async function resetMigratedDatabaseRows(db: PGlite, reset: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Preserve UPDATE/DELETE enforcement, and atomically restore TRUNCATE enforcement.

    const guards = await tx.query<{ schema: string; table: string; trigger: string }>(
      "select n.nspname as schema, c.relname as table, t.tgname as trigger from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and (t.tgtype & 32) <> 0 and n.nspname='public'",
    );
    const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
    for (const guard of guards.rows) {
      await tx.exec(`alter table ${quote(guard.schema)}.${quote(guard.table)} disable trigger ${quote(guard.trigger)}`);
    }
    await tx.exec(reset);
    for (const guard of guards.rows) {
      await tx.exec(`alter table ${quote(guard.schema)}.${quote(guard.table)} enable trigger ${quote(guard.trigger)}`);
    }
  });
}
