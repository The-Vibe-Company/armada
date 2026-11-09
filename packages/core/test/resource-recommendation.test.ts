import { expect, test } from "bun:test";
import { type ResourceSessionEvidence, recommendResourceSize } from "../src/resource-recommendation.ts";

// Synthetic arithmetic inputs only; never presented as provider evidence.
const nowMs = 10 * 86400000;
const session: ResourceSessionEvidence = {
  endedAtMs: nowMs - 1000,
  activeSeconds: 600,
  coverageFraction: 0.99,
  validIntervals: 60,
  cpuPeakFraction: 0.1,
  cpuPressureFraction: 0,
  throttledSeconds: 0,
  memoryPeakBytes: 1024 ** 3,
  oomKills: 0,
  complete: true,
};
const sessions = Array.from({ length: 5 }, () => ({ ...session }));
const input = {
  nowMs,
  current: { size: "large" as const, cpuQuotaBusyCores: 8, memoryBytes: 16 * 1024 ** 3 },
  sessions,
  eligible: [
    { size: "small", cpuQuotaBusyCores: 2, memoryBytes: 4 * 1024 ** 3 },
    { size: "medium", cpuQuotaBusyCores: 4, memoryBytes: 8 * 1024 ** 3 },
  ] as const,
};
test("recommends only an eligible tier with explicit peak headroom", () => {
  expect(recommendResourceSize(input)).toEqual({
    considered: 5,
    sufficient: 5,
    reason: "headroom_observed",
    recommendedSize: "small",
  });
  expect(recommendResourceSize({ ...input, eligible: [input.eligible[1]] }).recommendedSize).toBe("medium");
  expect(recommendResourceSize({ ...input, eligible: null }).reason).toBe("eligibility_unknown");
});
test.each([{ cpuPeakFraction: 0.8 }, { memoryPeakBytes: 15 * 1024 ** 3 }])("peaks prevent downsizing %j", (change) => {
  expect(
    recommendResourceSize({ ...input, sessions: sessions.map((s) => ({ ...s, ...change })) }).recommendedSize,
  ).toBeNull();
});
test.each([{ cpuPressureFraction: 0.02 }, { throttledSeconds: 1 }, { oomKills: 1 }])(
  "pressure prevents downsizing %j",
  (change) => {
    expect(
      recommendResourceSize({ ...input, sessions: [{ ...session, ...change }, ...sessions.slice(1)] }).reason,
    ).toBe("resource_pressure");
  },
);
test.each([
  { cpuPressureFraction: null },
  { complete: false },
  { coverageFraction: 0.89 },
  { activeSeconds: 299 },
  { validIntervals: 29 },
])("missing evidence is not zero usage %j", (change) => {
  expect(recommendResourceSize({ ...input, sessions: [{ ...session, ...change }, ...sessions] }).reason).toBe(
    "insufficient_coverage",
  );
});
test("freshness/count use the last ten without substituting older favorable evidence", () => {
  expect(recommendResourceSize({ ...input, sessions: sessions.slice(1) }).reason).toBe("insufficient_sessions");
  expect(recommendResourceSize({ ...input, sessions: sessions.map((s) => ({ ...s, endedAtMs: 0 })) }).reason).toBe(
    "stale_observations",
  );
  const recent = Array.from({ length: 10 }, () => ({ ...session, complete: false }));
  expect(
    recommendResourceSize({
      ...input,
      sessions: [...recent, ...sessions.map((s) => ({ ...s, endedAtMs: nowMs - 2000 }))],
    }),
  ).toMatchObject({ considered: 10, sufficient: 0, recommendedSize: null });
});

test("observed scheduler quotas, not size labels, determine CPU headroom", () => {
  expect(
    recommendResourceSize({ ...input, current: { ...input.current, cpuQuotaBusyCores: 32 } }).recommendedSize,
  ).toBeNull();
  expect(recommendResourceSize({ ...input, current: null }).reason).toBe("unknown_capacity");
});
