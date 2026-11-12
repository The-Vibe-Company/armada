import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CLAUDE_ENDPOINT_ENV, parseClaudeEndpoint } from "../src/claude-endpoint.ts";
import { parseCredentialValue, resolveCredentials } from "../src/credentials.ts";
import { encryptSecret } from "../src/crypto.ts";

test.each(["api-key", "bearer"] as const)("sealed Claude gateway resolves a bound account (%s)", async (auth) => {
  const key = Buffer.alloc(32, 9).toString("base64");
  const apiKey = randomUUID();
  const endpoint = { version: 1, baseUrl: "https://gateway.example.com/anthropic", auth };
  const valueEnc = await encryptSecret(
    parseCredentialValue(
      "anthropic",
      JSON.stringify({
        endpoint: { ...endpoint, baseUrl: endpoint.baseUrl + "/" },
        apiKey,
      }),
    ),
    key,
  );
  const result = await resolveCredentials(
    {
      credentials: async (scope) =>
        scope === "user" ? [{ id: "gateway", kind: "anthropic", valueEnc, version: 2 }] : [],
      orgBoatKey: async () => null,
    },
    key,
    { userId: "u", orgId: "o", harness: "claude", credentialId: "gateway" },
  );
  expect(result.env).toEqual({ ANTHROPIC_API_KEY: apiKey, [CLAUDE_ENDPOINT_ENV]: JSON.stringify(endpoint) });
  expect(result.binding).toEqual({ credentialId: "gateway", credentialVersion: 2 });
  expect(result.files).toEqual([]);
  expect(parseCredentialValue("anthropic", apiKey)).toBe(apiKey);
});

test("Claude gateway refuses URL credentials and arbitrary options without reflecting input", () => {
  for (const baseUrl of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com?key=private",
    "https://example.com#private",
  ]) {
    expect(() => parseClaudeEndpoint({ version: 1, baseUrl, auth: "bearer" })).toThrow("Invalid Claude gateway");
  }
  expect(() => parseClaudeEndpoint({ version: 1, baseUrl: "https://example.com", auth: "oauth" })).toThrow();
  expect(() =>
    parseClaudeEndpoint({ version: 1, baseUrl: "https://example.com", auth: "bearer", headers: {} }),
  ).toThrow();
  expect(() => parseClaudeEndpoint({ version: 1, baseUrl: "https://example.com", auth: ["bearer"] })).toThrow();
  expect(() => parseCredentialValue("anthropic", '{"apiKey":"private"}')).toThrow("Claude gateway connection");
});
