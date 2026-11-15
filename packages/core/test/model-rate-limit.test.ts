import { expect, test } from "bun:test";
import { modelRateLimit } from "../src/model-rate-limit.ts";
import type { AgentEvent } from "../src/provider.ts";

test("rate-limit status follows the target turn and stops waiting after progress or expiry", () => {
  const events: AgentEvent[] = [
    {
      id: "wait",
      at: 1000,
      promptId: "turn",
      kind: "other",
      type: "armada/modelRateLimit",
      data: { retryCount: 2, delayMs: 20_000, totalWaitMs: 21_000 },
    },
    {
      id: "other",
      at: 2000,
      promptId: "different",
      kind: "other",
      type: "armada/modelRateLimit",
      data: { retryCount: 99, delayMs: 1000, totalWaitMs: 1000 },
    },
  ];
  expect(modelRateLimit(events, "turn", 2000)).toEqual({
    retryCount: 2,
    delayMs: 20_000,
    totalWaitMs: 21_000,
    retryAt: 21_000,
    waiting: true,
    message: "Rate limited by the model provider, retrying in 19 s",
  });
  expect(modelRateLimit(events, "turn", 21_000)?.waiting).toBe(false);
  expect(modelRateLimit(events, "turn", 2000, false)?.waiting).toBe(false);
  events.push({
    id: "progress",
    at: 3000,
    promptId: "turn",
    kind: "message",
    text: "Working",
    partial: true,
    tools: [],
  });
  expect(modelRateLimit(events, "turn", 3000)?.waiting).toBe(false);
});

test("malformed backoff telemetry cannot become a visible wait", () => {
  const event: AgentEvent = {
    id: "bad",
    at: 1000,
    promptId: "turn",
    kind: "other",
    type: "armada/modelRateLimit",
    data: { retryCount: 1, delayMs: "20000", totalWaitMs: Infinity },
  };
  expect(modelRateLimit([event], "turn", 2000)).toBeNull();
});

test("an ambiguous native model retry stays visible without claiming a provider rate limit", () => {
  const event: AgentEvent = {
    id: "retry",
    at: 1000,
    promptId: "turn",
    kind: "other",
    type: "armada/modelRateLimit",
    data: { retryCount: 1, delayMs: 20000, totalWaitMs: 20000, reason: "model_provider_retry" },
  };
  expect(modelRateLimit([event], "turn", 2000)).toMatchObject({
    waiting: true,
    message: "Model provider request retrying in 19 s",
  });
  expect(modelRateLimit([event], "turn", 21000)).toMatchObject({
    waiting: false,
    message: "Model provider retry wait completed",
  });
});
