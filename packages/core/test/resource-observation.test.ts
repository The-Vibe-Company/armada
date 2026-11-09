import { describe, expect, test } from "bun:test";
import { type ResourceCounters, resourceInterval } from "../src/resource-observation.ts";

// Synthetic counter arithmetic only; these are not recorded provider observations.
const start: ResourceCounters = {
  version: 1,
  generation: "physical-1",
  capacityId: "capacity-1",
  monotonicMs: 1000,
  cpuUsageUsec: 1000000,
  cpuThrottledUsec: 100,
  cpuPressureSomeUsec: 100,
  memoryCurrentBytes: 1024,
  memoryPeakBytes: 2048,
  oomKills: 1,
};
const end: ResourceCounters = {
  ...start,
  monotonicMs: 11000,
  cpuUsageUsec: 21000000,
  cpuThrottledUsec: 200,
  cpuPressureSomeUsec: 1000100,
  oomKills: 2,
};
describe("resource counter normalization", () => {
  test("reports CPU seconds per second without clamping multicore usage and preserves lifetime peak semantics", () => {
    expect(resourceInterval(start, end)).toEqual({
      version: 1,
      generation: "physical-1",
      capacityId: "capacity-1",
      durationMs: 10000,
      cpuBusyCores: 2,
      cpuThrottledUsec: 100,
      cpuPressureFraction: 0.1,
      memoryCurrentBytes: 1024,
      memoryLifetimePeakBytes: 2048,
      oomKills: 1,
    });
  });
  test.each([
    { generation: "physical-2" },
    { capacityId: "capacity-2" },
    { monotonicMs: 1000 },
    { monotonicMs: 999 },
    { monotonicMs: 32000 },
    { monotonicMs: Number.NaN },
  ])("rejects discontinuity or invalid sampling window %j", (change) => {
    expect(resourceInterval(start, { ...end, ...change })).toBeNull();
  });
  test("counter reset and missing or impossible values are unavailable, never zero", () => {
    const result = resourceInterval(start, {
      ...end,
      cpuUsageUsec: null,
      cpuThrottledUsec: 99,
      cpuPressureSomeUsec: 20000000,
      memoryCurrentBytes: -1,
      memoryPeakBytes: Number.POSITIVE_INFINITY,
      oomKills: 0,
    });
    expect(result).toMatchObject({
      cpuBusyCores: null,
      cpuThrottledUsec: null,
      cpuPressureFraction: null,
      memoryCurrentBytes: null,
      memoryLifetimePeakBytes: null,
      oomKills: null,
    });
  });
  test("zero observed deltas remain valid evidence and unsafe integer counters do not", () => {
    expect(resourceInterval(start, { ...start, monotonicMs: 11000 })?.cpuBusyCores).toBe(0);
    expect(resourceInterval(start, { ...end, cpuUsageUsec: Number.MAX_SAFE_INTEGER + 1 })?.cpuBusyCores).toBeNull();
  });
});
