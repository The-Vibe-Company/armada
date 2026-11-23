import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as wait } from "node:timers/promises";
import type { Provider } from "@armada/core";
import { createBoatProvider } from "../src/provider.ts";

const apiKey = process.env.BOAT_API_KEY;
if (!apiKey || process.env.ARMADA_RUN_LIVE_BOAT_TESTS !== "1") {
  throw new Error("The Boat integration probe requires BOAT_API_KEY and ARMADA_RUN_LIVE_BOAT_TESTS=1.");
}
const phaseDeadline = new AsyncLocalStorage<AbortSignal>();

async function until<T>(what: string, read: () => Promise<T | undefined>, timeoutMs: number) {
  const signal = AbortSignal.timeout(timeoutMs);
  return phaseDeadline.run(signal, async () => {
    try {
      for (;;) {
        signal.throwIfAborted();
        const value = await read();
        signal.throwIfAborted();
        if (value !== undefined) return value;
        await wait(1000, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) throw new Error(`Timed out waiting for ${what}.`, { cause: error });
      throw error;
    }
  });
}

async function ready(provider: Provider, sandboxId: string) {
  await until(
    `${sandboxId} to be ready`,
    async () => {
      const info = await provider.get(sandboxId);
      if (info.state === "failed") throw new Error(`${sandboxId} failed: ${info.error ?? info.providerState}`);
      return info.state === "ready" || info.state === "running" ? info : undefined;
    },
    120_000,
  );
}

const boundedFetch: typeof fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const timeout = AbortSignal.timeout(120_000);
    const deadlines = [timeout];
    const phase = phaseDeadline.getStore();
    if (phase) deadlines.push(phase);
    if (init?.signal) deadlines.push(init.signal);
    const signal = AbortSignal.any(deadlines);
    return fetch(input, { ...init, signal });
  },
  { preconnect: fetch.preconnect },
);

const provider = createBoatProvider({
  apiKey,
  fetch: boundedFetch,
  ...(process.env.BOAT_BASE_URL ? { baseUrl: process.env.BOAT_BASE_URL } : {}),
});
const cleanup: Array<() => Promise<unknown>> = [];
try {
  let snapshot = process.env.BOAT_TEST_SNAPSHOT;
  if (!snapshot) {
    const name = `armada-it-${crypto.randomUUID()}`;
    const golden = await provider.createGolden({ name, ttlSeconds: 1800 });
    cleanup.push(() => provider.delete({ sandboxId: golden.id }));
    await ready(provider, golden.id);
    cleanup.push(() => provider.deleteSnapshot(name));
    await provider.snapshot({ sandboxId: golden.id, name });
    await until(
      `snapshot ${name}`,
      async () => {
        const info = await provider.getSnapshot(name);
        if (info.status === "failed") throw new Error(`snapshot failed: ${info.error}`);
        return info.status === "ready" ? info : undefined;
      },
      600_000,
    );
    snapshot = name;
  }

  const sandbox = await provider.fork({
    from: snapshot,
    ttlSeconds: 1800,
    labels: { armada: "integration-test" },
    idempotencyKey: crypto.randomUUID(),
  });
  cleanup.push(() => provider.delete({ sandboxId: sandbox.id }));
  assert.equal(sandbox.state, "starting");
  await ready(provider, sandbox.id);

  const echoed = await provider.exec({ sandboxId: sandbox.id, command: "echo armada" });
  assert.equal(echoed.detached, false);
  assert.equal(echoed.exitCode, 0);

  await provider.stop({ sandboxId: sandbox.id });
  await until(
    "the sandbox to stop",
    async () => ((await provider.get(sandbox.id)).state === "stopped" ? true : undefined),
    180_000,
  );
} finally {
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
}
console.log("Boat integration probe passed.");
