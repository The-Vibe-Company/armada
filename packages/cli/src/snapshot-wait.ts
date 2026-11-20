import { setTimeout as delay } from "node:timers/promises";

export async function waitForSnapshot<T>(
  receipt: T,
  seconds: number,
  sleep: ((ms: number) => Promise<void>) | undefined,
  pending: (receipt: T) => boolean,
  read: (signal: AbortSignal) => Promise<T>,
) {
  if (!seconds || !pending(receipt)) return receipt;
  const deadline = AbortSignal.timeout(seconds * 1000);
  const interval = Math.min(2000, seconds * 500);
  try {
    for (let attempt = 0; pending(receipt) && attempt < Math.ceil((seconds * 1000) / interval); attempt++) {
      if (sleep) await sleep(interval);
      else await delay(interval, undefined, { signal: deadline });
      if (deadline.aborted) break;
      receipt = await read(AbortSignal.any([deadline, AbortSignal.timeout(10_000)]));
    }
  } catch (error) {
    if (!deadline.aborted) throw error;
  }
  return receipt;
}
