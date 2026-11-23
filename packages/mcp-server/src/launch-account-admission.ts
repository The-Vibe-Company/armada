import {
  type GoldenActor,
  type GoldenRecord,
  type Harness,
  type LaunchCredentialResolver,
  type LaunchOptions,
  launchFailureHelp,
  VaultError,
} from "@armada/core";
import type { launchCredentials } from "./launch-credentials.ts";
import { goldenRuntimePlacement } from "./provider-runtime-admission.ts";

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
  const placement = explicit ? undefined : goldenRuntimePlacement(options, golden.provider);
  const runtime = explicit ?? placement?.policy;
  if (!runtime) throw new VaultError("unavailable", "Runtime launch is unavailable for this golden.");
  const resolver: GoldenLaunchCredentials = placement?.credentials ?? credentials;

  const probe = async () => {
    try {
      const preference = await resolver.defaults?.(actor, harness);
      const selectedId = credentialId ?? preference?.credentialId ?? undefined;
      const resolved = resolver.resolveModel
        ? await resolver.resolveModel(actor, harness, selectedId, options.credentialVersion)
        : await resolver.resolve(actor, harness, selectedId, options.credentialVersion);
      return {
        preference,
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
  const account = await probe();
  return {
    placement,
    credentials: account ? pin(resolver, account) : resolver,
    options: { ...options, runtime },
  };
}
