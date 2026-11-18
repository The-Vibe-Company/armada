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
  credentials: LaunchCredentialResolver,
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

  const prepare = async (resolver: LaunchCredentialResolver, requestedId = credentialId) => {
    const preference = await resolver.defaults?.(actor, harness);
    const selectedId = requestedId ?? preference?.credentialId ?? undefined;
    const resolved = await resolver.resolve(actor, harness, selectedId, options.credentialVersion);
    return {
      selectedId,
      resolved,
      resolver: {
        ...resolver,
        defaults: async () => preference,
        resolve: async (...args: Parameters<LaunchCredentialResolver["resolve"]>) =>
          args[2] === selectedId && args[3] === options.credentialVersion ? resolved : resolver.resolve(...args),
      },
    };
  };
  if (runtimeDefault) {
    const prepared = await prepare(runtimeDefault.credentials);
    requireLaunchAccountBinding(prepared.resolved.binding);
    const selected = { ...runtimeDefault, credentials: prepared.resolver };
    return {
      credentials,
      options:
        golden.provider === "modal"
          ? { ...options, modalRuntimeDefault: selected }
          : { ...options, boatRuntimeDefault: selected },
    };
  }

  const prepared = await prepare(credentials);
  if (explicit) requireLaunchAccountBinding(prepared.resolved.binding);
  else if (endpoint && (prepared.resolved.env[CLAUDE_ENDPOINT_ENV] || prepared.resolved.env[CODEX_ENDPOINT_ENV])) {
    const enrolled = await prepare(endpoint.credentials, prepared.selectedId);
    requireLaunchAccountBinding(enrolled.resolved.binding);
    options = { ...options, boatEndpointRuntime: { ...endpoint, credentials: enrolled.resolver } };
  }
  return { credentials: prepared.resolver, options };
}
