import type { GoldenActor, Harness, LaunchCredentialResolver } from "@armada/core";
import { VaultError } from "@armada/core/server";

/** Resolve once before allocation. Omitting an ID delegates to the shared personal-first default policy. */
export async function resolveDockerLaunchAccount(
  credentials: Pick<LaunchCredentialResolver, "resolve">,
  actor: GoldenActor,
  request: { harness: Harness; credentialId: string | null; credentialVersion: number | null },
) {
  if (request.credentialId === null && request.credentialVersion !== null)
    throw new VaultError("invalid", "An account revision requires an explicit account ID.");
  const resolved = await credentials.resolve(
    actor,
    request.harness,
    request.credentialId ?? undefined,
    request.credentialVersion ?? undefined,
  );
  const binding = resolved.binding;
  if (
    !binding ||
    (request.credentialId !== null && binding.credentialId !== request.credentialId) ||
    !Number.isSafeInteger(binding.credentialVersion) ||
    binding.credentialVersion < 1 ||
    (request.credentialVersion !== null && binding.credentialVersion !== request.credentialVersion)
  )
    throw new VaultError("credential_refused", "The selected account has no valid launch binding. Choose it again.");
  return { resolved, binding };
}
