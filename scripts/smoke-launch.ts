/** Observe a single ambiguous launch through read-only requests until its deadline. */
export async function observeSmokeLaunch<T>(
  until: number,
  io: { now(): number; sleep(ms: number): Promise<void> },
  read: (timeoutMs: number) => Promise<T | undefined>,
): Promise<T | undefined> {
  let remaining = until - io.now();
  while (remaining > 0) {
    const result = await read(remaining);
    remaining = until - io.now();
    if (result !== undefined && remaining >= 0) return result;
    if (remaining > 0) await io.sleep(Math.min(1_000, remaining));
    remaining = until - io.now();
  }
}
