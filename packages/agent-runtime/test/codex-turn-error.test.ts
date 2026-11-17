import { expect, test } from "bun:test";
import { codexTurnFailureCode } from "../src/codex-turn-error.ts";

test("a Codex terminal cut by the model output limit names that cause, not a configuration failure", () => {
  expect(codexTurnFailureCode("other", "Incomplete response returned, reason: max_output_tokens")).toBe(
    "output_limit_exceeded",
  );
  // Only the exact closed literal is recognized; other `other` text stays generic and is never published.
  expect(codexTurnFailureCode("other", "Incomplete response returned, reason: content_filter")).toBe("harness_failed");
  expect(codexTurnFailureCode("other", "private upstream details")).toBe("harness_failed");
  expect(codexTurnFailureCode("other", undefined)).toBe("harness_failed");
  expect(codexTurnFailureCode(undefined, "Incomplete response returned, reason: max_output_tokens")).toBe(
    "harness_failed",
  );
});

test("Codex terminal discriminants keep their existing closed reasons", () => {
  expect(codexTurnFailureCode("unauthorized", undefined)).toBe("authentication_failed");
  expect(codexTurnFailureCode("usageLimitExceeded", undefined)).toBe("usage_limit_exceeded");
  expect(codexTurnFailureCode("sessionBudgetExceeded", undefined)).toBe("usage_limit_exceeded");
  expect(codexTurnFailureCode("rateLimitExceeded", undefined)).toBe("rate_limited");
  expect(codexTurnFailureCode("contextWindowExceeded", undefined)).toBe("context_window_exceeded");
  expect(codexTurnFailureCode("internalServerError", undefined)).toBe("harness_failed");
});
