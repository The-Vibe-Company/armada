import type { MachineSize, MachineSizeEvidence } from "./machine-size.ts";
import type { ResourceProject } from "./sandbox.ts";
import type { SandboxProviderId } from "./sandbox-provider.ts";

export const RESOURCE_ADVICE_VERSION = 1 as const;
/** Scope is resolved and authorized by the server, never accepted as observation metadata from a client. */
export interface ResourceAdviceScope {
  ownerId: string;
  orgId: string;
  goldenId: string;
  repositoryDir: string | null;
  project: ResourceProject | null;
  provider: SandboxProviderId;
  workload: string;
  size: MachineSizeEvidence | null;
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
  /** Whole-VM sampled data across ALL activity; never presented as active-workload usage or true peaks. */
  sampled: {
    capacity: { guestLogicalCpus: number; memoryTotalBytes: number } | null;
    points: number;
    intervals: number;
    allActivityCpuAverageBusyCores: number | null;
    allActivityCpuPeakBusyCores: number | null;
    memoryMaxObservedBytes: number | null;
    cpuPressureFraction: number | null;
    oomKills: number | null;
  };
  limitations: string[];
  confidence: "unavailable" | "low" | "moderate";
  reason:
    | "collection_unavailable"
    | "insufficient_sessions"
    | "insufficient_coverage"
    | "stale_observations"
    | "unknown_capacity"
    | "unknown_project"
    | "resource_pressure"
    | "eligibility_unknown"
    | "no_smaller_eligible_tier"
    | "headroom_observed";
  recommendedSize: MachineSize | null;
}

/** POST /api/v1/sandbox/advice; samples at most once per call, no implicit resize/default change. */
export interface ResourceAdviceRequest {
  id: string;
  org?: string;
}

export interface ResourceAdviceResponse {
  advice: ResourceAdvice;
}
