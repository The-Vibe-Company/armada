import { expect, test } from "bun:test";
import { redact } from "../src/credentials.ts";
import { redactKnownTokens } from "../src/index.ts";

const recognized = [
  ...["ghu", "ghr", "ghs", "gho", "ghp"].map((prefix) => `${prefix}_${"A".repeat(36)}`),
  `github_pat_${"A".repeat(82)}`,
  `armada_gw_${"aB0_-".repeat(8)}`,
  `cmp_pat_${"a1".repeat(24)}`,
];

test.each(recognized)("masks recognized token %s wherever it appears", (token) => {
  expect(redactKnownTokens(`failed: ${token}, retry ${token}`)).toBe("failed: ***, retry ***");
});

test.each([
  "GitHub request failed: repository not found",
  "ghu_short github_pat_short armada_gw_short cmp_pat_short",
  `cmp_pat_${"G".repeat(48)}`,
  `cmp_pat_${"a".repeat(47)}`,
])("preserves non-token diagnostics: %s", (text) => {
  expect(redactKnownTokens(text)).toBe(text);
});

test("output redaction combines known tokens with longest-first exact secrets", () => {
  expect(redact(`cmp_pat_${"a".repeat(48)} secret-long secret secret-long`, ["secret", "", "secret-long"])).toBe(
    "*** *** *** ***",
  );
});
