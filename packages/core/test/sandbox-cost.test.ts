import { describe, expect, test } from "bun:test";
import { costBasis, MODEL_CATALOG, MODEL_PRICES, modelPrice, sandboxCost, turnCost } from "../src/index.ts";

const turn = (model: string | null, input: number | null, cached: number | null, output: number | null, id = "p1") => ({
  promptId: id,
  model,
  inputTokens: input,
  cachedTokens: cached,
  outputTokens: output,
});

describe("model prices", () => {
  test("every model Armada offers at launch, and Fable 5.2, has a price", () => {
    const offered = Object.values(MODEL_CATALOG).flatMap((harness) => harness.models.map((model) => model.id));
    for (const id of [...offered, "claude-fable-5-2"]) expect(modelPrice(id)).not.toBeNull();
  });

  test("a context-window suffix or a dated snapshot resolves to the model; anything else is unknown", () => {
    expect(modelPrice("claude-opus-5-5[1m]")).toBe(MODEL_PRICES["claude-opus-5-5"] ?? null);
    expect(modelPrice("claude-sonnet-5-5-20261001")).toBe(MODEL_PRICES["claude-sonnet-5-5"] ?? null);
    expect(modelPrice("claude-haiku-5-5")).toBeNull();
    expect(modelPrice("toString")).toBeNull();
    expect(modelPrice(null)).toBeNull();
  });
});

describe("cost", () => {
  test("Claude input excludes cache reads: each counter is priced at its own rate", () => {
    // Opus 5.5: $4 input, $0.20 cache read, $20 output per million.
    const cost = turnCost(turn("claude-opus-5-5", 1_000_000, 2_000_000, 100_000));
    expect(cost).toMatchObject({ inputTokens: 1_000_000, cachedTokens: 2_000_000, unknown: null });
    expect(cost.usd).toBeCloseTo(4 + 0.4 + 2, 10);
  });

  test("Codex cached input is part of its input: only the rest is priced as uncached", () => {
    // GPT-6.1 Sol: $2 input, $0.10 cached, $10 output per million.
    const cost = turnCost(turn("gpt-6.1-sol", 1_000_000, 600_000, 100_000));
    expect(cost).toMatchObject({ inputTokens: 400_000, cachedTokens: 600_000 });
    expect(cost.usd).toBeCloseTo(0.8 + 0.06 + 1, 10);
  });

  test("an unknown model or a missing counter is unknown, never zero, and left out of the total", () => {
    expect(turnCost(turn("claude-haiku-5-5", 10, 0, 10))).toMatchObject({ usd: null, unknown: "price" });
    expect(turnCost(turn("gpt-6.1-sol", null, null, null))).toMatchObject({ usd: null, unknown: "tokens" });
    const cost = sandboxCost(
      {
        computeSeconds: 90,
        turnCount: 2,
        turns: [turn("claude-sonnet-5-5", 1_000_000, 0, 0, "a"), turn("mystery-model", 5, 0, 5, "b")],
      },
      "estimated",
    );
    expect(cost.usd).toBeCloseTo(2, 10);
    expect(cost).toMatchObject({ unpricedTurns: 1, turnCount: 2, computeSeconds: 90 });
    expect(cost.tokens).toEqual({ input: 1_000_005, cached: 0, output: 5 });
    expect(cost.models).toEqual(["claude-sonnet-5-5", "mystery-model"]);
    expect(
      sandboxCost({ computeSeconds: null, turnCount: 1, turns: [turn("x", 1, 0, 1)] }, "estimated").usd,
    ).toBeNull();
  });

  test("no usage recorded is no turn and no figure", () => {
    expect(sandboxCost(null, "estimated")).toMatchObject({ usd: null, turns: [], turnCount: 0, computeSeconds: null });
  });

  test("a subscription account's figure is API-equivalent; an API key's is estimated", () => {
    expect(costBasis("claude_oauth")).toBe("api_equivalent");
    expect(costBasis("codex_auth")).toBe("api_equivalent");
    expect(costBasis("anthropic")).toBe("estimated");
    expect(costBasis("openai")).toBe("estimated");
    expect(costBasis(null)).toBe("estimated");
    expect(sandboxCost(null, "api_equivalent").label).toBe("API-equivalent cost");
    expect(sandboxCost(null, "estimated").label).toBe("Estimated cost");
  });
});
