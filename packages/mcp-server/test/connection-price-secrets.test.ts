import { expect, test } from "bun:test";
import { type CredentialReader, encryptSecret, parseCredentialValue } from "@armada/core/server";
import { exposedSecrets, launchCredentials } from "../src/launch-credentials.ts";

// The actual resolver/redactor owns secret isolation; native endpoint JSON remains unchanged.
test.each(["openai", "anthropic"] as const)(
  "%s price strings do not become model credentials or standalone redaction secrets",
  async (kind) => {
    const key = Buffer.alloc(32, 5).toString("base64"),
      apiKey = "synthetic-bound-price-key";
    const endpoint =
      kind === "openai"
        ? { version: 1, baseUrl: "https://prices.invalid/v1" }
        : { version: 1, baseUrl: "https://prices.invalid/v1", auth: "api-key" };
    const value = parseCredentialValue(
      kind,
      JSON.stringify({ endpoint, apiKey, prices: { "model-id": { input: "123.456789", output: "0" } } }),
    );
    const valueEnc = await encryptSecret(value, key);
    const reader: CredentialReader = {
      credentials: async (scope) => (scope === "user" ? [{ id: "priced", kind, valueEnc, version: 4 }] : []),
      orgBoatKey: async () => null,
    };
    const secrets = await exposedSecrets(reader, key, { userId: "u", orgId: "o" });
    expect(secrets).toContain(apiKey);
    expect(secrets).toContain(value);
    expect(secrets).toContain(endpoint.baseUrl);
    expect(secrets).not.toContain("123.456789");
    const resolved = await launchCredentials(reader, key).resolve(
      { userId: "u", orgId: "o", role: "member" },
      kind === "openai" ? "codex" : "claude",
      "priced",
      4,
    );
    expect(resolved.modelPrices).toMatchObject({ "model-id": { input: "123.456789", output: "0", cacheRead: null } });
    expect(
      JSON.parse(resolved.env[kind === "openai" ? "ARMADA_CODEX_ENDPOINT" : "ARMADA_CLAUDE_ENDPOINT"] ?? "null"),
    ).toEqual(endpoint);
  },
);
