import {
  type GoldenActor,
  type Harness,
  type LaunchCredentialResolver,
  LaunchError,
  OPENCODE_CONNECTION_PROVIDER,
  resolveModelChoice,
} from "@armada/core";
import { VaultError } from "@armada/core/server";
import { requireLaunchAccountBinding } from "./launch-account-admission.ts";

/** Resolve once before allocation. Omitting an ID delegates to the shared personal-first default policy. */
export async function resolveDockerLaunchAccount(
  credentials: Pick<LaunchCredentialResolver, "resolve">,
  actor: GoldenActor,
  request: { harness: Harness; credentialId: string | null; credentialVersion: number | null },
  selection: { model?: string | undefined; reasoningEffort?: string | undefined } = {},
) {
  if (request.credentialId === null && request.credentialVersion !== null)
    throw new VaultError("invalid", "An account revision requires an explicit account ID.");
  const resolved = await credentials.resolve(
    actor,
    request.harness,
    request.credentialId ?? undefined,
    request.credentialVersion ?? undefined,
  );
  const binding = requireLaunchAccountBinding(resolved.binding);
  if (
    (request.credentialId !== null && binding.credentialId !== request.credentialId) ||
    !Number.isSafeInteger(binding.credentialVersion) ||
    binding.credentialVersion < 1 ||
    (request.credentialVersion !== null && binding.credentialVersion !== request.credentialVersion)
  )
    throw new VaultError("credential_refused", "The selected account has no valid launch binding. Choose it again.");
  const models = resolved.morphModels;
  if (!models) return { resolved, binding };
  const prefix = request.harness === "opencode" ? `${OPENCODE_CONNECTION_PROVIDER}/` : "";
  const upstream = prefix && selection.model?.startsWith(prefix) ? selection.model.slice(prefix.length) : undefined;
  const model = upstream && models.includes(upstream) ? upstream : (selection.model ?? models[0]);
  if (model === undefined || !models.includes(model))
    throw new LaunchError("invalid_request", "Choose a Morph plan model configured on this account.");
  return {
    resolved,
    binding,
    modelChoice: resolveModelChoice(request.harness, { ...selection, model: `${prefix}${model}` }),
  };
}
