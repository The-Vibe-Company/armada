import type { GoldenActor, Harness, HarnessCredentials, LaunchCredentialResolver } from "@armada/core/server";
export interface NamedLaunchCredentials extends LaunchCredentialResolver {
  resolve(
    actor: GoldenActor,
    harness: Harness,
    credentialId?: string,
    credentialVersion?: number,
  ): Promise<HarnessCredentials>;
}
