import { expect, test } from "bun:test";
import type { TurnTokenUsage } from "../src/sandbox-usage.ts";
import { priceTurn, resolvePrice, type TokenRates } from "../src/server-pricing.ts";

const rates: TokenRates = { input: "2", output: "10", cacheRead: "0.1", cacheWrite: "2.5", reasoning: null };
const turn: TurnTokenUsage = {
  promptId: "p",
  model: "custom",
  inputTokens: 1000,
  cachedTokens: 200,
  cacheWriteTokens: 100,
  outputTokens: 300,
  reasoningTokens: 100,
};
const override = (prices = rates) =>
  resolvePrice({
    provider: "openai",
    model: "custom",
    customEndpoint: true,
    connection: { id: "c", revision: "v1", rates: prices },
  });

test("native buckets are disjoint for Codex; reasoning is not charged twice; decimal amount is exact", () => {
  // 700*2 + 200*.1 + 100*2.5 + 300*10 = 4670 microdollars.
  expect(priceTurn(turn, "codex", override(), "30m").usd).toBe("0.00467");
  // Explicit connection rates are flat across cache lifetimes; no vendor TTL is guessed.
  expect(priceTurn(turn, "codex", override()).usd).toBe("0.00467");
  const claude = { ...turn, model: "claude-sonnet-5-5" };
  const snapshot = resolvePrice({ provider: "anthropic", model: claude.model, customEndpoint: false });
  // Claude input excludes reads/writes: 1000*2 + 200*.1 + 100*2.5 + 300*10.
  expect(priceTurn(claude, "claude", snapshot, "5m").usd).toBe("0.00527");
  expect(priceTurn(turn, "codex", override({ ...rates, reasoning: "20" }), "30m").usd).toBe("0.00567");
});

test("custom endpoint never falls back to public rates; explicit zero override wins and snapshots are detached", () => {
  expect(resolvePrice({ provider: "openai", model: "gpt-6.1-sol", customEndpoint: true })).toBeNull();
  expect(resolvePrice({ provider: "openai", model: "gpt-6.1-sol-made-up", customEndpoint: false })).toBeNull();
  const free = { input: "0", output: "0", cacheRead: "0", cacheWrite: "0", reasoning: null };
  const snapshot = override(free)!;
  free.input = "9";
  const result = priceTurn(turn, "codex", snapshot, "30m");
  snapshot.rates.input = "8";
  expect(result.usd).toBe("0");
  expect(result.snapshot?.rates.input).toBe("0");
});

test("missing or invalid observations and unsupported pricing never become zero", () => {
  for (const patch of [
    { inputTokens: null },
    { cachedTokens: 2000 },
    { outputTokens: -1 },
    { reasoningTokens: 301 },
    { cacheWriteTokens: undefined },
    { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    expect(priceTurn({ ...turn, ...patch } as TurnTokenUsage, "codex", override(), "30m").unknown).toBe("tokens");
  }
  const publicClaude = resolvePrice({ provider: "anthropic", model: "claude-sonnet-5-5", customEndpoint: false });
  expect(priceTurn({ ...turn, model: "claude-sonnet-5-5" }, "claude", publicClaude).unknown).toBe("pricing_dimensions");
  expect(priceTurn(turn, "codex", override({ ...rates, cacheRead: null }), "30m").unknown).toBe("price");
  expect(override({ ...rates, input: "NaN" })).toBeNull();
  const tiered = resolvePrice({ provider: "openai", model: "gpt-5.5", customEndpoint: false });
  expect(priceTurn({ ...turn, model: "gpt-5.5" }, "codex", tiered, "30m").unknown).toBe("pricing_dimensions");
});

test("image-generation pricing cannot be mistaken for text-token pricing", () => {
  const snapshot = resolvePrice({ provider: "openai", model: "gpt-image-2", customEndpoint: false });
  expect(priceTurn({ ...turn, model: "gpt-image-2", cacheWriteTokens: 0 }, "codex", snapshot, "30m").unknown).toBe(
    "pricing_dimensions",
  );
});

test.each([
  { provider: "anthropic" as const, model: "claude-opus-5-5", harness: "claude" as const },
  { provider: "openai" as const, model: "gpt-4.1-nano", harness: "codex" as const },
  { provider: "openai" as const, model: "gpt-5-nano", harness: "codex" as const },
])("unverified service tier never receives a standard-rate amount: $model", ({ provider, model, harness }) => {
  const snapshot = resolvePrice({ provider, model, customEndpoint: false });
  const result = priceTurn(
    {
      ...turn,
      model,
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    harness,
    snapshot,
  );
  expect(result.usd).toBeNull();
  expect(result.unknown).toBe("pricing_dimensions");
});
