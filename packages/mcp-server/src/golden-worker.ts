import type { GoldenBuildJobs } from "@armada/core/server";

/** One serialized queue loop per process; SQL fencing owns concurrency across processes.
 * Shutdown stops new ticks, never turns a disconnected HTTP request into cancelled build ownership.
 */
export function startGoldenWorker(
  jobs: Pick<GoldenBuildJobs, "runOne" | "reconcileOne">,
  log: (line: string) => void = console.error,
) {
  let stopped = false;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = (async () => {
    while (!stopped) {
      try {
        const worked = await jobs.runOne();
        if (stopped) break;
        if (worked) continue;
        await jobs.reconcileOne();
      } catch {
        // Upstream SQL/SDK errors may carry credential-bearing request data. Never log them.
        log("armada: golden worker tick unavailable; durable jobs remain fenced.");
      }
      if (!stopped)
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, 1000);
          timer.unref();
        });
    }
  })();
  return {
    done,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      wake?.();
    },
  };
}
