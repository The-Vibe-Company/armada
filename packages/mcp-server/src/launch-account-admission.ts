import {
  CLAUDE_ENDPOINT_ENV,
  CODEX_ENDPOINT_ENV,
  type GoldenActor,
  type GoldenRecord,
  type Harness,
  type LaunchCredentialResolver,
  type LaunchOptions,
  launchFailureHelp,
  VaultError,
} from "@armada/core";
import type { launchCredentials } from "./launch-credentials.ts";

export type GoldenLaunchCredentials = LaunchCredentialResolver &
  Partial<Pick<ReturnType<typeof launchCredentials>, "resolveModel">>;

export function requireLaunchAccountBinding(
  binding: Awaited<ReturnType<LaunchCredentialResolver["resolve"]>>["binding"],
) {
  if (!binding) throw new VaultError("credential_binding_required", launchFailureHelp("credential_binding_required")!);
  return binding;
}

/** Prepare the request's account before opening a provider. Reuse the selection during core launch. */
export async function prepareGoldenLaunchAccount(
  actor: GoldenActor,
  golden: GoldenRecord,
  request: { harness: Harness; credentialId?: string | undefined },
  credentials: GoldenLaunchCredentials,
  options: LaunchOptions,
) {
  const { harness, credentialId } = request;
  const explicit = options.runtime ?? options.boatRuntime;
  const endpoint = golden.provider === "boat" ? options.boatEndpointRuntime : undefined;
  const runtimeDefault = explicit
    ? undefined
    : golden.provider === "modal"
      ? options.modalRuntimeDefault
      : (options.boatRuntimeDefault ?? (harness === "opencode" ? endpoint : undefined));
  if (!explicit && !runtimeDefault && !endpoint) return { credentials, options };

  // A failure to resolve is still handled at the existing launch boundary. In
  // particular, a revoked account must not mask replay of a completed receipt.
  const probe = async (resolver: GoldenLaunchCredentials, requestedId = credentialId) => {
    try {
      const preference = await resolver.defaults?.(actor, harness);
      const selectedId = requestedId ?? preference?.credentialId ?? undefined;
      const resolved = resolver.resolveModel
        ? await resolver.resolveModel(actor, harness, selectedId, options.credentialVersion)
        : await resolver.resolve(actor, harness, selectedId, options.credentialVersion);
      return { preference, selectedId, resolved };
    } catch (error) {
      if (error instanceof VaultError && error.code === "credential_binding_required") throw error;
      return undefined;
    }
  };
  const pin = (
    resolver: LaunchCredentialResolver,
    account: NonNullable<Awaited<ReturnType<typeof probe>>>,
  ): LaunchCredentialResolver => {
    const binding = requireLaunchAccountBinding(account.resolved.binding);
    return {
      ...resolver,
      defaults: async () => account.preference,
      // Provider setup may take time. Reauthorize the exact selection rather
      // than carrying decrypted credentials across the provider await.
      resolve: (launchActor, launchHarness) =>
        resolver.resolve(launchActor, launchHarness, binding.credentialId, binding.credentialVersion),
    };
  };
  if (runtimeDefault) {
    const account = await probe(runtimeDefault.credentials);
    if (!account) return { credentials, options };
    const selected = { ...runtimeDefault, credentials: pin(runtimeDefault.credentials, account) };
    return {
      credentials,
      options:
        golden.provider === "modal"
          ? { ...options, modalRuntimeDefault: selected }
          : { ...options, boatRuntimeDefault: selected },
    };
  }

  const account = await probe(credentials);
  if (!account) return { credentials, options };
  if (explicit) return { credentials: pin(credentials, account), options };
  if (endpoint && (account.resolved.env[CLAUDE_ENDPOINT_ENV] || account.resolved.env[CODEX_ENDPOINT_ENV])) {
    const enrolled = await probe(endpoint.credentials, account.selectedId);
    if (!enrolled) return { credentials, options };
    const selected = { ...endpoint, credentials: pin(endpoint.credentials, enrolled) };
    return {
      credentials,
      // Use the preflighted route. Re-checking its native inputs after provider
      // setup could pick a different endpoint or a changed account default.
      options: { ...options, boatRuntimeDefault: selected },
    };
  }
  return { credentials, options };
}
