import type { ApplicationVault, Sql } from "@armada/core/server";
import type { JobResult } from "./jobs/runner.ts";
import type { createJobsStore } from "./jobs/store.ts";
import { pruneResourceObservations } from "./resource-store.ts";

const INTERVAL_MS = 10 * 60_000;

// This service-wide job has no owning organization or sandbox.
export function seedRetentionMaintenance(jobs: Pick<ReturnType<typeof createJobsStore>, "enqueue">) {
  return jobs.enqueue("maintenance", null, null, "server-retention", null, {
    orgId: "00000000-0000-0000-0000-000000000000",
    maxAttempts: 1,
  });
}

export function retentionMaintenanceJob(
  sql: Sql,
  vault: Pick<ApplicationVault, "purgeExpired"> | undefined,
  log: (line: string) => void = console.error,
  now = () => new Date(),
) {
  return {
    concurrency: 1,
    async run(): Promise<JobResult> {
      const cutoff = now();
      const results = await Promise.allSettled([
        Promise.resolve().then(() => vault?.purgeExpired()),
        Promise.resolve().then(() => pruneResourceObservations(sql, cutoff)),
      ]);
      if (results.some((result) => result.status === "rejected"))
        log("armada: retention maintenance unavailable; retrying.");

      return { status: "reschedule", after: new Date(now().getTime() + INTERVAL_MS) };
    },
  };
}
