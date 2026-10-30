import { setTimeout } from "node:timers/promises";

export async function eventually(
  action: () => Promise<boolean>,
  {
    now = () => performance.now(),
    sleep = async (ms: number) => {
      await setTimeout(ms);
    },
    timeoutMs = 3_000,
  }: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const settled = await action();
    const remaining = deadline - now();
    if (remaining <= 0) break;
    if (settled) return;
    await sleep(Math.min(25, remaining));
  }
  throw new Error("condition did not settle");
}
