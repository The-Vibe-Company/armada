import { expect, test } from "bun:test";
import { formatLaunchDuration, launchReadyPercentiles, summarizeLaunch } from "../src/launch-stages.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 17, 15, 0, seconds)).toISOString();

test("summary keeps the latest activation in stage order with total and slowest step", () => {
  expect(
    summarizeLaunch([
      { epoch: "1", stage: "created", at: at(0) },
      { epoch: "2", stage: "harness_ready", at: at(50) },
      { epoch: "2", stage: "machine_started", at: at(10) },
      { epoch: "2", stage: "enrolled", at: at(40) },
      { epoch: "2", stage: "unknown", at: at(1) },
    ]),
  ).toEqual({
    epoch: "2",
    stages: [
      { stage: "machine_started", at: at(10), ms: null },
      { stage: "enrolled", at: at(40), ms: 30_000 },
      { stage: "harness_ready", at: at(50), ms: 10_000 },
    ],
    totalMs: 40_000,
    slowest: { stage: "enrolled", ms: 30_000 },
  });
  expect(summarizeLaunch([])).toBeNull();
});

test("provider percentiles use only complete first launches", () => {
  const launch = (sandbox_id: string, provider: string, ready: number | null, epoch = "1") => [
    { sandbox_id, provider, epoch, stage: "created", at: at(0) },
    ...(ready === null ? [] : [{ sandbox_id, provider, epoch, stage: "harness_ready", at: at(ready) }]),
  ];
  expect(
    launchReadyPercentiles([
      ...launch("a", "docker", 10),
      ...launch("b", "docker", 20),
      ...launch("c", "docker", 30),
      ...launch("d", "docker", null),
      ...launch("e", "modal", 5),
      { sandbox_id: "e", provider: "modal", epoch: "2", stage: "harness_ready", at: at(59) },
    ]),
  ).toEqual([
    { provider: "docker", count: 3, p50Ms: 20_000, p90Ms: 30_000 },
    { provider: "modal", count: 1, p50Ms: 5_000, p90Ms: 5_000 },
  ]);
  expect(formatLaunchDuration(95_000)).toBe("1 min 35 s");
});
