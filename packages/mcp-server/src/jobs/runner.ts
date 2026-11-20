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

export interface GenerationHandoff {
  lockPrerequisites(tx: Sql): Promise<void>;
  advance(tx: Sql, job: Job): Promise<void>;
}

export type JobResult = (
  | { status: "done"; outcome?: unknown }
  | { status: "retry"; after: Date; outcome?: unknown }
  | { status: "fail"; reason: string; outcome?: unknown }
) & { commit?: (tx: Sql) => Promise<void> };

export interface JobStore {
  claim(kind: string, owner: string, seconds: number, concurrency: number): Promise<Job | undefined>;
  inspect(job: Job, owner: string, tx?: Sql): Promise<"dispatch" | "reconcile" | "stale" | "lost">;
  retireStale(job: Job, owner: string, phase?: "before_handler"): Promise<void>;
  handoffGeneration(job: Job, owner: string, handoff: GenerationHandoff): Promise<string>;
  renew(job: Job, owner: string, seconds: number): Promise<boolean>;
  complete(job: Job, owner: string, result: JobResult): Promise<boolean>;
}

export interface JobContext {
  signal: AbortSignal;
  canDispatch(tx?: Sql): Promise<boolean>;
  handoffGeneration(handoff: GenerationHandoff): Promise<string>;
}

export interface JobKind {
  prepare?(): Promise<boolean>;
  drain?(): Promise<void>;
  concurrency: number;
  timeoutMs?: number;
  run(job: Job, context: JobContext): Promise<JobResult>;
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
    return { kind, handler, active: 0 };
  });
  const pending = new Set<Promise<void>>();
  let nextKind = 0;

  async function run(job: Job, handler: JobKind, cancelClaimExpiry: () => void, lease: AbortController) {
    const ownership = AbortSignal.any([lease.signal, shutdown.signal]);
    const deadline = handler.timeoutMs === undefined ? undefined : new AbortController();
    const signal = deadline ? AbortSignal.any([ownership, deadline.signal]) : ownership;
    const cancelDeadline =
      handler.timeoutMs === undefined ? undefined : schedule(handler.timeoutMs, () => deadline?.abort());
    let cancelExpiry = cancelClaimExpiry;
    let renewal: Promise<void> | undefined;
    let cancelRenewal: (() => void) | undefined;
    async function renew() {
      if (signal.aborted) return;
      // WARNING: Arm expiry before renewal so a delayed response cannot extend local ownership.
      const cancelNextExpiry = schedule(LEASE_SECONDS * 1000, () => lease.abort());
      try {
        if (!(await store.renew(job, owner, LEASE_SECONDS))) {
          lease.abort();
          await store.retireStale(job, owner);
        }
        if (ownership.aborted) return;
        cancelExpiry();
        cancelExpiry = cancelNextExpiry;
        if (!signal.aborted) scheduleRenewal();
      } catch {
        lease.abort();
      } finally {
        if (ownership.aborted) cancelNextExpiry();
      }
    }
    const scheduleRenewal = () => {
      cancelRenewal = schedule((LEASE_SECONDS * 1000) / 3, () => (renewal = renew()));
    };
    try {
      if (signal.aborted) return;
      const state = await store.inspect(job, owner);
      if (signal.aborted || state === "lost") return;
      if (state === "stale") {
        await store.retireStale(job, owner, "before_handler");
        return;
      }
      scheduleRenewal();
      const result = await handler.run(job, {
        signal,
        async canDispatch(tx) {
          return !signal.aborted && (await store.inspect(job, owner, tx)) === "dispatch" && !signal.aborted;
        },
        async handoffGeneration(handoff) {
          signal.throwIfAborted();
          const generation = await store.handoffGeneration(job, owner, {
            lockPrerequisites: handoff.lockPrerequisites,
            async advance(tx, claimedJob) {
              signal.throwIfAborted();
              await handoff.advance(tx, claimedJob);
              signal.throwIfAborted();
            },
          });
          signal.throwIfAborted();
          return generation;
        },
      });
      if (!ownership.aborted && !(await store.complete(job, owner, result))) await store.retireStale(job, owner);
    } finally {
      lease.abort();
      cancelExpiry();
      cancelDeadline?.();
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
        if (handler.timeoutMs !== undefined && registration.active >= handler.concurrency) continue;
        if (handler.prepare && !(await handler.prepare())) continue;
        if (signal.aborted || shutdown.signal.aborted) return false;
        const lease = new AbortController();
        const cancelExpiry = schedule(LEASE_SECONDS * 1000, () => lease.abort());
        let claimed = false;
        try {
          const job = await store.claim(kind, owner, LEASE_SECONDS, handler.concurrency);
          if (!job || signal.aborted || shutdown.signal.aborted) continue;
          claimed = true;
          registration.active++;
          const work = run(job, handler, cancelExpiry, lease)
            .catch(() => log("armada: job execution unavailable; durable lease remains fenced."))
            .finally(() => {
              registration.active--;
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
      await Promise.all(registrations.map(({ handler }) => handler.drain?.()));
    },
  } satisfies ServerLifecycleLane;
}
