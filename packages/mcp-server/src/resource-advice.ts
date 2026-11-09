import type { ResourceAdvice } from "@armada/core";
import { recommendResourceSize } from "../../core/src/resource-recommendation.ts";
import type { ResourceHistory } from "./resource-store.ts";

/** Guest counters include idle/CI waits. Never promote samples to complete workload evidence. */
export function summarizeResourceHistory(history: ResourceHistory, now: Date): ResourceAdvice {
  const { target, sessions } = history;
  let points = 0,
    intervals = 0,
    weightedCpu = 0,
    cpuSeconds = 0;
  let cpuPeak: number | null = null,
    memoryMax: number | null = null;
  let pressureUsec = 0,
    pressureSeconds = 0,
    oom: number | null = null;
  const dates: string[] = [];
  for (const session of sessions) {
    const samples = session.observations
      .filter((s) => {
        const at = Date.parse(s.at);
        const expected = history.targetObservation?.observation.reading;
        const actual = s.observation.reading;
        return (
          expected &&
          actual.cpuLogicalCpus === expected.cpuLogicalCpus &&
          actual.memoryTotalBytes === expected.memoryTotalBytes &&
          Number.isFinite(at) &&
          at <= now.getTime() &&
          at >= now.getTime() - 7 * 86400000
        );
      })
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    points += samples.length;
    for (const sample of samples) {
      dates.push(sample.at);
      const r = sample.observation.reading;
      if (r.memoryTotalBytes !== null && r.memoryAvailableBytes !== null)
        memoryMax = Math.max(memoryMax ?? 0, r.memoryTotalBytes - r.memoryAvailableBytes);
    }
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]?.observation,
        b = samples[i]?.observation;
      if (
        !a ||
        !b ||
        a.physicalId !== b.physicalId ||
        a.generation !== b.generation ||
        a.reading.bootId !== b.reading.bootId ||
        a.reading.cpuLogicalCpus !== b.reading.cpuLogicalCpus ||
        a.reading.memoryTotalBytes !== b.reading.memoryTotalBytes
      )
        continue;
      const x = a.reading,
        y = b.reading,
        seconds = (y.uptimeMs - x.uptimeMs) / 1000;
      if (seconds < 1 || seconds > 30) continue;
      const delta = (before: number | null, after: number | null) =>
        before !== null && after !== null && after >= before ? after - before : null;
      const total = delta(x.cpuTotalTicks, y.cpuTotalTicks),
        busy = delta(x.cpuBusyTicks, y.cpuBusyTicks);
      if (total === null || total <= 0 || busy === null || busy > total || y.cpuLogicalCpus === null) continue;
      intervals++;
      const cores = (busy / total) * y.cpuLogicalCpus;
      weightedCpu += cores * seconds;
      cpuSeconds += seconds;
      cpuPeak = Math.max(cpuPeak ?? 0, cores);
      const pressure = delta(x.cpuPressureSomeUsec, y.cpuPressureSomeUsec);
      if (pressure !== null && pressure <= seconds * 1000000) {
        pressureUsec += pressure;
        pressureSeconds += seconds;
      }
      const kills = delta(x.oomKills, y.oomKills);
      if (kills !== null) oom = (oom ?? 0) + kills;
    }
  }
  dates.sort();
  const size = target.machineSize ?? null;
  const newest = history.targetObservation?.observation.reading;
  const recommendation = recommendResourceSize({
    nowMs: now.getTime(),
    // Guest logical CPU count is not a provider-attested scheduler quota mapping.
    current: null,
    eligible: null,
    sessions: sessions.map((s) => ({
      endedAtMs: Date.parse(s.sandbox.stoppedAt ?? now.toISOString()),
      activeSeconds: null,
      coverageFraction: null,
      validIntervals: 0,
      cpuPeakFraction: null,
      cpuPressureFraction: null,
      throttledSeconds: null,
      memoryPeakBytes: null,
      oomKills: null,
      complete: false,
    })),
  });
  return {
    version: 1,
    scope: {
      ownerId: target.ownerId,
      orgId: target.orgId,
      goldenId: target.goldenId,
      repositoryDir: target.repositoryDir,
      project: target.resourceProject ?? null,
      provider: target.provider,
      workload: `${target.harness}:${target.model ?? "unknown"}:${target.reasoningEffort ?? "unknown"}`,
      size,
    },
    generatedAt: now.toISOString(),
    window: {
      from: dates[0] ?? null,
      to: dates.at(-1) ?? null,
      maxSessions: 10,
      considered: sessions.length,
      sufficient: recommendation.sufficient,
    },
    observations: {
      activeSeconds: null,
      coverageFraction: null,
      cpuAverageBusyCores: null,
      cpuPeakBusyCores: null,
      cpuPressureFraction: null,
      cpuThrottledSeconds: null,
      memoryPeakBytes: null,
      oomKills: null,
    },
    sampled: {
      capacity:
        newest?.cpuLogicalCpus && newest.memoryTotalBytes
          ? { guestLogicalCpus: newest.cpuLogicalCpus, memoryTotalBytes: newest.memoryTotalBytes }
          : null,
      points,
      intervals,
      allActivityCpuAverageBusyCores: cpuSeconds ? weightedCpu / cpuSeconds : null,
      allActivityCpuPeakBusyCores: cpuPeak,
      memoryMaxObservedBytes: memoryMax,
      cpuPressureFraction: pressureSeconds ? pressureUsec / (pressureSeconds * 1000000) : null,
      oomKills: oom,
    },
    limitations: [
      "active-workload-attribution-unavailable",
      "sampled-memory-not-peak",
      "hypervisor-throttling-unavailable",
      "candidate-plan-disk-and-scheduler-eligibility-unverified",
    ],
    confidence: points ? "low" : "unavailable",
    reason: !target.resourceProject
      ? "unknown_project"
      : !size?.capacity
        ? "unknown_capacity"
        : !points
          ? "collection_unavailable"
          : (oom ?? 0) > 0 || (pressureSeconds > 0 && pressureUsec / (pressureSeconds * 1000000) > 0.01)
            ? "resource_pressure"
            : "insufficient_coverage",
    recommendedSize: null,
  };
}
