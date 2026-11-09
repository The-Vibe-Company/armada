/** Browser-safe observation contract. No provider capacity or tier assumptions. */
export const RESOURCE_OBSERVATION_VERSION = 1 as const;
export interface ResourceCounters {
  version: typeof RESOURCE_OBSERVATION_VERSION;
  /** Physical sandbox generation; never a logical Armada sandbox ID alone. */
  generation: string;
  /** Immutable effective-capacity evidence identity supplied by the launch owner. */
  capacityId: string;
  /** Monotonic milliseconds within this physical generation. */
  monotonicMs: number;
  cpuUsageUsec: number | null;
  cpuThrottledUsec: number | null;
  cpuPressureSomeUsec: number | null;
  memoryCurrentBytes: number | null;
  memoryPeakBytes: number | null;
  oomKills: number | null;
}
export interface ResourceInterval {
  version: typeof RESOURCE_OBSERVATION_VERSION;
  generation: string;
  capacityId: string;
  durationMs: number;
  /** CPU-seconds per elapsed second, not percentage or provider physical cores. */
  cpuBusyCores: number | null;
  cpuThrottledUsec: number | null;
  cpuPressureFraction: number | null;
  memoryCurrentBytes: number | null;
  /** Cgroup lifetime high-water mark, NOT an interval peak. */
  memoryLifetimePeakBytes: number | null;
  oomKills: number | null;
}
const counter = (n: number | null): n is number => n !== null && Number.isSafeInteger(n) && n >= 0;
function delta(before: number | null, after: number | null): number | null {
  return counter(before) && counter(after) && after >= before ? after - before : null;
}
/** Discard replay, resets, gaps and generation/capacity crossings. Missing counters stay unavailable.
 * These are counter-normalization rules, not proof of provider isolation or workload coverage.
 * Collectors must independently establish scope before constructing ResourceCounters.
 */
export function resourceInterval(before: ResourceCounters, after: ResourceCounters): ResourceInterval | null {
  const durationMs = after.monotonicMs - before.monotonicMs;
  if (
    before.version !== RESOURCE_OBSERVATION_VERSION ||
    after.version !== RESOURCE_OBSERVATION_VERSION ||
    !before.generation ||
    !before.capacityId ||
    before.generation !== after.generation ||
    before.capacityId !== after.capacityId ||
    !Number.isFinite(before.monotonicMs) ||
    before.monotonicMs < 0 ||
    !Number.isFinite(after.monotonicMs) ||
    durationMs < 1000 ||
    durationMs > 30000
  )
    return null;
  const cpu = delta(before.cpuUsageUsec, after.cpuUsageUsec);
  const pressure = delta(before.cpuPressureSomeUsec, after.cpuPressureSomeUsec);
  return {
    version: RESOURCE_OBSERVATION_VERSION,
    generation: after.generation,
    capacityId: after.capacityId,
    durationMs,
    cpuBusyCores: cpu === null ? null : cpu / (durationMs * 1000),
    cpuThrottledUsec: delta(before.cpuThrottledUsec, after.cpuThrottledUsec),
    cpuPressureFraction: pressure === null || pressure > durationMs * 1000 ? null : pressure / (durationMs * 1000),
    memoryCurrentBytes: counter(after.memoryCurrentBytes) ? after.memoryCurrentBytes : null,
    memoryLifetimePeakBytes:
      counter(after.memoryPeakBytes) &&
      counter(after.memoryCurrentBytes) &&
      after.memoryPeakBytes >= after.memoryCurrentBytes
        ? after.memoryPeakBytes
        : null,
    oomKills: delta(before.oomKills, after.oomKills),
  };
}

/** Raw bounded guest-kernel counters. Scope is attested by the provider, never by guest data. */
export interface VmResourceReading {
  version: 1;
  bootId: string;
  uptimeMs: number;
  captureDurationMs: number;
  cpuLogicalCpus: number | null;
  cpuTotalTicks: number | null;
  cpuBusyTicks: number | null;
  cpuStealTicks: number | null;
  memoryTotalBytes: number | null;
  memoryAvailableBytes: number | null;
  cpuPressureSomeUsec: number | null;
  oomKills: number | null;
}
export interface ProviderResourceObservation {
  version: 1;
  providerSandboxId: string;
  physicalId: string;
  generation: string;
  scope: "dedicated-vm";
  runtimeProvenance: "boat-dedicated-vm" | "modal-explicit-vm-v1";
  reading: VmResourceReading;
  /** Guest samples have no guaranteed memory peak or hypervisor throttle evidence. */
  limitations: readonly ["sampled-memory-not-peak", "hypervisor-throttling-unavailable"];
}
