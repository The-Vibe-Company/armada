/** Measure an individual probe without changing its result, failure or cleanup policy. */
export async function timedSmokeStep<T>(
  action: () => Promise<T>,
  now: () => number,
  report: (elapsedMs: number, error?: unknown) => void,
): Promise<T> {
  const started = now();
  try {
    const value = await action();
    report(now() - started);
    return value;
  } catch (error) {
    report(now() - started, error);
    throw error;
  }
}
