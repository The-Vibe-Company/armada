import { expect, test } from "bun:test";
import deadlines from "./smoke-deadlines.json";
import { smokeDeadlines } from "./smoke-deadlines.ts";

test("derives p99 headroom from the latest twenty green journals and omits steps with fewer than twenty samples", () => {
  const journals = Array.from({ length: 21 }, (_, index) =>
    [
      { step: "expiry_launch", elapsedMs: index < 20 ? 1_000 + index : 10_000, pass: true },
      { step: "expiry_launch", elapsedMs: 30_000, pass: false },
      { step: "resume_usage", elapsedMs: 200, pass: true },
      { step: "repeated_step", elapsedMs: 40, pass: index < 10 },
      { step: "repeated_step", elapsedMs: 50, pass: index < 10 },
      { step: "sparse_step", elapsedMs: 500, pass: index < 19 },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  expect(smokeDeadlines(journals)).toEqual({ expiry_launch: 2038, repeated_step: 2000, resume_usage: 5000 });
});

test("every checked-in smoke deadline meets its floor", () => {
  expect(
    Object.entries(deadlines).filter(
      ([step, deadline]) => deadline < (step === "usage" || step === "resume_usage" ? 5_000 : 2_000),
    ),
  ).toEqual([]);
});
