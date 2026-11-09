import type { MachineSize } from "./machine-size.ts";
import type { ResourceAdvice } from "./resource-advice.ts";

/** Server-owned session summaries from scoped, generation/capacity-pinned observations.
 * cpuPeakFraction is normalized against an OBSERVED scheduler quota, not Modal physical-core requests.
 * Null means unavailable. Idle/wait periods must not be included in activeSeconds or coverage.
 */
export interface ResourceSessionEvidence {
  endedAtMs: number;
  activeSeconds: number;
  coverageFraction: number;
  validIntervals: number;
  cpuPeakFraction: number | null;
  cpuPressureFraction: number | null;
  throttledSeconds: number | null;
  memoryPeakBytes: number | null;
  oomKills: number | null;
  complete: boolean;
}
export interface ResourceRecommendation {
  considered: number;
  sufficient: number;
  reason: ResourceAdvice["reason"];
  recommendedSize: MachineSize | null;
}
/** Pure conservative decision, no policy mutation or provider calls. Candidate eligibility must
 * already include account/plan and source-disk constraints; null means they could not be verified.
 * Both current and candidate scheduler quotas require provider-attested mapping to the counter unit;
 * catalogue vCPU/physical-core counts alone are insufficient. Unknown mapping must pass null.
 * Caller selects comparable sessions first; this function never widens scope to fill the window.
 */
export function recommendResourceSize(input: {
  nowMs: number;
  current: { size: MachineSize; cpuQuotaBusyCores: number; memoryBytes: number } | null;
  sessions: readonly ResourceSessionEvidence[];
  eligible: readonly { size: MachineSize; cpuQuotaBusyCores: number; memoryBytes: number }[] | null;
}): ResourceRecommendation {
  const sessions = [...input.sessions]
    .filter((s) => Number.isFinite(s.endedAtMs) && s.endedAtMs <= input.nowMs)
    .sort((a, b) => b.endedAtMs - a.endedAtMs)
    .slice(0, 10);
  const result = (
    reason: ResourceAdvice["reason"],
    sufficient = 0,
    recommendedSize: MachineSize | null = null,
  ): ResourceRecommendation => ({ considered: sessions.length, sufficient, reason, recommendedSize });
  if (
    !input.current ||
    !Number.isFinite(input.current.cpuQuotaBusyCores) ||
    input.current.cpuQuotaBusyCores <= 0 ||
    !Number.isSafeInteger(input.current.memoryBytes) ||
    input.current.memoryBytes <= 0
  )
    return result("unknown_capacity");
  if (sessions.length < 5) return result("insufficient_sessions");
  const fresh = sessions.filter((s) => input.nowMs - s.endedAtMs <= 7 * 86400000);
  if (fresh.length < 5) return result("stale_observations");
  const valid = fresh.filter(
    (s) =>
      s.complete &&
      Number.isFinite(s.activeSeconds) &&
      s.activeSeconds >= 300 &&
      Number.isFinite(s.coverageFraction) &&
      s.coverageFraction >= 0.9 &&
      s.coverageFraction <= 1 &&
      Number.isInteger(s.validIntervals) &&
      s.validIntervals >= 30 &&
      [s.cpuPeakFraction, s.cpuPressureFraction, s.throttledSeconds, s.memoryPeakBytes, s.oomKills].every(
        (v) => v !== null && Number.isFinite(v) && v >= 0,
      ) &&
      (s.cpuPressureFraction as number) <= 1,
  );
  if (valid.length < 5 || valid.length !== fresh.length) return result("insufficient_coverage", valid.length);
  if (
    valid.some(
      (s) =>
        (s.cpuPressureFraction as number) > 0.01 || (s.throttledSeconds as number) > 0 || (s.oomKills as number) > 0,
    )
  )
    return result("resource_pressure", valid.length);
  if (input.eligible === null) return result("eligibility_unknown", valid.length);
  const current = input.current;
  const candidate = [...input.eligible]
    .filter(
      (c) =>
        Number.isFinite(c.cpuQuotaBusyCores) &&
        c.cpuQuotaBusyCores > 0 &&
        Number.isSafeInteger(c.memoryBytes) &&
        c.memoryBytes > 0 &&
        c.size !== current.size &&
        c.cpuQuotaBusyCores < current.cpuQuotaBusyCores &&
        c.memoryBytes <= current.memoryBytes,
    )
    .sort((a, b) => a.cpuQuotaBusyCores - b.cpuQuotaBusyCores || a.memoryBytes - b.memoryBytes)
    .find((c) =>
      valid.every(
        (s) =>
          ((s.cpuPeakFraction as number) * current.cpuQuotaBusyCores) / c.cpuQuotaBusyCores <= 0.5 &&
          (s.memoryPeakBytes as number) <= c.memoryBytes * 0.7,
      ),
    );
  return candidate
    ? result("headroom_observed", valid.length, candidate.size)
    : result("no_smaller_eligible_tier", valid.length);
}
