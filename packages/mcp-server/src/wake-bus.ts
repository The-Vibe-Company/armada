import type { Sql } from "@armada/core";

export function createWakeBus() {
  const listeners = new Map<string, Set<() => void>>();
  let notifyHealthy = false;
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
  // Subscribe before the database read so a commit during the read is retained.
  function watch(key: string) {
    let wake = new AbortController();
    const close = subscribe(key, () => wake.abort());
    return {
      close,
      async wait(signal: AbortSignal, ms = 0, delay = waitForAbort) {
        if (!wake.signal.aborted && !signal.aborted) {
          const waiting = AbortSignal.any([signal, wake.signal]);
          const { promise, resolve } = Promise.withResolvers<void>();
          const onAbort = () => resolve();
          waiting.addEventListener("abort", onAbort, { once: true });
          try {
            await Promise.race([promise, delay(ms, waiting)]);
          } finally {
            waiting.removeEventListener("abort", onAbort);
          }
        }
        const notified = wake.signal.aborted;
        if (notified) wake = new AbortController();
        return notified;
      },
    };
  }
  return {
    subscribe,
    notify,
    wait,
    watch,
    isNotifyHealthy: () => notifyHealthy,
    setNotifyHealthy(healthy: boolean) {
      notifyHealthy = healthy;
    },
  };
}

function waitForAbort(_ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

export async function waitForTimeout(ms: number, signal: AbortSignal, unref = false) {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (unref) timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });
}

export const eventFeedWakeKey = (sandboxId: string) => `events:${sandboxId.toLowerCase()}`;

export const EVENT_NOTIFY_CHANNEL = "armada_events";
export interface PgNotifyClient {
  listen(
    channel: string,
    onNotify: (payload: string) => void,
  ): Promise<{ unlisten(): Promise<void>; closed?: Promise<void> } | (() => Promise<void>)>;
  close?(): Promise<void>;
}
const NOTIFY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function startEventNotifyListener(
  clientOrFactory: PgNotifyClient | (() => PgNotifyClient),
  wakes = runtimeWakes,
  logError: (line: string) => void = console.error,
  options: {
    initialBackoffMs?: number;
    maxBackoffMs?: number;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const initialBackoffMs = options.initialBackoffMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const wait = options.wait ?? ((ms, signal) => waitForTimeout(ms, signal, true));
  const stop = new AbortController();
  const closedClients = new WeakSet<PgNotifyClient>();
  let healthy = false;
  let closing: Promise<void> | undefined;
  let activeClient: PgNotifyClient | undefined;
  let unsubscribe: (() => Promise<void>) | undefined;
  const setHealthy = (value: boolean) => {
    healthy = value;
    wakes.setNotifyHealthy(value);
  };
  const closeClient = async (target: PgNotifyClient | undefined) => {
    if (!target || closedClients.has(target)) return;
    closedClients.add(target);
    await target.close?.().catch(() => {});
  };
  const { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
  const loop = Promise.resolve().then(async () => {
    let backoff = initialBackoffMs;
    let logged = false;
    const markUnavailable = () => {
      setHealthy(false);
      if (stop.signal.aborted || logged) return;
      logged = true;
      logError("armada: postgres event notify listener unavailable; using recheck timer.");
    };
    while (!stop.signal.aborted) {
      const current = typeof clientOrFactory === "function" ? clientOrFactory() : clientOrFactory;
      activeClient = current;
      try {
        const handle = await current.listen(EVENT_NOTIFY_CHANNEL, (p) => {
          if (NOTIFY_UUID.test(p)) wakes.notify(eventFeedWakeKey(p));
        });
        closedClients.delete(current);
        const unlisten = typeof handle === "function" ? handle : () => handle.unlisten();
        if (stop.signal.aborted) {
          await unlisten().catch(() => {});
          await closeClient(current);
          break;
        }
        unsubscribe = unlisten;
        backoff = initialBackoffMs;
        logged = false;
        setHealthy(true);
        markReady();
        const disconnected = typeof handle === "object" ? handle.closed : undefined;
        if (!disconnected) return;
        await Promise.race([disconnected.catch(() => {}), waitForAbort(0, stop.signal)]);
        if (stop.signal.aborted) return;
        unsubscribe = undefined;
        markUnavailable();
        await closeClient(current);
      } catch {
        markUnavailable();
        await closeClient(current);
        markReady();
      }
      if (stop.signal.aborted) break;
      await wait(backoff, stop.signal);
      backoff = Math.min(maxBackoffMs, backoff * 2);
    }
    markReady();
  });
  return {
    ready,
    isHealthy: () => healthy,
    close() {
      if (closing) return closing;
      setHealthy(false);
      stop.abort();
      closing = (async () => {
        await loop;
        const off = unsubscribe;
        unsubscribe = undefined;
        await off?.().catch(() => {});
        await closeClient(activeClient);
      })();
      return closing;
    },
  };
}

export const SANDBOX_ADMISSION_WAKE = "sandbox-admission";

export const runtimeWakes = createWakeBus();
export const SANDBOX_ADMISSION_TIMEOUT_MS = 120_000;

export async function waitForSandboxAdmission<T>(
  signal: AbortSignal,
  attempt: () => Promise<{ busy: true } | { busy: false; result: T }>,
  waitFirst = false,
) {
  const wake = runtimeWakes.watch(SANDBOX_ADMISSION_WAKE);
  try {
    if (waitFirst) await wake.wait(signal);
    while (true) {
      signal.throwIfAborted();
      const admission = await attempt();
      if (!admission.busy) return admission.result;
      await wake.wait(signal);
    }
  } finally {
    wake.close();
  }
}

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
