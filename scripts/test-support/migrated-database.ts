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
    await tx.exec("alter table public.otto_facts disable trigger otto_facts_no_truncate");
    await tx.exec(reset);
    await tx.exec("alter table public.otto_facts enable trigger otto_facts_no_truncate");
  });
}
