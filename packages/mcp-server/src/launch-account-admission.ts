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
import { runtimeBridgeProfiles } from "./provider-runtime-admission.ts";

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
  const { launchDefault, endpointDefault } = runtimeBridgeProfiles[golden.provider];
  const endpoint = endpointDefault ? options[endpointDefault] : undefined;
  let placement = explicit ? undefined : (options[launchDefault] ?? (harness === "opencode" ? endpoint : undefined));

  if (!explicit && !placement && !endpoint)
    throw new VaultError("unavailable", "Runtime launch is unavailable for this golden.");

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
        customEndpoint: Boolean(resolved.env[CLAUDE_ENDPOINT_ENV] || resolved.env[CODEX_ENDPOINT_ENV]),
        binding: resolved.binding,
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
    } satisfies LaunchCredentialResolver;
  };
  let resolver = placement?.credentials ?? credentials;
  const account = await probe(resolver);
  if (!explicit && !placement && endpoint && account?.customEndpoint) {
    placement = endpoint;
    resolver = endpoint.credentials;
  }
  const runtime = explicit ?? placement?.policy;
  if (!runtime) throw new VaultError("unavailable", "Runtime launch is unavailable for this golden.");
  return {
    placement,
    credentials: account ? pin(resolver, account) : resolver,
    options: { ...options, runtime },
  };
}
