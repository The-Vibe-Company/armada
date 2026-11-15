import { expect, test } from "bun:test";
import { modelRetryDelay, modelThrottle } from "../src/model-rate-limit.ts";

// Retry-After parsing is independently owned here; drivers must not interpret private provider text.
test("model backoff honors Retry-After seconds/date against a fake clock and caps request delays", () => {
  const now = Date.UTC(2026, 10, 15);
  expect(modelRetryDelay(8, 1, "20", now)).toBe(20_000);
  expect(modelRetryDelay(8, 1, new Date(now + 30_000).toUTCString(), now)).toBe(30_000);
  expect(modelRetryDelay(8, 1, "9999", now)).toBe(300_000);
  expect(modelRetryDelay(2, 0, "invalid", now)).toBe(2_000);
  expect(modelRetryDelay(2, 1, new Date(now - 1_000).toUTCString(), now)).toBe(4_000);
  expect(modelRetryDelay(8, 1, "0", now)).toBe(0);
});

test("throttle classification accepts structured 429/529 metadata, not arbitrary error text", () => {
  expect(modelThrottle({ data: { statusCode: 429, responseHeaders: { "retry-after": "20" } } })).toEqual({
    retryAfter: "20",
  });
  expect(modelThrottle({ data: { status: 529 } })).toEqual({});
  expect(modelThrottle({ code: -32603, message: "429 in model answer" })).toBeUndefined();
  expect(modelThrottle({ data: { statusCode: 401 } })).toBeUndefined();
});
