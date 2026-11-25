import { expect, test } from "bun:test";
import { formatLaunchDuration, summarizeLaunch } from "../src/launch-stages.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 17, 15, 0, seconds)).toISOString();

test("summary keeps the latest activation in time order with total and slowest step", () => {
  expect(
    summarizeLaunch([
      { activation: "1", stage: "accepted", at: at(0) },
      { activation: "2", stage: "harness_ready", at: at(50) },
      { activation: "2", stage: "first_token", at: at(59) },
      { activation: "2", stage: "accepted", at: at(2) },
      { activation: "2", stage: "machine_started", at: at(10) },
      // A runtime launch prepares its checkout after enrolment: time order, not catalog order.
      { activation: "2", stage: "checkout_done", at: at(45) },
      { activation: "2", stage: "enrolled", at: at(40) },
      { activation: "2", stage: "unknown", at: at(1) },
    ]),
  ).toEqual({
    activation: "2",
    stages: [
      { stage: "accepted", at: at(2), ms: null },
      { stage: "machine_started", at: at(10), ms: 8_000 },
      { stage: "enrolled", at: at(40), ms: 30_000 },
      { stage: "checkout_done", at: at(45), ms: 5_000 },
      { stage: "harness_ready", at: at(50), ms: 5_000 },
      { stage: "first_token", at: at(59), ms: 9_000 },
    ],
    ready: true,
    totalMs: 48_000,
    slowest: { stage: "enrolled", ms: 30_000 },
  });
  expect(summarizeLaunch([])).toBeNull();
  // An idle launch's first token waits for the first prompt: it never counts toward launch time.
  expect(
    summarizeLaunch([
      { activation: "1", stage: "accepted", at: at(0) },
      { activation: "1", stage: "enrolled", at: at(5) },
      { activation: "1", stage: "first_token", at: at(58) },
    ]),
  ).toMatchObject({ ready: false, totalMs: 5_000, slowest: { stage: "enrolled", ms: 5_000 } });
});

test("formats whole minutes and remaining seconds", () => {
  expect(formatLaunchDuration(95_000)).toBe("1 min 35 s");
});
