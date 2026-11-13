import type { ApplicationSecretBinding } from "./application-secret-bindings.ts";
import { decryptSecret } from "./crypto.ts";
import type { Sql } from "./golden-store.ts";
import { VaultError } from "./vault-error.ts";

const unavailable = () => new VaultError("conflict", "Template launch refused: secret_unavailable.");
const changed = () => new VaultError("conflict", "Template launch refused: secret_version_changed.");

/** Publication checks metadata only. Call under current membership/admission transaction. */
export async function assertLaunchSecretBindings(
  sql: Sql,
  actor: { userId: string; orgId: string },
  bindings: readonly ApplicationSecretBinding[],
  orgOnly = false,
): Promise<void> {
  for (const binding of [...bindings].sort((a, b) => a.secretId.localeCompare(b.secretId))) {
    const row = (
      await sql.query<{ version: number; scope: string }>(
        `select v.version,v.scope from public.application_secrets v join public.members m on m.org_id=v.org_id and m.user_id=$3
       where v.id=$1 and v.org_id=$2 and v.status='active' and (v.expires_at is null or v.expires_at>now()) and (v.scope='org' or v.owner_id=$3) for share of v`,
        [binding.secretId, actor.orgId, actor.userId],
      )
    ).rows[0];
    if (!row || (orgOnly && row.scope !== "org")) throw unavailable();
    if (row.version !== binding.version) throw changed();
  }
}

/** Owner-approved raw delivery only: return transient plaintext, never retain it in a manifest.
 * Later turns recheck these same references; revoke/version changes cannot erase delivered copies.
 */
export async function resolveLaunchSecrets(
  sql: Sql,
  actor: { userId: string; orgId: string },
  bindings: readonly ApplicationSecretBinding[],
  key?: string,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const binding of [...bindings].sort((a, b) => a.secretId.localeCompare(b.secretId))) {
    const row = (
      await sql.query<{ value_enc: Uint8Array; version: number }>(
        `select v.value_enc,v.version from public.application_secrets v join public.members m on m.org_id=v.org_id and m.user_id=$3
       where v.id=$1 and v.org_id=$2 and v.status='active' and (v.expires_at is null or v.expires_at>now()) and (v.scope='org' or v.owner_id=$3) for share of v`,
        [binding.secretId, actor.orgId, actor.userId],
      )
    ).rows[0];
    if (!row) throw unavailable();
    if (row.version !== binding.version) throw changed();
    try {
      values[binding.key] = await decryptSecret(new Uint8Array(row.value_enc), key);
    } catch {
      throw unavailable();
    }
  }
  return values;
}
