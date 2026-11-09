import type { GoldenBuildJobs } from "@armada/core/server";
import { startGoldenWorker } from "./golden-worker.ts";

/** Independent tracked lanes: a golden build can legitimately take an hour. */
export function startServerWorkers(
  goldens: Pick<GoldenBuildJobs, "runOne" | "reconcileOne">,
  lifecycle: {
    reconcileOne(signal: AbortSignal): Promise<boolean>;
    drain(): Promise<void>;
  },
  log: (line: string) => void = console.error,
  maintenance?: () => Promise<void>,
) {
  const goldenWorker = startGoldenWorker(goldens, log);
  const shutdown = new AbortController();
  let wake: (() => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const lifecycleDone = (async () => {
    while (!shutdown.signal.aborted) {
      const item = new AbortController();
      const timeout = setTimeout(() => item.abort(), 30_000);
      timeout.unref();
      try {
        // Drain a ready backlog without waiting for another build or an idle tick.
        if (await lifecycle.reconcileOne(AbortSignal.any([shutdown.signal, item.signal]))) continue;
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
    await lifecycle.drain();
  })();
  const maintenanceDone = (async () => {
    if (!maintenance) return;
    while (!shutdown.signal.aborted) {
      try {
        await maintenance();
      } catch {
        log("armada: resource evidence retention unavailable; retrying.");
      }
      if (!shutdown.signal.aborted)
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            shutdown.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, 10 * 60_000);
          timer.unref();
          shutdown.signal.addEventListener("abort", finish, { once: true });
        });
    }
  })();
  const done = Promise.all([goldenWorker.done, lifecycleDone, maintenanceDone]).then(() => {});
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
