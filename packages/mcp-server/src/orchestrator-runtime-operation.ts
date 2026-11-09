/** Bound the scheduling lane without pretending cancellation undoes an SDK side effect.
 * Raw operations remain tracked for shutdown; timed-out effects reconcile their durable receipt. */
export function orchestratorRuntimeOperations() {
  const pending = new Set<Promise<unknown>>();
  return {
    async drain(): Promise<void> {
      await Promise.allSettled([...pending]);
    },
    async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      signal?.throwIfAborted();
      const promise = work();
      pending.add(promise);
      const settled = promise.finally(() => pending.delete(promise));
      if (!signal) return settled;
      return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        settled.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      });
    },
  };
}
