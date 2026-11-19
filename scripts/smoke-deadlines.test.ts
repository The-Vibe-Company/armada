import { expect, test } from "bun:test";
import { smokeDeadlines } from "./smoke-deadlines.ts";

test("derives p99 headroom from the latest twenty green journals with complete step coverage", () => {
  const journals = Array.from({ length: 21 }, (_, index) =>
    [
      { step: "expiry_launch", elapsedMs: index < 20 ? 100 + index : 10_000, pass: true },
      { step: "expiry_launch", elapsedMs: 30_000, pass: false },
      { step: "sparse_step", elapsedMs: 500, pass: index < 19 },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  expect(smokeDeadlines(journals)).toEqual({ expiry_launch: 179 });
});
