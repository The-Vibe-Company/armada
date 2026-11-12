import { expect, spyOn, test } from "bun:test";
import type { Sql } from "@armada/core";
import { createDatabaseReadiness } from "../src/database-readiness.ts";
import { REQUIRED_MIGRATION } from "../src/required-migration.ts";

test("readiness bounds a stuck probe, coalesces callers and requires fresh proof after recovery", async () => {
  let now = 100;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const deadlines: (() => void)[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    deadlines.push(callback);
    return {};
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  const stuck = Promise.withResolvers<{ rows: never[] }>();
  let calls = 0;
  const ready = createDatabaseReadiness({
    query: (() => {
      calls++;
      return calls === 1 ? stuck.promise : Promise.resolve({ rows: [{ version: REQUIRED_MIGRATION }] });
    }) as Sql["query"],
  });
  try {
    const first = ready();
    const second = ready();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(calls).toBe(1);
    deadlines[0]?.();
    expect(await first).toBe(false);
    now += 10_000;
    expect(await ready()).toBe(false);
    expect(calls).toBe(1); // Timeout must not queue more queries behind a stuck pool.
    stuck.resolve({ rows: [] });
    // Flush the driver's completion and cleanup, not a wall-clock delay.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const fresh = ready();
    expect(await fresh).toBe(true);
    expect(calls).toBe(2); // Late success of the timed-out probe is not healthy evidence.
    expect(await ready()).toBe(true);
    expect(calls).toBe(2); // Cache bounds load from unauthenticated health polling.
    now += 1_001;
    expect(await ready()).toBe(true);
    expect(calls).toBe(3);
  } finally {
    timer.mockRestore();
    clear.mockRestore();
    clock.mockRestore();
  }
});
