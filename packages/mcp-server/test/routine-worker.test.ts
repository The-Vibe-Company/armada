import { expect, test } from "bun:test";
import { startRoutineWorker } from "../src/routine-worker.ts";

// Shutdown must retain an in-flight launch until it settles; no clocks or real provider needed.
test("routine worker shutdown drains its admitted tick without admitting another", async () => {
  let finish!: () => void;
  let calls = 0;
  const inFlight = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const worker = startRoutineWorker({
    tick: async () => {
      calls++;
      await inFlight;
    },
  });
  worker.stop();
  let drained = false;
  void worker.done.then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  finish();
  await worker.done;
  expect(calls).toBe(1);
  expect(drained).toBe(true);
});
