import { expect, test } from "bun:test";
import { launchTimingFact } from "../src/lib/launch-timing.ts";

test("sandbox detail shows total launch time and the slowest stage", () => {
  expect(launchTimingFact(null)).toBeNull();
  expect(
    launchTimingFact({
      epoch: "1",
      stages: [],
      ready: true,
      totalMs: 95_000,
      slowest: { stage: "enrolled", ms: 75_000 },
    }),
  ).toEqual(["Launch time", "1 min 35 s (slowest: Enrolled, 1 min 15 s)"]);
  expect(
    launchTimingFact({
      epoch: "2",
      stages: [
        { stage: "machine_started", at: "", ms: null },
        { stage: "bootstrap_started", at: "", ms: 4_000 },
      ],
      ready: false,
      totalMs: 4_000,
      slowest: { stage: "bootstrap_started", ms: 4_000 },
    }),
  ).toEqual(["Launch time", "Not ready: 4.0 s until bootstrap started (slowest: Bootstrap started, 4.0 s)"]);
  expect(launchTimingFact({ epoch: "2", stages: [], ready: false, totalMs: null, slowest: null })).toEqual([
    "Launch time",
    "One stage recorded so far",
  ]);
});
