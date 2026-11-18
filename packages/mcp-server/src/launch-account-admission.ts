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

  const probe = async (
    resolver: GoldenLaunchCredentials,
    requestedId = credentialId,
    version = options.credentialVersion,
  ) => {
    try {
      const preference = await resolver.defaults?.(actor, harness);
      const selectedId = requestedId ?? preference?.credentialId ?? undefined;
      const resolved = resolver.resolveModel
        ? await resolver.resolveModel(actor, harness, selectedId, version)
        : await resolver.resolve(actor, harness, selectedId, version);
      return {
        preference,
        selectedId,
        binding: resolved.binding,
        customEndpoint: Boolean(resolved.env[CLAUDE_ENDPOINT_ENV] || resolved.env[CODEX_ENDPOINT_ENV]),
      };
    } catch (error) {
      if (error instanceof VaultError && error.code === "credential_binding_required") throw error;
      return undefined;
    }
  };
  const pin = (resolver: LaunchCredentialResolver, account: NonNullable<Awaited<ReturnType<typeof probe>>>) => {
    const binding = requireLaunchAccountBinding(account.binding);
    return {
      ...resolver,
      defaults: async () => account.preference,
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
  if (endpoint && account.customEndpoint) {
    const enrolled = await probe(
      endpoint.credentials,
      account.binding?.credentialId ?? account.selectedId,
      account.binding?.credentialVersion,
    );
    if (!enrolled) return { credentials, options };
    return {
      credentials: account.binding ? pin(credentials, account) : credentials,
      options: {
        ...options,
        boatEndpointRuntime: { ...endpoint, credentials: pin(endpoint.credentials, enrolled) },
      },
    };
  }
  return { credentials, options };
}
