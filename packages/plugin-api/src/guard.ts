import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkerRef } from "./runtime.js";

type Target = Omit<WorkerRef, "handle"> & { handle?: string };
type Scope = { target: Target; check: () => void | Promise<void> };
// The published host is bundled while a tested plugin can import its own copy of this package.
// A versioned process-wide context preserves one guard across those ES module boundaries.
const key = Symbol.for("@armada/plugin-api/guard/v1");
const shared = globalThis as typeof globalThis & Record<symbol, unknown>;
if (!shared[key]) shared[key] = new AsyncLocalStorage<Scope>();
const guards = shared[key] as AsyncLocalStorage<Scope>;
const same = (a: Target, b: Target) =>
  a.project === b.project &&
  a.ticket === b.ticket &&
  a.session === b.session &&
  a.generation === b.generation &&
  (a.handle === undefined || a.handle === b.handle);

/** Copied in shape from V1 packages/cli/src/runtimes/adapter.ts guarded/checkedMutation (THE-1074).
 * The V2 host supplies fresh ownership reads; providers recheck at EACH native write after provenance awaits.
 * No V1 code, store, socket or plugin lookup is imported here. */
export async function guarded<T>(target: Target, check: () => void | Promise<void>, act: () => Promise<T>): Promise<T> {
  await check();
  return guards.run({ target, check }, async () => {
    await check();
    return act();
  });
}
export async function checkedMutation<T>(target: Target, act: () => T | Promise<T>): Promise<T> {
  const guard = guards.getStore();
  if (!guard || !same(guard.target, target)) throw new Error("Worker action requires a current generation guard");
  const checked = guard.check();
  if (checked) await checked;
  return act();
}
