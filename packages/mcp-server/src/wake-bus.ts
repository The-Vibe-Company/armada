import type { Sql } from "@armada/core";

export function createWakeBus() {
  const listeners = new Map<string, Set<() => void>>();
  function subscribe(key: string, wake: () => void) {
    let group = listeners.get(key);
    if (!group) {
      group = new Set();
      listeners.set(key, group);
    }
    group.add(wake);
    return () => {
      group.delete(wake);
      if (!group.size && listeners.get(key) === group) listeners.delete(key);
    };
  }
  function notify(key: string) {
    for (const wake of [...(listeners.get(key) ?? [])]) wake();
  }
  async function wait(key: string, signal: AbortSignal, maxMs: number, delay = waitForTimeout) {
    if (signal.aborted) return;
    const wake = new AbortController();
    const waiting = AbortSignal.any([signal, wake.signal]);
    const unsubscribe = subscribe(key, () => wake.abort());
    const { promise, resolve } = Promise.withResolvers<void>();
    const onAbort = () => resolve();
    waiting.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([promise, delay(maxMs, waiting)]);
    } finally {
      waiting.removeEventListener("abort", onAbort);
      unsubscribe();
    }
  }
  return { subscribe, notify, wait };
}

export async function waitForTimeout(ms: number, signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export const runtimeWakes = createWakeBus();

// Scoped authority calls reuse the original SQL transaction object. Only its owner knows
// when the write commits, so collect wake keys there instead of publishing on reentry.
const transactionWakes = new WeakMap<Sql, Set<string>>();

export function collectTransactionWakes(tx: Sql) {
  const keys = new Set<string>();
  transactionWakes.set(tx, keys);
  return () => {
    for (const key of keys) runtimeWakes.notify(key);
  };
}

export function deferTransactionWake(tx: Sql, key: string) {
  const keys = transactionWakes.get(tx);
  keys?.add(key);
  return keys !== undefined;
}
