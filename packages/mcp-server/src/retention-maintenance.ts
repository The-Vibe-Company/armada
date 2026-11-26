import type { ApplicationVault, Sql } from "@armada/core/server";
import type { Job, JobResult } from "./jobs/runner.ts";
import { type createJobsStore, rescheduleRecurringJob } from "./jobs/store.ts";
import { pruneMcpInvalidations } from "./mcp-http-integration.ts";
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
    async run(job: Job): Promise<JobResult> {
      const cutoff = now();
      const results = await Promise.allSettled([
        Promise.resolve().then(() => vault?.purgeExpired()),
        Promise.resolve().then(() => pruneResourceObservations(sql, cutoff)),
        Promise.resolve().then(() => pruneMcpInvalidations(sql, cutoff)),
      ]);
      if (results.some((result) => result.status === "rejected"))
        log("armada: retention maintenance unavailable; retrying.");

      const after = new Date(now().getTime() + INTERVAL_MS);
      return { status: "retry", after, commit: (tx) => rescheduleRecurringJob(tx, job, after) };
    },
  };
}
