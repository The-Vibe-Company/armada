import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";

// Process-local and lazy: every new test process builds from the current migrations.
// Cache bytes, never a live database: callers own independent state and close normally.
let pristineImage: Promise<Blob> | undefined;

async function buildImage(): Promise<Blob> {
  const db = await openDatabase();
  try {
    await applyMigrations(db);
    return await db.dumpDataDir("none");
  } finally {
    await db.close();
  }
}

export async function migratedDatabase(): Promise<PGlite> {
  pristineImage ??= buildImage();
  return PGlite.create({ loadDataDir: await pristineImage });
}
