import type { GoldenBuildJobs } from "@armada/core/server";
import { startGoldenWorker } from "./golden-worker.ts";

export interface ServerLifecycleLane {
  reconcileOne(signal: AbortSignal): Promise<boolean>;
  drain(): Promise<void>;
  stopAdmission?(): void;
}

/** Independent tracked lanes: a golden build can legitimately take an hour. */
export function startServerWorkers(
  goldens: Pick<GoldenBuildJobs, "runOne" | "reconcileOne">,
  lifecycle: ServerLifecycleLane,
  log: (line: string) => void = console.error,
  retirements?: { runOne(signal: AbortSignal): Promise<boolean> },
  maintenance?: () => Promise<void>,
  managed: readonly ServerLifecycleLane[] | ServerLifecycleLane = [],
) {
  const goldenWorker = startGoldenWorker(goldens, log);
  const lanes = [lifecycle, ...("reconcileOne" in managed ? [managed] : managed)];
  let nextLane = 0;
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
        let processed = false;
        for (let count = 0; count < lanes.length; count++) {
          const lane = lanes[nextLane];
          nextLane = (nextLane + 1) % lanes.length;
          if (!lane) throw new Error("Lifecycle scheduling lane unavailable.");
          if (await lane.reconcileOne(AbortSignal.any([shutdown.signal, item.signal]))) {
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
  const done = Promise.all([goldenWorker.done, lifecycleDone, retirementDone, maintenanceDone]).then(() => {});
  return {
    goldenWorker,
    lifecycleWorker: { done: lifecycleDone },
    retirementWorker: { done: retirementDone },
    done,
    stop() {
      for (const lane of lanes) lane.stopAdmission?.();
      goldenWorker.stop();
      shutdown.abort();
      if (idleTimer) clearTimeout(idleTimer);
      wake?.();
    },
  };
}
