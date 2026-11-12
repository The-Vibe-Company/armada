import type { Harness } from "./contract.ts";
import table from "./pricing/models-dev.json";
import { type TokenRates, validRates } from "./pricing/rates.ts";
import type { TurnTokenUsage } from "./sandbox-usage.ts";

export type { TokenRates } from "./pricing/rates.ts";
export interface PriceSnapshot {
  schemaVersion: 1;
  provider: "anthropic" | "openai";
  model: string;
  source: "models.dev" | "connection";
  revision: string;
  connectionId: string | null;
  rates: TokenRates;
  unsupported: boolean;
}
export interface PriceContext {
  provider: PriceSnapshot["provider"];
  /** Exact reported model ID. No suffix stripping or guessed aliases. */
  model: string | null;
  customEndpoint: boolean;
  connection?: { id: string; revision: string; rates: TokenRates };
}

/** Resolve once at admission and persist the returned value; no live network or viewer credentials. */
export function resolvePrice(context: PriceContext): PriceSnapshot | null {
  if (!context.model) return null;
  if (context.connection) {
    if (!validRates(context.connection.rates)) return null;
    return {
      schemaVersion: 1,
      provider: context.provider,
      model: context.model,
      source: "connection",
      revision: context.connection.revision,
      connectionId: context.connection.id,
      rates: { ...context.connection.rates },
      unsupported: false,
    };
  }
  if (context.customEndpoint) return null;
  const key = `${context.provider}/${context.model}`;
  const models = table.models as Record<string, { rates: TokenRates; unsupported: boolean }>;
  const entry = Object.hasOwn(models, key) ? models[key] : undefined;
  if (!entry) return null;
  return {
    schemaVersion: 1,
    provider: context.provider,
    model: context.model,
    source: "models.dev",
    revision: table.sha256,
    connectionId: null,
    rates: { ...entry.rates },
    unsupported: entry.unsupported,
  };
}
export interface PricedTurn {
  /** Exact decimal dollars; round only in presentation code. */
  usd: string | null;
  unknown: "price" | "tokens" | "pricing_dimensions" | null;
  snapshot: PriceSnapshot | null;
}
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const SCALE = 1_000_000_000_000n;
function units(rate: string): bigint {
  const [whole = "0", fraction = ""] = rate.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, "0"));
}
function dollars(value: bigint): string {
  const scale = SCALE * 1_000_000n;
  const fraction = (value % scale).toString().padStart(18, "0").replace(/0+$/, "");
  return `${value / scale}${fraction ? `.${fraction}` : ""}`;
}

/** Native counters stay unchanged. Reasoning is part of output, never an additional output charge. */
export function priceTurn(
  turn: TurnTokenUsage,
  harness: Harness,
  snapshot: PriceSnapshot | null,
  /** A caller must verify the cache-write TTL from native data, not infer it from the price table. */
  cacheWriteTtl: "5m" | "30m" | null = null,
): PricedTurn {
  // Copy so neither a subsequent connection edit nor caller mutation changes this result's provenance.
  const frozen = snapshot ? { ...snapshot, rates: { ...snapshot.rates } } : null;
  const unknown = (reason: PricedTurn["unknown"]): PricedTurn => ({ usd: null, unknown: reason, snapshot: frozen });
  if (
    !frozen ||
    !validRates(frozen.rates) ||
    turn.model !== frozen.model ||
    frozen.provider !== (harness === "claude" ? "anthropic" : "openai")
  )
    return unknown("price");
  if (frozen.unsupported) return unknown("pricing_dimensions");
  const { inputTokens: input, outputTokens: output, cachedTokens: cached, cacheWriteTokens: write } = turn;
  if (!count(input) || !count(output) || !count(cached) || !count(write)) return unknown("tokens");
  const reasoning = turn.reasoningTokens;
  if (reasoning != null && (!count(reasoning) || reasoning > output)) return unknown("tokens");
  const uncached = harness === "codex" ? input - cached - write : input;
  if (!Number.isSafeInteger(uncached) || uncached < 0) return unknown("tokens");
  if (
    write > 0 &&
    (cacheWriteTtl === null ||
      (frozen.source === "models.dev" && cacheWriteTtl !== (harness === "claude" ? "5m" : "30m")))
  )
    return unknown("pricing_dimensions");
  const rates = frozen.rates;
  if (rates.reasoning !== null && !count(reasoning)) return unknown("tokens");
  const buckets: [number, string | null][] = [
    [uncached, rates.input],
    [cached, rates.cacheRead],
    [write, rates.cacheWrite],
    [rates.reasoning === null ? output : output - (reasoning ?? 0), rates.output],
    [rates.reasoning === null ? 0 : (reasoning ?? 0), rates.reasoning],
  ];
  let total = 0n;
  for (const [tokens, rate] of buckets) {
    if (tokens === 0) continue;
    if (rate === null) return unknown("price");
    total += BigInt(tokens) * units(rate);
  }
  return { usd: dollars(total), unknown: null, snapshot: frozen };
}
