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
