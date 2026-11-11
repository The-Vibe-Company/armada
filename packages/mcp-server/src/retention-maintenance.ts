import type { ApplicationVault, Sql } from "@armada/core/server";
import { pruneResourceObservations } from "./resource-store.ts";

/** Independent retention domains must all run, even when another store is unavailable. */
export async function pruneServerRetention(
  sql: Sql,
  vault: Pick<ApplicationVault, "purgeExpired"> | undefined,
  now: Date,
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => vault?.purgeExpired()),
    Promise.resolve().then(() => pruneResourceObservations(sql, now)),
  ]);
  // Preserve retry/failure reporting without propagating database text or secret-bearing causes.
  if (results.some((result) => result.status === "rejected"))
    throw new Error("Server retention maintenance unavailable.");
}
