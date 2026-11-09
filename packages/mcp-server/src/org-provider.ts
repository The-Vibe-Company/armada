import {
  ProviderError,
  parseCredentialValue,
  parseModalTokenPair,
  resolveOrg,
  setCredential,
  VaultError,
  type VaultStore,
} from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { ModalClient } from "modal";
import type { Caller } from "./caller.ts";

export type ProviderValidator = (provider: "boat" | "modal", value: string) => Promise<void>;

/** Read-only authentication probes. SDK deadlines cancel the request; no persistence runs in a race. */
export const validateOrgProvider: ProviderValidator = async (provider, value) => {
  let modal: ModalClient | undefined;
  try {
    if (provider === "boat") {
      await createBoatProvider({ apiKey: value }).backendIdentity!();
    } else {
      const pair = parseModalTokenPair(value);
      modal = new ModalClient({
        ...pair,
        timeoutMs: 10_000,
        maxRetries: 0,
        maxThrottleWaitSecs: 0,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });
      await modal.cpClient.clientHello({}, { timeoutMs: 10_000, retries: 0 });
    }
  } catch (error) {
    const rejected =
      error instanceof ProviderError
        ? error.code === "unauthorized" || error.code === "forbidden"
        : typeof error === "object" && error !== null && "code" in error && (error.code === 16 || error.code === 7);
    throw new VaultError(
      rejected ? "invalid" : "unavailable",
      rejected ? "The provider rejected this credential." : "The provider is temporarily unavailable.",
    );
  } finally {
    modal?.close();
  }
};

export async function orgProviderStatus(store: VaultStore, caller: Caller, ref: string | undefined) {
  const org = await authorizedOrg(store, caller, ref);
  const rows = await store.listCredentials("org", org.id);
  const providers = [
    {
      provider: "boat" as const,
      configured: (await store.hasOrgBoatKey(org.id)) || rows.some((row) => row.kind === "boat"),
    },
    { provider: "modal" as const, configured: rows.some((row) => row.kind === "modal") },
  ];
  return { org, ready: providers.some((provider) => provider.configured), providers };
}

async function authorizedOrg(store: VaultStore, caller: Caller, ref: string | undefined) {
  const selected = ref ?? (caller.via === "supabase" ? undefined : caller.orgs[0]?.orgId);
  const org = await resolveOrg(store, caller.userId, selected);
  if (caller.via !== "supabase" && !caller.orgs.some((scope) => scope.orgId === org.id))
    throw new VaultError("not_found", "You are not a member of that org.");
  return org;
}

export async function connectOrgProvider(
  store: VaultStore,
  encryptionKey: string | undefined,
  caller: Caller,
  ref: string | undefined,
  provider: string,
  raw: string,
  validate: ProviderValidator,
) {
  const org = await authorizedOrg(store, caller, ref);
  if (org.role !== "admin") throw new VaultError("forbidden", "Only an org admin can do that.");
  if (provider !== "boat" && provider !== "modal") throw new VaultError("invalid", "Provider is boat or modal.");
  if (raw.length > 16_384) throw new VaultError("invalid", "The credential is too large.");
  const value = parseCredentialValue(provider, raw);
  try {
    await validate(provider, value);
  } catch (error) {
    // Only our fixed messages cross the public boundary, including injected adapters.
    if (error instanceof VaultError && error.code === "invalid")
      throw new VaultError("invalid", "The provider rejected this credential.");
    throw new VaultError("unavailable", "The provider is temporarily unavailable.");
  }
  await authorizedOrg(store, caller, org.id);
  // Shared encrypted org policy rechecks the current admin role after validation.
  await setCredential(store, encryptionKey, caller.userId, { scope: "org", org: org.id, kind: provider, value });
  return orgProviderStatus(store, caller, org.id);
}
