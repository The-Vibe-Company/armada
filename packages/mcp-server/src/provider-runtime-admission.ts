import {
  isSandboxPlacementProvider,
  isSandboxProvider,
  type SandboxPlacementProviderId,
  type SandboxProviderId,
} from "@armada/core";
import { runtimeHarnessSupported } from "@armada/core/harnesses";
import { capabilities } from "@armada/core/machine-capabilities";

export const runtimeBridgeProfiles = {
  boat: {
    placement: "boat-runtime",
    hostPorts: true,
    repeatPinnedSettings: true,
    requiresCredentialBinding: false,
    modelCheck: "runtime-command",
    usageNeedsActiveCompute: true,
    reliableCompletionTime: "runtime-only",
    preserveStateOnDeleteError: false,
    extensionInvalidRequest: "state",
  },
  modal: {
    placement: "dialout",
    hostPorts: false,
    repeatPinnedSettings: false,
    requiresCredentialBinding: true,
    modelCheck: "provider-activity",
    usageNeedsActiveCompute: false,
    reliableCompletionTime: "always",
    preserveStateOnDeleteError: true,
    extensionInvalidRequest: "physical-deadline",
  },
} as const satisfies Record<SandboxProviderId, object>;

export function runtimeBridgeProfile(provider: unknown) {
  return isSandboxProvider(provider) ? runtimeBridgeProfiles[provider] : undefined;
}

export function requiresCredentialBinding(provider: unknown) {
  return runtimeBridgeProfile(provider)?.requiresCredentialBinding === true;
}

export function supportsResourceSampling(provider: unknown) {
  return isSandboxPlacementProvider(provider) && capabilities(provider).resourceSampler;
}

export const usesDiskStopJob = (provider: unknown) =>
  isSandboxProvider(provider) && capabilities(provider).stopRetention === "disk";

const missingMachineStopPolicy = {
  boat: "observe-exit",
  modal: "settle",
  docker: "settle",
} as const satisfies Record<SandboxPlacementProviderId, "observe-exit" | "settle">;

/** A stop refusal alone is ambiguous for adapters that require an absence observation. */
export const requiresMissingMachineObservation = (provider: unknown) =>
  isSandboxPlacementProvider(provider) && missingMachineStopPolicy[provider] === "observe-exit";

export const canRepeatPinnedRuntimeSettings = (provider: unknown) =>
  isSandboxProvider(provider) && runtimeBridgeProfiles[provider].repeatPinnedSettings;

export function modalDialoutPlacement(target: { modalTransport?: string }) {
  return target.modalTransport === "dialout";
}

export const usesHostLaunch = (provider: unknown) =>
  isSandboxPlacementProvider(provider) && capabilities(provider).launchSource === "host";

export const retainsDiskOnStop = (provider: unknown) =>
  isSandboxPlacementProvider(provider) && capabilities(provider).stopRetention === "disk";

/** Shared runtime capabilities; callers retain placement, transport and authorization guards. */
export function runtimeBridgeTarget(target: {
  provider: string;
  harness: string;
  boatRuntime?: boolean;
  modalTransport?: string;
}): boolean {
  return (
    isSandboxProvider(target.provider) &&
    (runtimeBridgeProfiles[target.provider].placement === "dialout"
      ? modalDialoutPlacement(target)
      : Boolean(target.boatRuntime)) &&
    runtimeHarnessSupported(target.provider, target.harness)
  );
}

export { runtimeHarnessSupported };

export function runtimeConfigurationFailure(id: unknown) {
  const names: Record<string, string> = { boat: "Boat runtime", docker: "Docker runtime" };
  return `${typeof id === "string" && Object.hasOwn(names, id) ? names[id] : "Runtime"} configuration is unavailable.`;
}
