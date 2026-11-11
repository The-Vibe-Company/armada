import { describe, expect, test } from "bun:test";
import {
  combineCosts,
  costBasis,
  MODEL_CATALOG,
  MODEL_PRICES,
  modelPrice,
  sandboxCost,
  turnCost,
} from "../src/index.ts";

const turn = (model: string | null, input: number | null, cached: number | null, output: number | null, id = "p1") => ({
  promptId: id,
  model,
  inputTokens: input,
  cachedTokens: cached,
  outputTokens: output,
  cacheWriteTokens: 0,
});

describe("model prices", () => {
  test("every model Armada offers at launch, and Fable 5.2, has a price", () => {
    const offered = Object.values(MODEL_CATALOG).flatMap((harness) => harness.models.map((model) => model.id));
    for (const id of [...offered, "claude-fable-5-2"]) expect(modelPrice(id)).not.toBeNull();
  });

  test("a context-window suffix or a dated snapshot resolves to the model; anything else is unknown", () => {
    expect(modelPrice("claude-opus-5-5[1m]")).toBe(MODEL_PRICES["claude-opus-5-5"] ?? null);
    expect(modelPrice("claude-sonnet-5-5-20261001")).toBe(MODEL_PRICES["claude-sonnet-5-5"] ?? null);
    expect(modelPrice("claude-haiku-4-5")).toBeNull();
    expect(modelPrice("toString")).toBeNull();
    expect(modelPrice(null)).toBeNull();
  });
});

