import type { GoldenBuildJobs } from "@armada/core/server";
import type { JobKind } from "./jobs/runner.ts";
import type { ServerModule } from "./server-registration.ts";
import type { ServerLifecycleLane } from "./server-workers.ts";

export function createGoldenRecoveryLane(
  jobs: Pick<GoldenBuildJobs, "expireRunningReceipts" | "reconcileOne">,
  log: (line: string) => void = console.error,
) {
  return {
    isolatedSweep: true,
    async reconcileOne(signal) {
      try {
        await jobs.expireRunningReceipts();
        if (!signal.aborted) await jobs.reconcileOne();
      } catch {
        // SQL and provider errors can carry credentials.
        log("armada: golden worker tick unavailable; durable jobs remain fenced.");
      }
      return false;
    },
    async drain() {},
  } satisfies ServerLifecycleLane;
}

export const goldenBuildModule: ServerModule = ({ workers }) => {
  workers.isolated.set("golden-build-recovery", ({ goldenBuilds, options }) =>
    createGoldenRecoveryLane(goldenBuilds, options.logError),
  );
};

export function createGoldenBuildJob(builds: Pick<GoldenBuildJobs, "dispatchReceipt">, now = Date.now) {
  return {
    concurrency: 1,
    async run(job, { signal }) {
      signal.throwIfAborted();
      const { pending } = await builds.dispatchReceipt(job.id, job.lease_epoch);
      return pending ? { status: "retry", after: new Date(now() + 60_000) } : { status: "done" };
    },
  } satisfies JobKind;
}
