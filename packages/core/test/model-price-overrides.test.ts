import { expect, test } from "bun:test";
import { parseCredentialValue, resolveCredentials, toHarnessCredentials } from "../src/credentials.ts";
import { encryptSecret } from "../src/crypto.ts";

const key = Buffer.alloc(32, 7).toString("base64");
const apiKey = "synthetic-priced-connection-key";
const prices = { "exact/model[1m]": { input: "123.456789", output: "10", cacheRead: "0" } };
const normalized = {
  "exact/model[1m]": { input: "123.456789", output: "10", cacheRead: "0", cacheWrite: null, reasoning: null },
};

test.each(["openai", "anthropic"] as const)(
  "sealed %s connection prices bind to server metadata, never the native env",
  async (kind) => {
    const endpoint =
      kind === "openai"
        ? { version: 1, baseUrl: "https://endpoint.invalid/v1" }
        : { version: 1, baseUrl: "https://gateway.invalid/v1", auth: "bearer" };
    const value = parseCredentialValue(kind, JSON.stringify({ endpoint, apiKey, prices }));
    expect(JSON.parse(value).prices).toEqual(normalized);
    const valueEnc = await encryptSecret(value, key);
    const result = await resolveCredentials(
      {
        credentials: async (scope) => (scope === "user" ? [{ id: "priced", kind, valueEnc, version: 3 }] : []),
        orgBoatKey: async () => null,
      },
      key,
      { userId: "u", orgId: "o", harness: kind === "openai" ? "codex" : "claude", credentialId: "priced" },
    );
    const delivered = toHarnessCredentials(result);
    expect(delivered.binding).toEqual({ credentialId: "priced", credentialVersion: 3 });
    expect(delivered.modelPrices).toEqual(normalized);
    expect(JSON.stringify(delivered.env)).not.toContain("123.456789");
    expect(JSON.stringify(delivered.env)).not.toContain("prices");
    expect(delivered.secrets).not.toContain("123.456789");
  },
);

test.each(
  [
    null,
    [],
    { model: { input: 2, output: "10" } },
    { model: { input: "-1", output: "10" } },
    { model: { input: "1e-3", output: "10" } },
    { model: { input: "1", output: "NaN" } },
    { model: { input: "1", output: "2", tiers: [] } },
    { model: { input: "1" } },
    JSON.parse('{"__proto__":{"input":"1","output":"2"}}'),
    { " model ": { input: "1", output: "2" } },
    { "\u0000model": { input: "1", output: "2" } },
  ].map((bad) => ({ bad })),
)("invalid/ambiguous price data is refused without reflecting values (%j)", ({ bad }) => {
  for (const kind of ["openai", "anthropic"] as const) {
    const endpoint =
      kind === "openai"
        ? { version: 1, baseUrl: "https://endpoint.invalid/v1" }
        : { version: 1, baseUrl: "https://gateway.invalid/v1", auth: "api-key" };
    let message = "";
    try {
      parseCredentialValue(kind, JSON.stringify({ endpoint, apiKey, prices: bad }));
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("Invalid model prices");
    expect(message).not.toContain(apiKey);
  }
});
