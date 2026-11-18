import type { Harness } from "./contract.ts";
import type { LaunchOptions } from "./launch.ts";
import { SANDBOX_STOP_MARGIN_SECONDS } from "./sandbox-lifetime.ts";
import { HOST_CAPABILITIES, PROVIDER_LIMITS, type SandboxProviderId } from "./sandbox-provider.ts";

/** Golden-specific placement policy. The launch strategy owns agent initialization after the fork. */
interface GoldenLaunchPlacement {
  runtimeDefault(options: LaunchOptions, harness: Harness): LaunchOptions["boatRuntimeDefault"];
  endpointRuntime?(options: LaunchOptions): LaunchOptions["boatEndpointRuntime"];
  allocationTtlSeconds(ttlSeconds: number, extensionHeadroom: number, privateParent: boolean): number;
}

function allocationTtlFor(provider: SandboxProviderId): GoldenLaunchPlacement["allocationTtlSeconds"] {
  return (ttlSeconds, extensionHeadroom, privateParent) =>
    privateParent
      ? ttlSeconds
      : Math.min(
          PROVIDER_LIMITS[provider].maxTtlSeconds,
          ttlSeconds +
            SANDBOX_STOP_MARGIN_SECONDS +
            (HOST_CAPABILITIES[provider].reserveExtensionHeadroom ? extensionHeadroom : 0),
        );
}

export const goldenLaunchPlacements: Readonly<Record<SandboxProviderId, GoldenLaunchPlacement>> = {
  boat: {
    runtimeDefault: (options, harness) =>
      options.boatRuntimeDefault ?? (harness === "opencode" ? options.boatEndpointRuntime : undefined),
    endpointRuntime: (options) => options.boatEndpointRuntime,
    allocationTtlSeconds: allocationTtlFor("boat"),
  },
  modal: {
    runtimeDefault: (options) => options.modalRuntimeDefault,
    allocationTtlSeconds: allocationTtlFor("modal"),
  },
};
