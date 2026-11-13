import { expect, test } from "bun:test";
import type { TurnPriceContext, TurnTokenUsage } from "@armada/core";
import { resolvePrice } from "@armada/core/server";
import { stampTurnPricing, withServerCost } from "../src/turn-pricing.ts";

test("Claude one-hour quote survives persisted witness replay and contributes to session cost", () => {
  const row: TurnTokenUsage = {
    promptId: "p",
    model: "claude-opus-5-5",
    inputTokens: 2,
    outputTokens: 4,
    cachedTokens: 0,
    cacheWriteTokens: 19058,
    reasoningTokens: 0,
    cacheWriteTokensByTtl: { fiveMinute: 0, oneHour: 19058 },
  };
  const context: TurnPriceContext = {
    schemaVersion: 1,
    promptId: "p",
    model: row.model,
    basis: "api_equivalent",
    credentialId: "credential",
    credentialVersion: 1,
    capturedAt: "2026-11-13T00:00:00Z",
    snapshot: resolvePrice({ provider: "anthropic", model: row.model, customEndpoint: false }),
  };
  const quoted = stampTurnPricing([row], [], [row], [context], "claude");
  const replayed = stampTurnPricing(quoted, JSON.parse(JSON.stringify(quoted)), [], [], "claude");
  expect(replayed[0]?.pricing).toMatchObject({ usd: "0.152552", unknown: null });
  expect(withServerCost({ turnCount: 1, turns: replayed, computeSeconds: 0 }, "claude")?.cost).toMatchObject({
    usd: "0.152552",
    basis: "api_equivalent",
    unpricedTurns: 0,
  });
});

test("new partial TTL evidence cannot reuse a legacy default-rate quote", () => {
  const row: TurnTokenUsage = {
    promptId: "p",
    model: "claude-opus-5-5",
    inputTokens: 2,
    outputTokens: 4,
    cachedTokens: 0,
    cacheWriteTokens: 10,
    reasoningTokens: 0,
  };
  const context: TurnPriceContext = {
    schemaVersion: 1,
    promptId: "p",
    model: row.model,
    basis: "api_equivalent",
    credentialId: "credential",
    credentialVersion: 1,
    capturedAt: "2026-11-13T00:00:00Z",
    snapshot: resolvePrice({ provider: "anthropic", model: row.model, customEndpoint: false }),
  };
  const old = stampTurnPricing([row], [], [row], [context], "claude");
  expect(old[0]?.pricing?.usd).toBe("0.000138");
  const partial = { ...row, cacheWriteTokensByTtl: { fiveMinute: null, oneHour: 0 } };
  const next = stampTurnPricing([partial], old, [partial], [], "claude");
  expect(next[0]?.pricing).toMatchObject({ usd: null, unknown: "pricing_dimensions" });
});
