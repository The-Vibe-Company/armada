import type { Harness } from "./contract.ts";
import type { HarnessCredentials } from "./credentials.ts";
import type { GoldenActor } from "./golden.ts";
import type { LaunchOptions, LaunchPlan } from "./launch.ts";
import { LaunchError } from "./launch-error.ts";
import { admitLaunchPlan, type LaunchPlacement } from "./launch-plan.ts";
import { isNonMutatingProviderRefusal, type Provider } from "./provider.ts";
import { SANDBOX_STOP_MARGIN_SECONDS } from "./sandbox-lifetime.ts";
import { HOST_CAPABILITIES, PROVIDER_LIMITS, type SandboxProviderId } from "./sandbox-provider.ts";

type GoldenAdmission = {
  actor: GoldenActor;
  id: string;
  forkEnv(): HarnessCredentials["env"];
  allocationRisk(risk: boolean): void;
};

/** Golden-specific placement policy. The launch strategy owns agent initialization after the fork. */
interface GoldenLaunchPlacement
  extends LaunchPlacement<LaunchPlan, GoldenAdmission, Awaited<ReturnType<Provider["fork"]>>> {
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
    admit: admitGoldenLaunch,
    runtimeDefault: (options, harness) =>
      options.boatRuntimeDefault ?? (harness === "opencode" ? options.boatEndpointRuntime : undefined),
    endpointRuntime: (options) => options.boatEndpointRuntime,
    allocationTtlSeconds: allocationTtlFor("boat"),
  },
  modal: {
    admit: admitGoldenLaunch,
    runtimeDefault: (options) => options.modalRuntimeDefault,
    allocationTtlSeconds: allocationTtlFor("modal"),
  },
};

async function admitGoldenLaunch(plan: LaunchPlan, { actor, id, forkEnv, allocationRisk }: GoldenAdmission) {
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
  return provider
    .fork({
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
    })
    .catch((error) => {
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
