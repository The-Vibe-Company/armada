import { isSandboxPlacementProvider, isSandboxProvider, type SandboxProviderId } from "@armada/core";
import { capabilities } from "@armada/core/server";

export const runtimeBridgeProfiles = {
  boat: {
    placement: "boat-runtime",
    launchDefault: "boatRuntimeDefault",
    endpointDefault: "boatEndpointRuntime",
    hostPorts: true,
    stopDispatch: "provider",
  },
  modal: {
    placement: "dialout",
    launchDefault: "modalRuntimeDefault",
    endpointDefault: undefined,
    hostPorts: false,
    stopDispatch: "job",
  },
} as const satisfies Record<SandboxProviderId, object>;

export function modalDialoutPlacement(target: { runtimeTransport?: string }) {
  return target.runtimeTransport === "dialout";
}

export function usesRuntimeStopJob(target: { provider: string; runtimeTransport?: string | null }) {
  return (
    isSandboxProvider(target.provider) &&
    runtimeBridgeProfiles[target.provider].stopDispatch === "job" &&
    target.runtimeTransport === "dialout"
  );
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
  runtimeTransport?: string;
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

/** Closed provider refusal names; unrecognized identities retain the generic diagnostic. */
export function runtimeConfigurationFailure(id: unknown) {
  const names: Record<string, string> = { boat: "Boat runtime", docker: "Docker runtime" };
  return `${typeof id === "string" && Object.hasOwn(names, id) ? names[id] : "Runtime"} configuration is unavailable.`;
}
