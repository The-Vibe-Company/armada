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
