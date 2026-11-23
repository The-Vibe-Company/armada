import type { Sql } from "./golden-store.ts";
import { type ReadableVariableBinding, validateReadableVariables } from "./readable-variables.ts";
import { VaultError } from "./vault-error.ts";

/** Under launch admission's transaction: copy readable values once, never secret ciphertext.
 * Membership and personal/org visibility are enforced here independently of RLS.
 */
export async function resolveLaunchVariables(
  sql: Sql,
  actor: { userId: string; orgId: string },
  bindings: readonly ReadableVariableBinding[],
  orgOnly = false,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  if (!bindings.length) return values;
  const { rows } = await sql.query<{ id: string; value: string; version: number; scope: string }>(
    `select v.id,v.value,v.version,v.scope from public.readable_variables v
     join public.members m on m.org_id=v.org_id and m.user_id=$3
     where v.id=any($1::uuid[]) and v.org_id=$2 and v.status='active' and (v.scope='org' or v.owner_id=$3)
     order by v.id for share of v`,
    [bindings.map((binding) => binding.variableId), actor.orgId, actor.userId],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const binding of [...bindings].sort((a, b) => a.variableId.localeCompare(b.variableId))) {
    const row = byId.get(binding.variableId);
    if (!row || (orgOnly && row.scope !== "org"))
      throw new VaultError("conflict", "Template launch refused: variable_unavailable.");
    if (row.version !== binding.version)
      throw new VaultError("conflict", "Template launch refused: variable_version_changed.");
    values[binding.key] = row.value;
  }
  try {
    return validateReadableVariables(values);
  } catch {
    throw new VaultError("invalid", "Invalid readable-variable environment.");
  }
}
