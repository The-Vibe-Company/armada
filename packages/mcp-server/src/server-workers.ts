import type { GoldenBuildJobs } from "@armada/core/server";
import { startGoldenWorker } from "./golden-worker.ts";

import type { OrchestratorWorkerLane } from "./orchestrator-composition.ts";

/** Independent tracked lanes: a golden build can legitimately take an hour. */
export function startServerWorkers(
  goldens: Pick<GoldenBuildJobs, "runOne" | "reconcileOne">,
  lifecycle: {
    reconcileOne(signal: AbortSignal): Promise<boolean>;
    drain(): Promise<void>;
  },
  log: (line: string) => void = console.error,
  orchestrators?: OrchestratorWorkerLane,
) {
  const goldenWorker = startGoldenWorker(goldens, log);
  const shutdown = new AbortController();
  const lanes = [lifecycle, ...(orchestrators ? [orchestrators] : [])];
  let nextLane = 0;
  let wake: (() => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const lifecycleDone = (async () => {
    while (!shutdown.signal.aborted) {
      const item = new AbortController();
      const timeout = setTimeout(() => item.abort(), 30_000);
      timeout.unref();
      try {
        // Drain a ready backlog without waiting for another build or an idle tick.
        let worked = false;
        const start = nextLane;
        for (let n = 0; n < lanes.length; n++) {
          const index = (start + n) % lanes.length;
          nextLane = (index + 1) % lanes.length;
          const lane = lanes[index];
          if (lane && (await lane.reconcileOne(AbortSignal.any([shutdown.signal, item.signal])))) {
            nextLane = (index + 1) % lanes.length;
            worked = true;
            break;
          }
        }
        if (worked) continue;
      } catch {
        log("armada: sandbox lifecycle tick unavailable; durable leases remain fenced.");
      } finally {
        clearTimeout(timeout);
      }
      if (!shutdown.signal.aborted)
        await new Promise<void>((resolve) => {
          wake = resolve;
          idleTimer = setTimeout(resolve, 1000);
          idleTimer.unref();
        });
    }
    // SDKs may not support cancellation after a request has reached the provider. Keep
    // those operations tracked through shutdown; cancellation forbids subsequent actions.
    await Promise.all(lanes.map((lane) => lane.drain()));
  })();
  const done = Promise.all([goldenWorker.done, lifecycleDone]).then(() => {});
  return {
    goldenWorker,
    lifecycleWorker: { done: lifecycleDone },
    done,
    stop() {
      goldenWorker.stop();
      shutdown.abort();
      if (idleTimer) clearTimeout(idleTimer);
      wake?.();
    },
  };
}
