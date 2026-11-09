import type { MachineSize, MachineSizeEvidence } from "./machine-size.ts";
import type { SandboxProviderId } from "./sandbox-provider.ts";

export const RESOURCE_ADVICE_VERSION = 1 as const;
/** Scope is resolved and authorized by the server, never accepted as observation metadata from a client. */
export interface ResourceAdviceScope {
  ownerId: string;
  orgId: string;
  goldenId: string;
  repositoryDir: string;
  provider: SandboxProviderId;
  workload: string;
  size: MachineSizeEvidence;
}
/** Versioned browser-safe API/MCP result. Unavailable values are null, never inferred zeroes.
 * Recommendations do not mutate policy, allocate resources or promise monetary savings.
 */
export interface ResourceAdvice {
  version: typeof RESOURCE_ADVICE_VERSION;
  scope: ResourceAdviceScope;
  generatedAt: string;
  window: { from: string | null; to: string | null; maxSessions: 10; considered: number; sufficient: number };
  observations: {
    activeSeconds: number | null;
    coverageFraction: number | null;
    cpuAverageBusyCores: number | null;
    cpuPeakBusyCores: number | null;
    cpuPressureFraction: number | null;
    cpuThrottledSeconds: number | null;
    memoryPeakBytes: number | null;
    oomKills: number | null;
  };
  confidence: "unavailable" | "low" | "moderate";
  reason:
    | "collection_unavailable"
    | "insufficient_sessions"
    | "insufficient_coverage"
    | "stale_observations"
    | "unknown_capacity"
    | "resource_pressure"
    | "eligibility_unknown"
    | "no_smaller_eligible_tier"
    | "headroom_observed";
  recommendedSize: MachineSize | null;
}
