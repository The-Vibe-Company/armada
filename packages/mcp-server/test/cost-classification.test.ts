import { expect, test } from "bun:test";
import type { TurnTokenUsage } from "@armada/core";
import { createUsagePricingContext } from "@armada/core/server";
import { admittedTurnContexts, stampTurnPricing, withServerCost } from "../src/turn-pricing.ts";

// Owns the admission-to-persisted-quote billing contract, without DB/provider calls.
test.each([
  { harness: "codex", kind: "openai", custom: false, model: "gpt-5.4", classification: "priced" },
  { harness: "codex", kind: "codex_auth", custom: false, model: "gpt-5.4", classification: "included_in_subscription" },
  { harness: "codex", kind: "codex_auth", custom: true, model: "unpriced", classification: "included_in_subscription" },
  {
    harness: "claude",
    kind: "claude_oauth",
    custom: true,
    model: "unpriced",
    classification: "included_in_subscription",
  },
  { harness: "opencode", kind: "openai", custom: false, model: "gpt-5.4", classification: "unknown" },
  { harness: "codex", kind: "openai", custom: true, model: "unpriced", classification: "unknown" },
] as const)(
  "classifies $harness/$kind custom=$custom without inventing a subscription bill",
  ({ harness, kind, custom, model, classification }) => {
    const turn: TurnTokenUsage = {
      promptId: "turn",
      model,
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    const book = createUsagePricingContext({
      harness,
      credentialKind: kind,
      credentialId: "account",
      credentialVersion: 1,
      customEndpoint: custom,
    });
    const contexts = admittedTurnContexts(book, [turn], harness);
    const turns = stampTurnPricing([turn], [], [turn], contexts, harness);
    const replay = JSON.parse(JSON.stringify(turns));
    const cost = withServerCost({ turnCount: 1, turns: replay, computeSeconds: 0 }, harness)?.cost;
    expect(cost).toMatchObject({ classification, currency: "USD", basis: book.basis });
    const priced = !custom && harness !== "opencode";
    expect(cost).toMatchObject({ unknown: priced ? null : "price", unpricedTurns: priced ? 0 : 1 });
    expect(cost?.usd === null).toBe(!priced);
    expect(withServerCost({ turnCount: 2, turns: replay, computeSeconds: 0 }, harness)?.cost).toMatchObject({
      classification: "unknown",
      unknown: "coverage",
      usd: null,
    });
    expect(
      withServerCost({ turnCount: 1, turns: [{ ...turn, pricing: null }], computeSeconds: 0 }, harness)?.cost,
    ).toMatchObject({ classification: "unknown", unknown: "admission", usd: null });
    // Legacy API-equivalent metadata alone is not proof of a subscription.
    const legacyBook = { ...book };
    delete legacyBook.billing;
    const legacy = stampTurnPricing([turn], [], [turn], admittedTurnContexts(legacyBook, [turn], harness), harness);
    expect(withServerCost({ turnCount: 1, turns: legacy, computeSeconds: 0 }, harness)?.cost?.classification).not.toBe(
      "included_in_subscription",
    );
  },
);
