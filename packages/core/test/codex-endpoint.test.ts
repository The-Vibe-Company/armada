import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CODEX_ENDPOINT_ENV, parseCodexEndpoint } from "../src/codex-endpoint.ts";
import { parseCredentialValue, resolveCredentials } from "../src/credentials.ts";
import { encryptSecret } from "../src/crypto.ts";

test("sealed named OpenAI connections resolve normalized Responses endpoints without changing API-key accounts", async () => {
  const encryptionKey = Buffer.alloc(32, 7).toString("base64");
  const apiKey = randomUUID();
  const base = "https://resource.services.ai.azure.com/api/projects/project/openai/v1";
  for (const suffix of ["", "/responses", "/responses/"]) {
    const value = parseCredentialValue(
      "openai",
      JSON.stringify({ endpoint: { version: 1, baseUrl: base + suffix }, apiKey }),
    );
    const sealed = await encryptSecret(value, encryptionKey);
    const resolved = await resolveCredentials(
      {
        credentials: async (scope) =>
          scope === "user" ? [{ id: "account", kind: "openai", valueEnc: sealed, version: 3 }] : [],
        orgBoatKey: async () => null,
      },
      encryptionKey,
      { userId: "u", orgId: "o", harness: "codex", credentialId: "account" },
    );
    expect(resolved.env).toEqual({
      OPENAI_API_KEY: apiKey,
      [CODEX_ENDPOINT_ENV]: JSON.stringify({ version: 1, baseUrl: base }),
    });
    expect(resolved.binding).toEqual({ credentialId: "account", credentialVersion: 3 });
    expect(resolved.files).toEqual([]);
  }
  expect(parseCredentialValue("openai", apiKey)).toBe(apiKey);
});

test("endpoint validation rejects credentials in URLs, query strings and untyped options without reflecting input", () => {
  for (const baseUrl of [
    "http://example.com/v1",
    "https://user:password@example.com/v1",
    "https://example.com/v1?key=private",
    "https://example.com/v1#private",
  ]) {
    expect(() => parseCodexEndpoint({ version: 1, baseUrl })).toThrow("Invalid Codex endpoint");
  }
  expect(() => parseCodexEndpoint({ version: 1, baseUrl: "https://example.com/v1", headers: {} })).toThrow();
  expect(() => parseCredentialValue("openai", '{"apiKey":"private"}')).toThrow("custom OpenAI connection");
});
