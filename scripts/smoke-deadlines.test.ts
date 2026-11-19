import { expect, test } from "bun:test";
import { smokeDeadlines } from "./smoke-deadlines.ts";

test("derives p99 headroom from the latest twenty green journals and omits steps with fewer than twenty samples", () => {
  const journals = Array.from({ length: 21 }, (_, index) =>
    [
      { step: "expiry_launch", elapsedMs: index < 20 ? 100 + index : 10_000, pass: true },
      { step: "expiry_launch", elapsedMs: 30_000, pass: false },
      { step: "repeated_step", elapsedMs: 40, pass: index < 10 },
      { step: "repeated_step", elapsedMs: 50, pass: index < 10 },
      { step: "sparse_step", elapsedMs: 500, pass: index < 19 },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  expect(smokeDeadlines(journals)).toEqual({ expiry_launch: 179, repeated_step: 75 });
});
