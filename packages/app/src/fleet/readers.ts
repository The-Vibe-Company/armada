import type { ReaderUsage } from "@armada/protocol";
import { z } from "zod";

// Like the fleet rows, screens read only the fields they display.
const readersSchema = z.record(
  z.string(),
  z.object({
    hour: z.iso.datetime(),
    requests: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    pausedUntil: z.iso.datetime().nullable(),
  }),
);
const cache = new WeakMap<object, Record<string, ReaderUsage> | undefined>();

/** Telemetry is read only by the lazy Room and About screens, once per snapshot. */
export function readersOf(snapshot: { state: unknown }): Record<string, ReaderUsage> | undefined {
  if (!cache.has(snapshot)) {
    const state = snapshot.state;
    const result = readersSchema.safeParse(
      state !== null && typeof state === "object" && !Array.isArray(state)
        ? (state as Record<string, unknown>).readers
        : undefined,
    );
    cache.set(snapshot, result.success ? result.data : undefined);
  }
  return cache.get(snapshot);
}
