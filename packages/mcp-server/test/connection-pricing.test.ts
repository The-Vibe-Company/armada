import { expect, test } from "bun:test";
import { encryptSecret, parseCredentialValue } from "@armada/core";
import { priceTurn } from "@armada/core/server";
import { launchCredentials } from "../src/launch-credentials.ts";

const key = Buffer.alloc(32, 7).toString("base64");

test.each([
  { kind: "openai", harness: "codex", provider: "openai", usd: "0.00467" },
  { kind: "anthropic", harness: "claude", provider: "anthropic", usd: "0.00527" },
  { kind: "opencode", harness: "opencode", provider: "openai", usd: "0.00527" },
] as const)("$kind connection rates reach immutable launch admission", async ({ kind, harness, provider, usd }) => {
  const model = "exact/model[1m]";
  const value = parseCredentialValue(
    kind,
    JSON.stringify({
      endpoint: {
        version: 1,
        baseUrl: "https://endpoint.invalid/v1",
        ...(kind === "opencode" ? { models: [model] } : {}),
        ...(kind === "anthropic" ? { auth: "bearer" } : {}),
      },
      apiKey: "synthetic-priced-connection-key",
      prices: { [model]: { input: "2", output: "10", cacheRead: "0.1", cacheWrite: "2.5" } },
    }),
  );
  let valueEnc = await encryptSecret(value, key);
  let version = 3;
  const resolver = launchCredentials(
    {
      credentials: async (scope) => (scope === "user" ? [{ id: "priced", kind, valueEnc, version }] : []),
      orgBoatKey: async () => null,
    },
    key,
  );
  const resolve = () => resolver.resolve({ userId: "u", orgId: "o" }, harness, "priced");
  const admitted = (await resolve()).usagePricing!;
  const snapshot = admitted.prices[model];
  expect(snapshot).toMatchObject({ source: "connection", connectionId: "priced", revision: "3", model, provider });
  expect(admitted).toMatchObject({ credentialId: "priced", credentialVersion: 3, customEndpoint: true });
  const turn = {
    promptId: "p",
    model,
    inputTokens: 1000,
    cachedTokens: 200,
    cacheWriteTokens: 100,
    outputTokens: 300,
    reasoningTokens: 100,
  };
  expect(priceTurn(turn, harness, snapshot ?? null).usd).toBe(usd);
  expect(priceTurn({ ...turn, model: `${model}-alias` }, harness, snapshot ?? null).unknown).toBe("price");
  expect(admitted.prices[`${model}-alias`]).toBeUndefined();
  // Editing a connection affects future admissions only, never an existing session's book.
  const edited = JSON.parse(value);
  edited.prices[model].input = "99";
  valueEnc = await encryptSecret(JSON.stringify(edited), key);
  version = 4;
  expect((await resolve()).usagePricing?.prices[model]?.rates.input).toBe("99");
  expect(snapshot?.rates.input).toBe("2");
  expect(priceTurn(turn, harness, snapshot ?? null).usd).toBe(usd);
});
