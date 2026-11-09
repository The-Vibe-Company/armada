import type { ProviderResourceObservation } from "./resource-observation.ts";

/** Validate untrusted runner/transport data before persistence. No scope inferred from counters. */
export function validateProviderResourceObservation(value: unknown): value is ProviderResourceObservation {
  if (!value || typeof value !== "object") return false;
  const v = value as ProviderResourceObservation;
  const id = (s: unknown, limit: number) =>
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= limit &&
    Array.from(s).every((char) => char.charCodeAt(0) >= 32);
  const counter = (n: unknown) => n === null || (typeof n === "number" && Number.isSafeInteger(n) && n >= 0);
  if (
    v.version !== 1 ||
    !id(v.providerSandboxId, 256) ||
    !id(v.physicalId, 512) ||
    !id(v.generation, 256) ||
    v.scope !== "dedicated-vm" ||
    !["boat-dedicated-vm", "modal-explicit-vm-v1"].includes(v.runtimeProvenance) ||
    !Array.isArray(v.limitations) ||
    v.limitations.length !== 2 ||
    v.limitations[0] !== "sampled-memory-not-peak" ||
    v.limitations[1] !== "hypervisor-throttling-unavailable"
  )
    return false;
  if (
    Object.keys(v).some(
      (key) =>
        ![
          "version",
          "providerSandboxId",
          "physicalId",
          "generation",
          "scope",
          "runtimeProvenance",
          "reading",
          "limitations",
        ].includes(key),
    )
  )
    return false;
  const r = v.reading;
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).some(
      (key) =>
        ![
          "version",
          "bootId",
          "uptimeMs",
          "captureDurationMs",
          "cpuLogicalCpus",
          "cpuTotalTicks",
          "cpuBusyTicks",
          "cpuStealTicks",
          "memoryTotalBytes",
          "memoryAvailableBytes",
          "cpuPressureSomeUsec",
          "oomKills",
        ].includes(key),
    )
  )
    return false;
  if (
    !r ||
    r.version !== 1 ||
    typeof r.bootId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(r.bootId) ||
    !Number.isFinite(r.uptimeMs) ||
    r.uptimeMs < 0 ||
    r.uptimeMs > Number.MAX_SAFE_INTEGER ||
    !Number.isFinite(r.captureDurationMs) ||
    r.captureDurationMs < 0 ||
    r.captureDurationMs > 5000
  )
    return false;
  if (
    ![
      r.cpuLogicalCpus,
      r.cpuTotalTicks,
      r.cpuBusyTicks,
      r.cpuStealTicks,
      r.memoryTotalBytes,
      r.memoryAvailableBytes,
      r.cpuPressureSomeUsec,
      r.oomKills,
    ].every(counter)
  )
    return false;
  if (r.cpuLogicalCpus !== null && (r.cpuLogicalCpus < 1 || r.cpuLogicalCpus > 1024)) return false;
  if (r.cpuTotalTicks !== null && r.cpuBusyTicks !== null && r.cpuBusyTicks > r.cpuTotalTicks) return false;
  if (r.cpuTotalTicks !== null && r.cpuStealTicks !== null && r.cpuStealTicks > r.cpuTotalTicks) return false;
  if (
    r.memoryTotalBytes !== null &&
    (r.memoryTotalBytes === 0 || (r.memoryAvailableBytes !== null && r.memoryAvailableBytes > r.memoryTotalBytes))
  )
    return false;
  return true;
}
