import {
  isSandboxPlacementProvider,
  isSandboxProvider,
  type LaunchOptions,
  type SandboxPlacementProviderId,
  type SandboxProviderId,
} from "@armada/core";
import { capabilities } from "@armada/core/machine-capabilities";

export const runtimeBridgeProfiles = {
  boat: {
    placement: "boat-runtime",
    launchDefault: "boatRuntimeDefault",
    hostPorts: true,
    repeatPinnedSettings: true,
  },
  modal: {
    placement: "dialout",
    launchDefault: "modalRuntimeDefault",
    hostPorts: false,
    repeatPinnedSettings: false,
  },
} as const satisfies Record<SandboxProviderId, object>;

export function goldenRuntimePlacement(options: LaunchOptions, provider: SandboxProviderId) {
  return options[runtimeBridgeProfiles[provider].launchDefault];
}

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

export const runtimeHarnessSupported = (provider: string, harness: string): boolean =>
  ["codex", "claude"].includes(harness) || (isSandboxPlacementProvider(provider) && harness === "opencode");

export function runtimeConfigurationFailure(id: unknown) {
  const names: Record<string, string> = { boat: "Boat runtime", docker: "Docker runtime" };
  return `${typeof id === "string" && Object.hasOwn(names, id) ? names[id] : "Runtime"} configuration is unavailable.`;
}
