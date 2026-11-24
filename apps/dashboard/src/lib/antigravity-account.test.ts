import { expect, test } from "bun:test";
import { antigravityMethod, googleCode, googleSignInFailure } from "./antigravity-account";

test("Antigravity accepts only the two available connection methods", () => {
  expect(antigravityMethod("google")).toBe("google");
  expect(antigravityMethod("gemini-api-key")).toBe("gemini-api-key");
  expect(antigravityMethod("other")).toBeUndefined();
});

test("Google sign-in accepts a single pasted code or callback URL", () => {
  expect(googleCode(" example-code ")).toBe("example-code");
  const callback = "https://antigravity.google/oauth-callback?code=example&state=example";
  expect(googleCode(callback)).toBe(callback);
  expect(googleCode("example\ncode")).toBeNull();
  expect(googleCode(" ")).toBeNull();
  expect(googleCode("x".repeat(8193))).toBeNull();
});

test("Google sign-in asks for a replacement login when the code is expired or foreign", () => {
  expect(googleSignInFailure("complete", 404, "not_found")).toBe(
    "That Google code is invalid or expired. Get a new code.",
  );
  expect(googleSignInFailure("complete", 400, "invalid")).toContain("matching Google sign-in");
});
