import {
  assertProviderOf,
  type CredentialReader,
  type Provider,
  resolveBoatKey,
  resolveModalTokens,
  type SandboxProviderId,
  type Sql,
  VaultError,
} from "@armada/core/server";
import type { Caller } from "./caller.ts";

export interface GoldenProviderMetadata {
  provider: SandboxProviderId;
  /** Adapter capacity, not a live workspace quota or a claim of provider connectivity. */
  maxGoldens: number | null;
}
export type ProviderMetadataFor = (
  selection: { orgId: string; provider: SandboxProviderId },
  caller: Caller,
) => Promise<GoldenProviderMetadata>;

/** Credential-aware metadata only. Never resolves an App-bound resource or provisions infrastructure. */
export function createProviderMetadata(options: {
  sql: Sql;
  vault: CredentialReader;
  encryptionKey: string | undefined;
  providerFor(apiKey: string, caller?: { userId: string }): Provider;
}): ProviderMetadataFor {
  return async (selection, caller) => {
    // Token scope is narrower than all memberships a user may hold. Check before any secret read.
    if (!caller.orgs.some((org) => org.orgId === selection.orgId))
      throw new VaultError("forbidden", "This token is scoped to another org.");
    const member = await options.sql.query("select 1 from public.members where org_id=$1 and user_id=$2", [
      selection.orgId,
      caller.userId,
    ]);
    if (!member.rows.length) throw new VaultError("forbidden", "Organization membership required.");
    const credentialScope = { orgId: selection.orgId, userId: caller.userId, visibility: "org" as const };
    if (selection.provider === "modal") {
      await resolveModalTokens(options.vault, options.encryptionKey, credentialScope);
      // The pinned Modal adapter omits maxGoldens: its limit is unknown/unbounded, not a
      // workspace quota. Reading it does not imply connected App/resource state.
      return { provider: "modal", maxGoldens: null };
    }
    const credential = await resolveBoatKey(options.vault, options.encryptionKey, credentialScope);
    const adapter = options.providerFor(credential.key, caller);
    assertProviderOf(adapter, "boat");
    return { provider: "boat", maxGoldens: adapter.maxGoldens ?? null };
  };
}
