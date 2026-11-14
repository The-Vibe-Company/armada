import { expect, test } from "bun:test";
import { type AgentEvent, reportedTurnUsage, withUsageTotals } from "@armada/core";
import { createUsagePricingContext } from "@armada/core/server";
import { admittedTurnContexts, stampTurnPricing, withServerCost } from "../src/turn-pricing.ts";

// Same pure extractor/pricing/read projection used by runtime ingestion and Docker status.
// This is not proof that a particular deployed journal has already been ingested.
test("OpenCode journal usage retains its prompt and uncached/cache buckets in the status summary, priced or honestly unknown", () => {
  const events: AgentEvent[] = [
    { id: "running", at: 1, kind: "prompt", promptId: "deepseek-turn", text: "Reply DOCKER_OK", status: "running" },
    {
      id: "usage",
      at: 2,
      kind: "other",
      promptId: "deepseek-turn",
      type: "armada/turnUsage",
      data: {
        model: "armada/deepseek-flash",
        inputTokens: 240,
        cachedTokens: 6272,
        outputTokens: 5,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
    },
    { id: "finished", at: 3, kind: "prompt", promptId: "deepseek-turn", text: "Reply DOCKER_OK", status: "finished" },
  ];
  const observed = reportedTurnUsage(events);
  expect(observed.turnCount).toBe(1);
  expect(observed.turns).toEqual([
    {
      promptId: "deepseek-turn",
      model: "armada/deepseek-flash",
      inputTokens: 240,
      cachedTokens: 6272,
      outputTokens: 5,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
  ]);
  for (const priced of [true, false]) {
    const book = createUsagePricingContext({
      harness: "opencode",
      credentialKind: "opencode",
      customEndpoint: true,
      credentialId: "connection",
      credentialVersion: 1,
      ...(priced
        ? {
            modelPrices: {
              "armada/deepseek-flash": { input: "1", output: "2", cacheRead: "0.5", cacheWrite: "1", reasoning: null },
            },
          }
        : {}),
    });
    const turns = stampTurnPricing(
      observed.turns,
      [],
      observed.turns,
      admittedTurnContexts(book, observed.turns, "opencode"),
      "opencode",
    );
    const statusUsage = withServerCost(
      withUsageTotals({ turnCount: observed.turnCount, turns, computeSeconds: null }),
      "opencode",
    );
    expect(statusUsage?.turns[0]).toMatchObject({
      promptId: "deepseek-turn",
      inputTokens: 240,
      cachedTokens: 6272,
      outputTokens: 5,
    });
    expect(statusUsage?.cost).toMatchObject(
      priced ? { usd: "0.003386", unknown: null, basis: "estimated" } : { usd: null, unknown: "price" },
    );
  }
});
