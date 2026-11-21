import { expect, test } from "bun:test";
import { deadlinesFor, smokeDeadlines } from "./smoke-deadlines.ts";

test("uses the latest twenty green journals and requires twenty successful positive receipts", () => {
  const journals = Array.from({ length: 21 }, (_, index) =>
    [
      { step: "launch", elapsedMs: index < 20 ? 1_000 + index : 10_000, pass: true },
      { step: "launch", elapsedMs: 30_000, pass: false },
      { step: "resume_usage", elapsedMs: 200, pass: true },
      { step: "sparse", elapsedMs: index < 19 ? 500 : 0, pass: true },
    ]
      .map((row) => JSON.stringify({ ...row, provider: "modal", lane: "lifecycle" }))
      .join("\n"),
  );
  expect(smokeDeadlines(journals)).toEqual({ "modal/lifecycle": { launch: 2038, resume_usage: 5000 } });
});

test("each provider and lane must qualify independently", () => {
  const journals = Array.from({ length: 20 }, (_, index) =>
    [
      { provider: "modal", lane: "real-model", elapsedMs: 1_500 },
      { provider: "docker", lane: "real-model", elapsedMs: 20_112 },
      { provider: "modal", lane: "lifecycle", elapsedMs: 2_800 },
      { lane: "real-model", elapsedMs: 40_000 },
      ...(index < 10 ? [{ provider: "docker", lane: "parity", elapsedMs: 45_000 }] : []),
      ...(index < 10 ? [{ provider: "modal", lane: "parity", elapsedMs: 1_000 }] : []),
    ]
      .map((row) => JSON.stringify({ ...row, step: "real_model_ready", pass: true }))
      .join("\n"),
  );
  expect(smokeDeadlines(journals)).toEqual({
    "modal/real-model": { real_model_ready: 3000 },
    "docker/real-model": { real_model_ready: 60000 },
    "modal/lifecycle": { real_model_ready: 5600 },
  });
});

test("lookup ignores unscoped budgets and budgets from other providers or lanes", () => {
  const table = {
    ...JSON.parse('{"ready":1000}'),
    "modal/real-model": { ready: 2000 },
    "docker/parity": { ready: 4000 },
  };
  expect(deadlinesFor(table, "docker", "real-model").ready).toBeUndefined();
});
