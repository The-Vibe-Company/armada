/** Resolve once before serving: the health diagnostic and both workers share this value. */
export function idlePauseDelayMs(env: Readonly<Record<string, string | undefined>>): number {
  const delay = Number(env.ARMADA_RUNTIME_IDLE_MINUTES ?? 10) * 60_000;
  if (!Number.isSafeInteger(delay) || delay < 1)
    throw Error("ARMADA_RUNTIME_IDLE_MINUTES must yield a positive whole number of milliseconds.");
  return delay;
}
