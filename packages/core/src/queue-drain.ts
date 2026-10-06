// The coordinator owns execution; Armada stores only intent and lease-fenced progress.
import { ArmadaApiError } from "./armada-api.ts";
import type { Fleet } from "./live.ts";
import {
  MERGE_WAIT_DEFAULT_MS,
  type MergeContext,
  type MergeOutcome,
  MergeStateError,
  mergePullRequest,
} from "./merge.ts";
import { MERGE_QUEUE_LEASE, type QueueEntry, type QueueFinish, queueOpen } from "./merge-queue.ts";
import { Refusal } from "./refusal.ts";

const TTL_MS = 10 * 60_000;
const POLL_MS = 30_000;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
class TakenOver extends Refusal {
  constructor() {
    super("the queue was taken over", "armada merge --drain after its current holder finishes");
  }
}
const temporary = (err: unknown): boolean =>
  err instanceof ArmadaApiError
    ? !err.signedOut && !err.upgrade && (err.status === null || err.status === 429 || err.status >= 500)
    : err instanceof MergeStateError
      ? err.transient || !err.pull // Recovery starts with a state read, never a blind merge.
      : err instanceof Error && "transient" in err && err.transient === true;

/** Strict FIFO, including retries. A paused or interrupted active entry survives for the next drain. */
export async function drainMergeQueue(
  ctx: MergeContext,
  fleet: Fleet,
  opts: {
    timeoutMs?: number;
    /** Runtime scheduler; keeps the lease through long local checks and cleanup. */
    every: (ms: number, tick: () => Promise<void>) => () => void;
    afterMerge: (outcome: MergeOutcome, entry: QueueEntry, tick: () => Promise<void>) => Promise<void>;
    onRefused?: (entry: QueueEntry, error: unknown) => void;
    onFinished?: (entry: QueueEntry) => void;
  },
): Promise<void> {
  const lease = { name: MERGE_QUEUE_LEASE, holder: ctx.holder, ttlMs: TTL_MS };
  const got = await fleet.acquireLease(lease);
  if (!got.acquired)
    throw new Refusal(
      `drained by ${got.held?.holder ?? "another coordinator"} until ${got.held?.expiresAt ?? "unknown"}`,
      "armada merge --drain once that coordinator finishes",
    );
  let pulseError: unknown = null;
  let pulse = Promise.resolve();
  let stopPulse: (() => void) | undefined;
  const tick = async () => {
    if (pulseError) throw pulseError;
    if (!(await fleet.renewLease(lease))) throw new TakenOver();
  };
  const sleep = async (ms: number) => {
    for (let remaining = ms; remaining > 0; remaining -= POLL_MS) {
      await tick();
      await ctx.sleep(Math.min(POLL_MS, remaining));
    }
    await tick();
  };
  // Fence adapter calls too: cleanup can outlive the lease while awaiting a remote read.
  // Rechecking after a call stops subsequent effects even when its caller catches errors.
  const fenced = <T extends object>(target: T, mutations?: readonly (keyof T)[]): T =>
    new Proxy(target, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        if (mutations && !mutations.includes(key as keyof T)) return value.bind(target);
        return async (...args: unknown[]) => {
          await tick();
          const result = await Reflect.apply(value, target, args);
          if (!mutations) await tick();
          return result;
        };
      },
    });
  const run: MergeContext = {
    ...ctx,
    tick,
    sleep,
    linear: fenced(ctx.linear),
    // Keep read-only GitHub confirmation available after native writes; fence every mutation.
    forge: fenced(ctx.forge, ["updateBranch", "comment", "beforeMerge", "merge"]),
    repo: ctx.repo ? fenced(ctx.repo, ["testMerge", "mergeTree"]) : null,
    fleet: async () => {
      await tick();
      const live = await ctx.fleet();
      return { ...live, fleet: live.fleet ? fenced(live.fleet) : null };
    },
    afterRecord: async (ticket) => {
      await tick();
      await ctx.afterRecord?.(ticket, tick);
      await tick();
    },
  };
  const finish = async (entry: QueueEntry, result: Omit<QueueFinish, "id" | "holder">) => {
    await tick();
    if (!(await fleet.queueFinish({ ...result, id: entry.id, holder: ctx.holder }))) throw new TakenOver();
  };
  try {
    stopPulse = opts.every(POLL_MS, () => {
      pulse = pulse.then(tick).catch((err) => {
        pulseError = err;
      });
      return pulse;
    });
    for (;;) {
      await tick();
      const next = await fleet.queueNext({ holder: ctx.holder });
      if ("refused" in next) throw new TakenOver();
      const entry = next.entry;
      if (!entry) {
        const pending = (await fleet.queueList()).find(queueOpen);
        if (!pending) {
          ctx.progress?.("queue empty");
          return;
        }
        if (!pending.notBefore) throw new TakenOver();
        await sleep(Math.max(1, Math.min(POLL_MS, Date.parse(pending.notBefore) - ctx.now().getTime())));
        continue;
      }
      let outcome: MergeOutcome;
      try {
        outcome = await mergePullRequest(run, {
          pr: entry.pr,
          ticket: entry.ticket,
          noTicket: entry.noTicket,
          keepOpen: entry.keepOpen,
          throughHold: entry.throughHold ?? undefined,
          reason: entry.reason,
          queue: true,
          queuedHead: entry.noTicket ? undefined : entry.headSha,
          wait: { timeoutMs: opts.timeoutMs ?? MERGE_WAIT_DEFAULT_MS },
          retest: ctx.config.merge.queueRetest,
        });
      } catch (err) {
        if (err instanceof TakenOver) throw err;
        if (err instanceof Refusal && err.paused) {
          await finish(entry, { outcome: "paused", detail: err.message });
          throw err;
        }
        const transient = temporary(err);
        // Unexpected local failures must remain recoverable, never turn into a rule refusal.
        if (!transient && !(err instanceof Refusal) && !(err instanceof MergeStateError && err.pull)) throw err;
        const wait = transient ? BACKOFF_MS[entry.attempts] : undefined;
        if (err instanceof MergeStateError && transient && wait === undefined) throw err;
        const detail = err instanceof Error ? err.message : String(err);
        try {
          await finish(
            entry,
            wait === undefined
              ? { outcome: "refused", detail }
              : { outcome: "retry", detail, notBefore: new Date(ctx.now().getTime() + wait).toISOString() },
          );
        } catch (finishError) {
          // A lost lease leaves the row recoverable; retain the native merge's known/unknown fact.
          if (err instanceof MergeStateError) throw err;
          throw finishError;
        }
        if (wait === undefined) opts.onRefused?.(entry, err);
        else ctx.progress?.(`#${entry.pr} remains queued; retrying in ${wait / 60_000} min: ${detail}`);
        continue;
      }
      // Keep the active row recoverable until every idempotent after-merge step finishes.
      await tick();
      await opts.afterMerge(outcome, entry, tick);
      await finish(entry, { outcome: "merged", detail: null, mergeCommit: outcome.pr.mergeCommit });
      opts.onFinished?.(entry);
    }
  } finally {
    stopPulse?.();
    await pulse;
    await fleet.releaseLease(lease).catch(() => {});
  }
}
