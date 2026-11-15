import { expect, test } from "bun:test";
import { codexRateLimited, codexRetryDelay } from "../src/codex-rate-limit.ts";

test("Codex retries only transient model throttles, with capped jittered delays", () => {
  for (const info of [
    "rateLimitExceeded",
    "serverOverloaded",
    { httpConnectionFailed: { httpStatusCode: 429 } },
    { responseTooManyFailedAttempts: { httpStatusCode: 529 } },
  ])
    expect(codexRateLimited(info)).toBe(true);
  for (const info of [
    "usageLimitExceeded",
    "unauthorized",
    undefined,
    { httpConnectionFailed: { httpStatusCode: 401 } },
  ])
    expect(codexRateLimited(info)).toBe(false);
  expect([0, 1, 2, 20].map((attempt) => codexRetryDelay(attempt, 1))).toEqual([1000, 2000, 4000, 300000]);
  expect(codexRetryDelay(0, 0)).toBe(500);
});
