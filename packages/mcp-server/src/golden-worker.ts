import { setTimeout as delay } from "node:timers/promises";
import type { GoldenBuildJobs } from "@armada/core/server";

/** Owns the awaited worker loop for the lifetime of armada-server, never an HTTP request. */
export function startGoldenWorker(jobs: GoldenBuildJobs) {
  const controller = new AbortController();
  const done = (async () => {
    while (!controller.signal.aborted) {
      try {
        await jobs.reconcileOne();
        if (!controller.signal.aborted && (await jobs.runOne())) continue;
      } catch {
        // Database/provider exceptions may contain credentials. Log only a fixed code.
        console.error(JSON.stringify({ event: "golden_worker_failed", code: "unavailable" }));
      }
      try {
        await delay(1000, undefined, { signal: controller.signal });
      } catch {
        break;
      }
    }
  })();
  return {
    /** Stops claiming immediately; an active build drains or is fenced after process termination. */
    stop: () => {
      controller.abort();
    },
    done,
  };
}
