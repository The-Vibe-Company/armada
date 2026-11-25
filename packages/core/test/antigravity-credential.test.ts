import { expect, test } from "bun:test";
import { parseAntigravityCredential } from "@armada/core/antigravity-credential";

const google = {
  method: "google" as const,
  token: { access_token: "access", refresh_token: "refresh" },
};
const gemini = { method: "gemini-api-key" as const, apiKey: "key" };

test("accepts a Google token pair and preserves optional Go OAuth2 metadata", () => {
  const native = {
    ...google,
    token: { ...google.token, expiry: "2026-11-20T18:00:00.123456789+00:00", token_type: "Bearer", expires_in: 3599 },
  };
  expect(parseAntigravityCredential(google)).toEqual(google);
  expect(parseAntigravityCredential(native)).toEqual(native);
});

test("accepts a Gemini API key", () => {
  expect(parseAntigravityCredential(gemini)).toEqual(gemini);
});

test.each([
  ["unsupported method", { ...gemini, method: "agent-platform" }],
  ["mixed account methods", { ...google, apiKey: "key" }],
  ["missing refresh token", { ...google, token: { access_token: "access" } }],
  ["invalid expiry", { ...google, token: { ...google.token, expiry: "later" } }],
  ["unexpected token field", { ...google, token: { ...google.token, client_secret: "private" } }],
  ["empty key", { ...gemini, apiKey: "" }],
  ["oversized token", { ...google, token: { ...google.token, refresh_token: "r".repeat(8193) } }],
  ["control character", { ...gemini, apiKey: "first\u0000second" }],
  ["malformed Unicode", { ...gemini, apiKey: "\uD800" }],
  ["multiline key", { ...gemini, apiKey: "first\nsecond" }],
])("rejects %s with a fixed public error", (_label, input) => {
  expect(() => parseAntigravityCredential(input)).toThrow(
    expect.objectContaining({
      name: "VaultError",
      code: "invalid",
      message: "Invalid Antigravity credential. Supply a Google token pair or a Gemini API key.",
    }),
  );
});
