import { expect, test } from "bun:test";
import { redactForLog } from "../src/log.ts";

test.each([
  ["Authorization: BeArEr opaque-value", "Authorization: BeArEr ***"],
  ["jwt eyJhbGciOiJIUzI1NiJ9.payload.signature rejected", "jwt *** rejected"],
  ["postgres://user:password@db:5432/name failed", "postgres://***@db:5432/name failed"],
  ["armada_access_abcdefgh sk-abcdefgh sb_abcdefgh", "*** *** ***"],
])("preserves log-specific masking: %s", (input, expected) => {
  expect(redactForLog(input)).toBe(expected);
});

test("log redaction uses the shared known-token policy before truncation", () => {
  const token = `ghu_${"A".repeat(36)}`;
  expect(redactForLog(`${token} cmp_pat_${"a".repeat(48)} failed`)).toBe("*** *** failed");
  expect(redactForLog(`${"x".repeat(596)} ${token}`)).toBe(`${"x".repeat(596)} ***`);
});

test("keeps safe diagnostics and truncates only beyond 600 masked characters", () => {
  expect(redactForLog("repository unavailable; retry later")).toBe("repository unavailable; retry later");
  expect(redactForLog("x".repeat(600))).toBe("x".repeat(600));
  expect(redactForLog("x".repeat(601))).toBe(`${"x".repeat(600)}...`);
});