describe("cost", () => {
  test("Claude input excludes cache reads: each counter is priced at its own rate", () => {
    // Opus 5.5: $4 input, $0.20 cache read, $20 output per million.
    const cost = turnCost(turn("claude-opus-5-5", 1_000_000, 2_000_000, 100_000), "claude");
    expect(cost).toMatchObject({ inputTokens: 1_000_000, cachedTokens: 2_000_000, unknown: null });
    expect(cost.usd).toBeCloseTo(4 + 0.4 + 2, 10);
  });

  test("Codex cached input is part of its input: only the rest is priced as uncached", () => {
    // GPT-6.1 Sol: $2 input, $0.10 cached, $10 output per million.
    const cost = turnCost(turn("gpt-6.1-sol", 1_000_000, 600_000, 100_000), "codex");
    expect(cost).toMatchObject({ inputTokens: 1_000_000, cachedTokens: 600_000 });
    expect(cost.usd).toBeCloseTo(0.8 + 0.06 + 1, 10);
  });

  test("an unknown model or a missing counter is unknown, never zero, and left out of the total", () => {
    expect(turnCost(turn("claude-haiku-4-5", 10, 0, 10), "claude")).toMatchObject({ usd: null, unknown: "price" });
    // Cache semantics follow the harness, not the price: an unpriced Codex model still preserves its reported input.
    expect(turnCost(turn(null, 100, 60, 1), "codex")).toMatchObject({
      inputTokens: 100,
      cachedTokens: 60,
      unknown: "price",
    });
    expect(turnCost(turn("gpt-6.1-sol", null, null, null), "codex")).toMatchObject({ usd: null, unknown: "tokens" });
    const cost = sandboxCost(
      {
        computeSeconds: 90,
        turnCount: 2,
        turns: [
          turn("claude-sonnet-5-5", 1_000_000, 0, 0, "a"),
          turn("mystery-model", 5, 0, 5, "b"),
          turn("other-mystery", 5, 0, 5, "b"),
        ],
      },
      "claude",
      "estimated",
    );
    expect(cost.usd).toBeCloseTo(2, 10);
    expect(cost).toMatchObject({ unpricedTurns: 1, turnCount: 2, computeSeconds: 90 });
    expect(cost.tokens).toEqual({ input: 1_000_010, cached: 0, cacheWrite: 0, output: 10 });
    expect(cost.models).toEqual(["claude-sonnet-5-5", "mystery-model", "other-mystery"]);
    expect(
      sandboxCost({ computeSeconds: null, turnCount: 1, turns: [turn("x", 1, 0, 1)] }, "claude", "estimated").usd,
    ).toBeNull();
  });

  test("missing fields or whole turns keep token totals unknown, including combined costs", () => {
    const completeTurn = { ...turn("gpt-6.1-sol", 100, 20, 5), cacheWriteTokens: 0 };
    const complete = {
      computeSeconds: 1,
      turnCount: 1,
      turns: [completeTurn],
    };
    const partial = sandboxCost(
      { ...complete, turns: [{ ...completeTurn, outputTokens: null }] },
      "codex",
      "estimated",
    );
    expect(partial.tokens).toEqual({ input: 100, cached: 20, cacheWrite: 0, output: null });
    const missingTurn = sandboxCost({ ...complete, turnCount: 2 }, "codex", "estimated");
    expect(missingTurn.tokens).toEqual({ input: null, cached: null, cacheWrite: null, output: null });
    expect(missingTurn.unpricedTurns).toBe(1);
    expect(combineCosts([sandboxCost(complete, "codex", "estimated"), partial]).tokens.output).toBeNull();
    expect(sandboxCost({ ...complete, turnCount: 1, turns: [] }, "codex", "estimated").tokens.input).toBeNull();
  });

  test.each([
    {
      harness: "claude" as const,
      model: "claude-opus-5-5",
      input: 1_000_000,
      cached: 200_000,
      writes: 300_000,
      expectedInput: 1_000_000,
      usd: 4 + 0.04 + 1.5 + 2,
    },
    {
      harness: "codex" as const,
      model: "gpt-6.1-sol",
      input: 1_000_000,
      cached: 200_000,
      writes: 300_000,
      expectedInput: 1_000_000,
      usd: 1 + 0.02 + 0.75 + 1,
    },
  ])(
    "reported cache writes are priced without double-counting $harness input",
    ({ harness, model, input, cached, writes, expectedInput, usd }) => {
      const cost = turnCost({ ...turn(model, input, cached, 100_000), cacheWriteTokens: writes }, harness);
      expect(cost.inputTokens).toBe(expectedInput);
      expect(cost.cacheWriteTokens).toBe(writes);
      expect(cost.usd).toBeCloseTo(usd, 10);
      expect(turnCost({ ...turn(model, input, cached, 100_000), cacheWriteTokens: null }, harness).usd).toBeNull();
    },
  );

  test("no usage recorded is no turn and no figure", () => {
    expect(sandboxCost(null, "codex", "estimated")).toMatchObject({
      usd: null,
      turns: [],
      turnCount: 0,
      computeSeconds: null,
    });
  });

  test("only a known API key's figure is estimated; a subscription's or an unreadable account's is API-equivalent", () => {
    expect(costBasis("claude_oauth")).toBe("api_equivalent");
    expect(costBasis("codex_auth")).toBe("api_equivalent");
    expect(costBasis("anthropic")).toBe("estimated");
    expect(costBasis("openai")).toBe("estimated");
    expect(costBasis(null)).toBe("api_equivalent");
    expect(sandboxCost(null, "claude", "api_equivalent").label).toBe("API-equivalent cost");
    expect(sandboxCost(null, "claude", "estimated").label).toBe("Estimated cost");
  });

  test("an orchestrator's cost sums its own and its workers', and stays API-equivalent unless all are estimates", () => {
    const own = sandboxCost(
      { computeSeconds: 60, turnCount: 1, turns: [turn("claude-sonnet-5-5", 1_000_000, 0, 0, "o")] },
      "claude",
      "estimated",
    );
    const worker = sandboxCost(
      { computeSeconds: 30, turnCount: 2, turns: [turn("gpt-6.1-sol", 1_000_000, 0, 0, "w"), turn("x", 1, 0, 1, "v")] },
      "codex",
      "api_equivalent",
    );
    const total = combineCosts([own, worker]);
    expect(total.usd).toBeCloseTo(4, 10);
    expect(total).toMatchObject({ basis: "api_equivalent", turnCount: 3, computeSeconds: 90, unpricedTurns: 1 });
    expect(total.tokens).toEqual({ input: 2_000_001, cached: 0, cacheWrite: 0, output: 1 });
    expect(combineCosts([own, own]).basis).toBe("estimated");
    expect(combineCosts([own, sandboxCost(null, "claude", "estimated")]).computeSeconds).toBeNull();
  });
});
