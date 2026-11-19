import type { Sql } from "@armada/core";
import type { ServerLifecycleLane } from "../server-workers.ts";

export interface Job {
  id: string;
  kind: string;
  sandbox_id: string | null;
  generation: string | null;
  lease_epoch: string;
  attempts: number;
  max_attempts: number;
  payload: unknown;
  outcome: unknown;
}

export type JobResult = (
  | { status: "done"; outcome?: unknown }
  | { status: "retry"; after: Date; outcome?: unknown }
  | { status: "fail"; reason: string; outcome?: unknown }
) & { commit?: (tx: Sql) => Promise<void> };

export interface JobStore {
  claim(kind: string, owner: string, seconds: number, concurrency: number): Promise<Job | undefined>;
  inspect(job: Job, owner: string): Promise<"dispatch" | "reconcile" | "stale" | "lost">;
  retireStale(job: Job, owner: string): Promise<void>;
  renew(job: Job, owner: string, seconds: number): Promise<boolean>;
  complete(job: Job, owner: string, result: JobResult): Promise<void>;
}

interface JobKind {
  concurrency: number;
  run(job: Job, context: { signal: AbortSignal; canDispatch(): Promise<boolean> }): Promise<JobResult>;
}

const LEASE_SECONDS = 30;

export function createJobsRunner(
  store: JobStore,
  kinds: Readonly<Record<string, JobKind>>,
  log: (line: string) => void = console.error,
  schedule = (ms: number, run: () => void) => {
    const timer = setTimeout(run, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
) {
  const owner = crypto.randomUUID();
  const shutdown = new AbortController();
  const registrations = Object.entries(kinds).map(([kind, handler]) => {
    if (!Number.isSafeInteger(handler.concurrency) || handler.concurrency <= 0)
      throw new Error("Invalid jobs concurrency.");
    return { kind, handler };
  });
  const pending = new Set<Promise<void>>();
  let nextKind = 0;

  async function run(job: Job, handler: JobKind, cancelClaimExpiry: () => void, lease: AbortController) {
    const signal = AbortSignal.any([lease.signal, shutdown.signal]);
    let cancelExpiry = cancelClaimExpiry;
    let renewal: Promise<void> | undefined;
    let cancelRenewal: (() => void) | undefined;
    async function renew() {
      if (signal.aborted) return;
      // WARNING: Arm expiry before renewal so a delayed response cannot extend local ownership.
      const cancelNextExpiry = schedule(LEASE_SECONDS * 1000, () => lease.abort());
      try {
        if (!(await store.renew(job, owner, LEASE_SECONDS))) lease.abort();
        if (signal.aborted) return;
        cancelExpiry();
        cancelExpiry = cancelNextExpiry;
        scheduleRenewal();
      } catch {
        lease.abort();
      } finally {
        if (signal.aborted) cancelNextExpiry();
      }
    }
    function scheduleRenewal() {
      cancelRenewal = schedule((LEASE_SECONDS * 1000) / 3, () => {
        renewal = renew();
      });
    }
    try {
      if (signal.aborted) return;
      const state = await store.inspect(job, owner);
      if (signal.aborted || state === "lost") return;
      if (state === "stale") {
        await store.retireStale(job, owner);
        return;
      }
      scheduleRenewal();
      const result = await handler.run(job, {
        signal,
        async canDispatch() {
          return !signal.aborted && (await store.inspect(job, owner)) === "dispatch" && !signal.aborted;
        },
      });
      if (!signal.aborted) await store.complete(job, owner, result);
    } finally {
      lease.abort();
      cancelExpiry();
      cancelRenewal?.();
      await renewal;
    }
  }

  return {
    async reconcileOne(signal) {
      for (let count = 0; count < registrations.length && !signal.aborted && !shutdown.signal.aborted; count++) {
        const registration = registrations[nextKind]!;
        nextKind = (nextKind + 1) % registrations.length;
        const { kind, handler } = registration;
        const lease = new AbortController();
        const cancelExpiry = schedule(LEASE_SECONDS * 1000, () => lease.abort());
        let claimed = false;
        try {
          const job = await store.claim(kind, owner, LEASE_SECONDS, handler.concurrency);
          if (!job || signal.aborted || shutdown.signal.aborted) continue;
          claimed = true;
          const work = run(job, handler, cancelExpiry, lease)
            .catch(() => log("armada: job execution unavailable; durable lease remains fenced."))
            .finally(() => {
              pending.delete(work);
            });
          pending.add(work);
          return true;
        } finally {
          if (!claimed) cancelExpiry();
        }
      }
      return false;
    },
    stopAdmission: () => shutdown.abort(),
    async drain() {
      await Promise.allSettled(pending);
    },
  } satisfies ServerLifecycleLane;
}
