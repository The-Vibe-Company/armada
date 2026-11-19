import type { GoldenBuildJobs } from "@armada/core/server";
import { startGoldenWorker } from "./golden-worker.ts";
import { JOBS_WAKE } from "./jobs/store.ts";
import { runtimeWakes, waitForTimeout } from "./wake-bus.ts";

export interface ServerLifecycleLane {
  reconcileOne(signal: AbortSignal): Promise<boolean>;
  drain(): Promise<void>;
  stopAdmission?(): void;
  /** Isolated sweeps can bound provider calls individually and run until shutdown. */
  isolatedSweep?: true;
}

/** Independent tracked lanes: a golden build can legitimately take an hour. */
export function startServerWorkers(
  goldens: Pick<GoldenBuildJobs, "runOne" | "reconcileOne">,
  lifecycle: ServerLifecycleLane,
  log: (line: string) => void = console.error,
  retirements?: { runOne(signal: AbortSignal): Promise<boolean> },
  maintenance?: () => Promise<void>,
  managed: readonly ServerLifecycleLane[] | ServerLifecycleLane = [],
  isolated: readonly ServerLifecycleLane[] = [],
) {
  const goldenWorker = startGoldenWorker(goldens, log);
  const lanes = [lifecycle, ...("reconcileOne" in managed ? [managed] : managed)];
  const shutdown = new AbortController();
  async function runLanes(group: readonly ServerLifecycleLane[], timebox = true, wakes = false) {
    const wake = wakes ? runtimeWakes.watch(JOBS_WAKE) : undefined;
    let nextLane = 0;
    while (!shutdown.signal.aborted) {
      const item = timebox ? new AbortController() : undefined;
      const timeout = item ? setTimeout(() => item.abort(), 30_000) : undefined;
      timeout?.unref();
      const signal = item ? AbortSignal.any([shutdown.signal, item.signal]) : shutdown.signal;
      try {
        // Drain a ready backlog without waiting for another build or an idle tick.
        let processed = false;
        for (let count = 0; count < group.length; count++) {
          const lane = group[nextLane];
          nextLane = (nextLane + 1) % group.length;
          if (!lane) throw new Error("Lifecycle scheduling lane unavailable.");
          if (await lane.reconcileOne(signal)) {
            processed = true;
            break;
          }
        }
        if (processed) continue;
      } catch {
        log("armada: sandbox lifecycle tick unavailable; durable leases remain fenced.");
      } finally {
        clearTimeout(timeout);
      }
      if (wake) await wake.wait(shutdown.signal, 1000, waitForTimeout);
      else await waitForTimeout(1000, shutdown.signal);
    }
    wake?.close();
    // SDKs may not support cancellation after a request has reached the provider. Keep
    // those operations tracked through shutdown; cancellation forbids subsequent actions.
    await Promise.all(group.map((lane) => lane.drain()));
  }
  const lifecycleDone = runLanes(lanes, true, true);
  const isolatedDone = Promise.all(isolated.map((lane) => runLanes([lane], !lane.isolatedSweep)));
  const retirementPending = new Set<Promise<boolean>>();
  const retirementDone = (async () => {
    while (retirements && !shutdown.signal.aborted) {
      // Bound a tick and outstanding SDK work without assuming SDK cancellation. Every
      // timed-out call stays tracked; durable delete markers forbid uncertain replays.
      if (retirementPending.size >= 4) {
        let wake: () => void = () => {};
        const stopped = new Promise<boolean>((resolve) => {
          wake = () => resolve(false);
          shutdown.signal.addEventListener("abort", wake, { once: true });
        });
        await Promise.race([...retirementPending].map((p) => p.catch(() => false)).concat(stopped));
        shutdown.signal.removeEventListener("abort", wake);
        continue;
      }
      const item = new AbortController();
      const timer = setTimeout(() => item.abort(), 30_000);
      timer.unref();
      const signal = AbortSignal.any([shutdown.signal, item.signal]);
      let abort: () => void = () => {};
      const cancelled = new Promise<boolean>((resolve) => {
        abort = () => resolve(false);
        signal.addEventListener("abort", abort, { once: true });
      });
      const work = retirements.runOne(signal);
      retirementPending.add(work);
      void work.then(
        () => retirementPending.delete(work),
        () => retirementPending.delete(work),
      );
      try {
        if (await Promise.race([work, cancelled])) continue;
      } catch {
        log("armada: snapshot retirement unavailable; saved revisions retained.");
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
      if (!shutdown.signal.aborted)
        await new Promise<void>((resolve) => {
          const idle = setTimeout(finish, 1000);
          idle.unref();
          function finish() {
            clearTimeout(idle);
            shutdown.signal.removeEventListener("abort", finish);
            resolve();
          }
          shutdown.signal.addEventListener("abort", finish, { once: true });
        });
    }
    await Promise.allSettled(retirementPending);
  })();
  const maintenanceDone = (async () => {
    if (!maintenance) return;
    while (!shutdown.signal.aborted) {
      try {
        await maintenance();
      } catch {
        log("armada: retention maintenance unavailable; retrying.");
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
  const done = Promise.all([goldenWorker.done, lifecycleDone, retirementDone, maintenanceDone, isolatedDone]).then(
    () => {},
  );
  return {
    goldenWorker,
    lifecycleWorker: { done: lifecycleDone },
    retirementWorker: { done: retirementDone },
    done,
    stop() {
      for (const lane of [...lanes, ...isolated]) lane.stopAdmission?.();
      goldenWorker.stop();
      shutdown.abort();
    },
  };
}
