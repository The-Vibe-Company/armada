import type { Harness } from "./contract.ts";
import type { HarnessCredentials } from "./credentials.ts";
import type { GoldenActor } from "./golden.ts";
import type { LaunchOptions, LaunchPlan } from "./launch.ts";
import { LaunchError } from "./launch-error.ts";
import { admitLaunchPlan, type LaunchPlacement } from "./launch-plan.ts";
import { type ForkRequest, isNonMutatingProviderRefusal, type Provider } from "./provider.ts";
import type { SandboxRecord } from "./sandbox.ts";
import { SANDBOX_STOP_MARGIN_SECONDS } from "./sandbox-lifetime.ts";
import { HOST_CAPABILITIES, PROVIDER_LIMITS, type SandboxProviderId } from "./sandbox-provider.ts";

type ForkedSandbox = { id: string; expiresAt?: Date; sandbox?: SandboxRecord };

type GoldenAdmission = {
  actor: GoldenActor;
  id: string;
  forkEnv(): HarnessCredentials["env"];
  boot?(request: ForkRequest): Promise<ForkedSandbox>;
  allocationRisk(risk: boolean): void;
};

/** Golden-specific placement policy. The launch strategy owns agent initialization after the fork. */
interface GoldenLaunchPlacement extends LaunchPlacement<LaunchPlan, GoldenAdmission, ForkedSandbox> {
  runtimeDefault(options: LaunchOptions, harness: Harness): LaunchOptions["boatRuntimeDefault"];
  endpointRuntime?(options: LaunchOptions): LaunchOptions["boatEndpointRuntime"];
  allocationTtlSeconds(ttlSeconds: number, extensionHeadroom: number, privateParent: boolean): number;
}

// Plain function values keep this table free of top-level calls, so the bundler can drop it (and the
// server-only admission below) from consumers of the browser-safe entry point, such as the GitHub broker.
function allocationTtlFor(
  provider: SandboxProviderId,
  ttlSeconds: number,
  extensionHeadroom: number,
  privateParent: boolean,
): number {
  return privateParent
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
    admit: admitGoldenLaunch,
    runtimeDefault: (options, harness) =>
      options.boatRuntimeDefault ?? (harness === "opencode" ? options.boatEndpointRuntime : undefined),
    endpointRuntime: (options) => options.boatEndpointRuntime,
    allocationTtlSeconds: (ttlSeconds, extensionHeadroom, privateParent) =>
      allocationTtlFor("boat", ttlSeconds, extensionHeadroom, privateParent),
  },
  modal: {
    admit: admitGoldenLaunch,
    runtimeDefault: (options) => options.modalRuntimeDefault,
    allocationTtlSeconds: (ttlSeconds, extensionHeadroom, privateParent) =>
      allocationTtlFor("modal", ttlSeconds, extensionHeadroom, privateParent),
  },
};

async function admitGoldenLaunch(plan: LaunchPlan, { actor, id, forkEnv, allocationRisk, boot }: GoldenAdmission) {
  const {
    provider,
    stores,
    options,
    golden,
    harness,
    choice,
    allocationTtlSeconds,
    machineSize,
    visibility,
    snapshot,
    credentials,
  } = plan;
  await admitLaunchPlan(
    () => stores.credentials.admit?.(actor, credentials, id, choice.model),
    () => options.beforeFork?.(id),
  );
  allocationRisk(true);
  const request: ForkRequest = {
    from: snapshot,
    ...(machineSize.effective ? { size: machineSize.effective } : {}),
    noEnv: true,
    env: forkEnv(),
    ttlSeconds: allocationTtlSeconds,
    labels: {
      armada: "sandbox",
      sandbox: id,
      org: actor.orgId,
      owner: actor.userId,
      golden: golden.name,
      visibility,
      harness,
      ...(credentials.binding
        ? {
            credentialId: credentials.binding.credentialId,
            credentialVersion: String(credentials.binding.credentialVersion),
          }
        : {}),
    },
  };
  return (boot ? boot(request) : provider.fork(request)).catch((error) => {
    if (boot) throw error;
    const refused = isNonMutatingProviderRefusal(error);
    allocationRisk(!refused);
    if (!refused)
      throw new LaunchError(
        "outcome_unknown",
        "The provider fork outcome is unknown. Check sandbox status before retrying.",
        { cause: error },
      );
    throw error;
  });
}
