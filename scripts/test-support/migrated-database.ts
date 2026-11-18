import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../db/apply.ts";

export const MIGRATED_DATABASE_TEMPLATE_ENV = "ARMADA_TEST_MIGRATED_DATABASE_TEMPLATE";

let template: Promise<Blob> | undefined;

export async function migratedTemplate(): Promise<Blob> {
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
  const sharedPath = process.env[MIGRATED_DATABASE_TEMPLATE_ENV];
  template ??= sharedPath ? Promise.resolve(Bun.file(sharedPath)) : migratedTemplate();
  const db = new PGlite({ loadDataDir: await template });
  try {
    await db.waitReady;
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

/** Reset disposable fixture rows atomically. */
export async function resetMigratedDatabaseRows(db: PGlite, reset: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.exec(reset);
  });
}
