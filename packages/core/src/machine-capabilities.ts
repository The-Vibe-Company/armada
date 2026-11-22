import { PROVIDER_LIMITS, type SandboxPlacementProviderId } from "./sandbox-provider.ts";

export const MACHINE_SIZES = ["small", "medium", "large", "xlarge"] as const;
export type MachineSize = (typeof MACHINE_SIZES)[number];

export interface MachineCapabilities {
  readonly launchSource: "golden" | "host";
  readonly maxTtlSeconds: number;
  readonly stopRetention: "disk" | "image" | "container";
  readonly snapshots: "required" | "optional";
  readonly extendLifetime: boolean;
  readonly humanSsh: boolean;
  readonly resourceSampler: boolean;
  readonly sizeResources: "instance-type" | "explicit-limits" | "none";
  readonly resumeAfterStop: boolean;
  readonly sizes: readonly MachineSize[];
}

const catalogSizes = Object.freeze([...MACHINE_SIZES]);
const machineCapabilities: Readonly<Record<SandboxPlacementProviderId, MachineCapabilities>> = {
  boat: Object.freeze({
    launchSource: "golden",
    maxTtlSeconds: PROVIDER_LIMITS.boat.maxTtlSeconds,
    stopRetention: "disk",
    snapshots: "required",
    extendLifetime: true,
    humanSsh: true,
    resourceSampler: true,
    sizeResources: "instance-type",
    resumeAfterStop: true,
    sizes: catalogSizes,
  }),
  modal: Object.freeze({
    launchSource: "golden",
    maxTtlSeconds: PROVIDER_LIMITS.modal.maxTtlSeconds,
    stopRetention: "image",
    snapshots: "optional",
    extendLifetime: true,
    humanSsh: true,
    resourceSampler: true,
    sizeResources: "explicit-limits",
    resumeAfterStop: true,
    sizes: catalogSizes,
  }),
  docker: Object.freeze({
    launchSource: "host",
    maxTtlSeconds: PROVIDER_LIMITS.docker.maxTtlSeconds,
    stopRetention: "container",
    snapshots: "optional",
    extendLifetime: false,
    humanSsh: false,
    resourceSampler: false,
    sizeResources: "none",
    resumeAfterStop: false,
    sizes: Object.freeze([]),
  }),
};

export function capabilities(providerId: SandboxPlacementProviderId) {
  return machineCapabilities[providerId];
}
