import type { GoldenBuildJobs } from "@armada/core/server";
import type { JobKind } from "./jobs/runner.ts";

export function createGoldenBuildJob(
  builds: Pick<GoldenBuildJobs, "dispatchReceipt">,
  now = Date.now,
  recoveryDeadline = () => AbortSignal.timeout(30_000),
) {
  const recovering = new Map<string, Promise<void>>();
  return {
    concurrency: 1,
    async run(job, { signal }) {
      signal.throwIfAborted();
      const { pending } = await builds.dispatchReceipt(job.id, job.lease_epoch, signal, async (recover) => {
        if (recovering.has(job.id) || recovering.size >= 4) return false;
        const recoverySignal = AbortSignal.any([signal, recoveryDeadline()]);
        if (recoverySignal.aborted) return false;
        const interrupted = Promise.withResolvers<false>();
        const onAbort = () => interrupted.resolve(false);
        recoverySignal.addEventListener("abort", onAbort, { once: true });
        const work = recover(recoverySignal).finally(() => recovering.delete(job.id));
        recovering.set(job.id, work);
        try {
          return await Promise.race([work.then(() => true), interrupted.promise]);
        } finally {
          recoverySignal.removeEventListener("abort", onAbort);
        }
      });
      return pending ? { status: "retry", after: new Date(now() + 60_000) } : { status: "done" };
    },
    async drain() {
      await Promise.allSettled(recovering.values());
    },
  } satisfies JobKind;
}
