import { isSandboxPlacementProvider, PROVIDER_LIMITS, type SandboxPlacementProviderId } from "./sandbox-provider.ts";

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
  readonly idleStop: boolean;
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
    idleStop: true,
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
    idleStop: true,
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
    idleStop: false,
    resumeAfterStop: true,
    sizes: Object.freeze([]),
  }),
};

// Runtime admission and account probing are independent of the Machine contract.
const runtimePolicies = {
  boat: { openCodeRequiresDiscovery: true, connectionTest: "runtime-enrollment" },
  modal: { openCodeRequiresDiscovery: false, connectionTest: "supported" },
  docker: { openCodeRequiresDiscovery: false, connectionTest: "unsupported" },
} as const satisfies Record<
  SandboxPlacementProviderId,
  {
    openCodeRequiresDiscovery: boolean;
    connectionTest: "runtime-enrollment" | "supported" | "unsupported";
  }
>;

export function openCodeRequiresRuntimeDiscovery(provider: unknown) {
  return isSandboxPlacementProvider(provider) && runtimePolicies[provider].openCodeRequiresDiscovery;
}

export function modelConnectionTestSupport(provider: unknown) {
  return isSandboxPlacementProvider(provider) ? runtimePolicies[provider].connectionTest : "unsupported";
}

export function capabilities(providerId: SandboxPlacementProviderId) {
  return machineCapabilities[providerId];
}
