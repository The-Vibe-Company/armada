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
