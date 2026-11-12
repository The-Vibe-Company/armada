import { expect, test } from "bun:test";
import { providerRateLimitDetails, providerRateLimitMessage } from "../src/provider-limit.ts";

test.each([
  {
    input: { provider: "boat", window: "day", nextStartAt: "2026-11-12T09:08:00+01:00" },
    phrase: "plan start limit per day",
    timing: "2026-11-12T08:08:00.000Z",
  },
  {
    input: { provider: "boat", window: "hour", retryAfterSeconds: 90 },
    phrase: "plan start limit per hour",
    timing: "Wait at least 90 seconds",
  },
  { input: { provider: "boat", window: "day" }, phrase: "plan start limit per day", timing: null },
  {
    input: {
      provider: "fixture-secret",
      window: "fixture-secret",
      nextStartAt: "2026-11-12T08:08:00Z\nfixture-secret",
      retryAfterSeconds: "fixture-secret",
    },
    phrase: "account rate or capacity limit",
    timing: null,
  },
  {
    input: { nextStartAt: "2026-99-99T08:08:00Z", retryAfterSeconds: -1 },
    phrase: "account rate or capacity limit",
    timing: null,
  },
  { input: { retryAfterSeconds: Number.MAX_SAFE_INTEGER }, phrase: "account rate or capacity limit", timing: null },
])("provider limits keep validated timing without upstream text (%#)", ({ input, phrase, timing }) => {
  const message = providerRateLimitMessage(input);
  expect(message).toContain(phrase);
  if (timing) expect(message).toContain(timing);
  else {
    expect(message).not.toContain("available at");
    expect(message).not.toContain("Wait at least");
  }
  expect(JSON.stringify(providerRateLimitDetails(input))).not.toContain("fixture-secret");
  expect(message).not.toContain("fixture-secret");
});
