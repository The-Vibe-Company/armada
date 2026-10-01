// The app's database for this server process: opened once (schema brought up
// to date on the way), kept across requests and hot reloads, opened again if
// its URL changes. A failed open is retried on the next request.
import "server-only";
import { type Database, databaseUrlOf, openDatabase } from "./db";

const holder = globalThis as unknown as { __armadaDatabase?: { url: string; opening: Promise<Database> } };

/** The database ARMADA_DATABASE_URL names; null when none is set. Throws when it cannot be opened. */
export async function appDatabase(): Promise<Database | null> {
  const url = databaseUrlOf(process.env);
  if (!url) return null;
  if (holder.__armadaDatabase?.url !== url) {
    const previous = holder.__armadaDatabase?.opening;
    const opening = openDatabase(url);
    opening.catch(() => {
      if (holder.__armadaDatabase?.opening === opening) holder.__armadaDatabase = undefined;
    });
    holder.__armadaDatabase = { url, opening };
    previous?.then((db) => db.end()).catch(() => {});
  }
  return holder.__armadaDatabase.opening;
}
