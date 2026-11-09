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
  bindings?: { goldenId: string; relation: "current_backend" | "other_backend" | "unbound" }[];
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
    const maxGoldens = adapter.maxGoldens ?? null;
    if (maxGoldens === null) return { provider: "boat", maxGoldens };
    const identity = await adapter.backendIdentity?.();
    if (!identity?.id) throw new VaultError("forbidden", "Provider backend identity is unavailable.");
    const bindings = await options.sql.query<{
      goldenId: string;
      relation: "current_backend" | "other_backend" | "unbound";
    }>(
      `select g.id as "goldenId",
        case when s.golden_id is null then 'unbound'
             when s.backend_id=$3 then 'current_backend' else 'other_backend' end as relation
       from public.goldens g
       left join public.golden_backend_slots s on s.golden_id=g.id and s.provider=g.provider::text
       where g.org_id=$1 and g.provider=$4
         and (g.visibility='org' or g.owner_id=$2)
       order by g.id`,
      [selection.orgId, caller.userId, identity.id, selection.provider],
    );
    return { provider: "boat", maxGoldens, bindings: bindings.rows };
  };
}
