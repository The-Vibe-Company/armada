import { launchInfrastructure } from "./sandbox-provider.ts";
/** Browser-safe capability for the account-change implementation, not a claim that a turn is idle. */
export const NATIVE_ACCOUNT_CHANGE_UNSUPPORTED =
  "This native Boat sandbox cannot refresh model accounts safely yet. Launch a new sandbox using the chosen account; existing work is unchanged (tracked by #1579).";
export function accountBindingAvailability(target: {
  provider: string;
  boatRuntime: boolean;
}): { available: true } | { available: false; reason: string } {
  return launchInfrastructure(target.provider).managedNativeAuthWriter && !target.boatRuntime
    ? { available: false, reason: NATIVE_ACCOUNT_CHANGE_UNSUPPORTED }
    : { available: true };
}
