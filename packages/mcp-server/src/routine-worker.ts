/** Dedicated tracked loop: a routine launch must not block sandbox lifecycle cleanup. */
export function startRoutineWorker(
  scheduler: { tick(signal?: AbortSignal): Promise<void> },
  log: (line: string) => void = console.error,
) {
  let stopped = false;
  const shutdown = new AbortController();
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = (async () => {
    while (!stopped) {
      try {
        await scheduler.tick(shutdown.signal);
      } catch {
        log("armada: routine scheduler unavailable; durable occurrences retained.");
      }
      if (!stopped)
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, 10_000);
          timer.unref();
        });
    }
  })();
  return {
    done,
    stop() {
      stopped = true;
      shutdown.abort();
      if (timer) clearTimeout(timer);
      wake?.();
    },
  };
}
