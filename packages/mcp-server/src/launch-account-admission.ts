import { type LaunchCredentialResolver, launchFailureHelp, VaultError } from "@armada/core";
import type { launchCredentials } from "./launch-credentials.ts";

export type GoldenLaunchCredentials = LaunchCredentialResolver &
  Partial<Pick<ReturnType<typeof launchCredentials>, "resolveModel">>;

export function requireLaunchAccountBinding(
  binding: Awaited<ReturnType<LaunchCredentialResolver["resolve"]>>["binding"],
) {
  if (!binding) throw new VaultError("credential_binding_required", launchFailureHelp("credential_binding_required")!);
  return binding;
}
