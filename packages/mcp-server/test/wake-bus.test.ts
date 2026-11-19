import { expect, test } from "bun:test";
import { createWakeBus } from "../src/wake-bus.ts";

test("a wake releases all waiters for the notified key only", async () => {
  const bus = createWakeBus();
  const controller = new AbortController();
  const delays: AbortSignal[] = [];
  const delay = (_ms: number, signal: AbortSignal) => {
    delays.push(signal);
    return new Promise<void>(() => {});
  };
  const first = bus.wait("target", controller.signal, 1000, delay);
  const second = bus.wait("target", controller.signal, 1000, delay);
  const other = bus.wait("other", controller.signal, 1000, delay);
  let unrelatedSettled = false;
  void other.then(() => {
    unrelatedSettled = true;
  });
  try {
    bus.notify("target");
    expect(delays.map((signal) => signal.aborted)).toEqual([true, true, false]);
    await Promise.all([first, second]);
    expect(unrelatedSettled).toBe(false);
  } finally {
    controller.abort();
    await Promise.all([first, second, other]);
  }
});

test("aborted and timed-out waits detach from the bus", async () => {
  const bus = createWakeBus();
  const aborted = new AbortController();
  const timedOut = new AbortController();
  const tick = Promise.withResolvers<void>();
  const delays: AbortSignal[] = [];
  const delay = (_ms: number, signal: AbortSignal) => {
    delays.push(signal);
    return tick.promise;
  };
  const first = bus.wait("key", aborted.signal, 250, delay);
  const second = bus.wait("key", timedOut.signal, 250, delay);
  aborted.abort();
  await first;
  tick.resolve();
  await second;
  bus.notify("key");
  expect(delays.map((signal) => signal.aborted)).toEqual([true, false]);
});
