import type { GoldenBuildJobs } from "@armada/core/server";
import type { ServerModule } from "./server-registration.ts";
import type { ServerLifecycleLane } from "./server-workers.ts";

export function createGoldenBuildLane(
  jobs: Pick<GoldenBuildJobs, "runOne" | "reconcileOne">,
  log: (line: string) => void = console.error,
) {
  return {
    isolatedSweep: true,
    async reconcileOne(signal) {
      try {
        if (await jobs.runOne()) return true;
        if (!signal.aborted) await jobs.reconcileOne();
      } catch {
        // SQL and provider errors can carry credentials.
        log("armada: golden worker tick unavailable; durable jobs remain fenced.");
      }
      return false;
    },
    // The scheduler already awaits the full tick, including an active build.
    async drain() {},
  } satisfies ServerLifecycleLane;
}

export const goldenBuildModule: ServerModule = ({ workers }) => {
  workers.isolated.set("golden-builds", ({ goldenBuilds, options }) =>
    createGoldenBuildLane(goldenBuilds, options.logError),
  );
};
