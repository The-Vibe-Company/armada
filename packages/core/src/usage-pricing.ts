import type { CostBasis } from "./sandbox-cost.ts";
import type { PriceSnapshot } from "./server-pricing.ts";

/** Secret-free session admission record. Never refreshed from viewer credentials or current catalog at read time. */
export interface UsagePricingContext {
  schemaVersion: 1;
  capturedAt: string;
  catalogRevision: string;
  provider: PriceSnapshot["provider"];
  basis: CostBasis;
  credentialId: string | null;
  credentialVersion: number | null;
  customEndpoint: boolean;
  /** Exact model IDs, including unsupported entries. Empty for custom endpoints without configured prices. */
  prices: Record<string, PriceSnapshot>;
}
