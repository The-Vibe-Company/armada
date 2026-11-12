import type { CostBasis } from "./sandbox-cost.ts";
import type { PricedTurn, PriceSnapshot } from "./server-pricing.ts";

/** Private server input: capture before work, never derive from a harness monetary figure/current read-time catalog. */
export interface TurnPriceContext {
  schemaVersion: 1;
  promptId: string;
  model: string | null;
  basis: CostBasis;
  credentialId: string | null;
  credentialVersion: number | null;
  capturedAt: string;
  snapshot: PriceSnapshot | null;
}
export interface PricingInputs {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  cacheWriteTtl: "5m" | "30m" | "other" | null;
}
/** Server-owned output in usage.turns; null means no admitted price context, never a zero charge. */
export interface StoredTurnPricing extends PricedTurn {
  schemaVersion: 1;
  basis: CostBasis;
  credentialId: string | null;
  credentialVersion: number | null;
  capturedAt: string;
  /** A single observed input tuple, not a synthetic union of independently maximized counters. */
  inputs: PricingInputs | null;
}

/** Exact server aggregate. No partial priced subtotal is presented as a complete session amount. */
export interface SessionCost {
  currency: "USD";
  usd: string | null;
  basis: CostBasis | null;
  unknown: "admission" | "coverage" | PricedTurn["unknown"];
  unpricedTurns: number | null;
}
