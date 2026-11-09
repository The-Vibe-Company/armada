import type { SandboxPatch, SandboxRecord, SandboxStore } from "./sandbox.ts";

/** Separate activity ownership from observation leases. Completion advances the generation,
 * invalidating every observation sampled before provider admission completed. */
export async function sandboxActivity<T>(
  store: SandboxStore,
  sandbox: SandboxRecord,
  admission: SandboxPatch,
  work: (signal: AbortSignal) => Promise<{ result: T; patch: SandboxPatch }>,
  options: { initialLeaseId?: string; failurePatch?: (error: unknown) => SandboxPatch; deadlineMs?: number } = {},
): Promise<T> {
  const token = options.initialLeaseId ?? crypto.randomUUID();
  const generation = sandbox.lifecycleGeneration;
  // Admission and completion each advance the counter (initial launch already admitted).
  // Refuse exhaustion before provider work or a lossy CAS parameter can be produced.
  if (
    generation !== undefined &&
    (!Number.isSafeInteger(generation) ||
      generation < 1 ||
      generation > Number.MAX_SAFE_INTEGER - (options.initialLeaseId ? 1 : 2))
  )
    throw new Error("Sandbox lifecycle generation cannot be advanced safely.");
  const expected =
    generation === undefined ? {} : { expectedGeneration: generation + (options.initialLeaseId ? 0 : 1) };
  if (!options.initialLeaseId)
    await store.update(sandbox.id, {
      ...admission,
      advanceGeneration: true,
      activityToken: token,
      ...(generation === undefined ? {} : { expectedGeneration: generation }),
    });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), options.deadlineMs ?? 5 * 60_000);
  deadline.unref();
  let renewal: Promise<void> = Promise.resolve();
  const heartbeat = setInterval(() => {
    renewal = renewal
      .then(async () => {
        if (controller.signal.aborted) return;
        await store.update(sandbox.id, { renewActivity: true, activityToken: token, ...expected });
      })
      .catch(() => controller.abort());
  }, 30_000);
  heartbeat.unref();
  try {
    const { result, patch } = await work(controller.signal);
    controller.signal.throwIfAborted();
    await renewal;
    controller.signal.throwIfAborted();
    await store.update(sandbox.id, { ...patch, finishActivity: true, activityToken: token, ...expected });
    return result;
  } catch (error) {
    if (options.failurePatch)
      await store
        .update(sandbox.id, { ...options.failurePatch(error), finishActivity: true, activityToken: token, ...expected })
        .catch(() => {});
    throw error;
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    await renewal;
    // Unknown outcomes retain the bounded admission lease; no optimistic release.
  }
}
