import type { CredentialKind, Sql } from "@armada/core";
import type { Caller } from "./caller.ts";
export type SandboxBillingAccount = {
  id: string;
  name: string;
  kind: CredentialKind;
  billing: "subscription" | "api-key";
  version: number;
};
/** Owner-only safe metadata. Includes plain Docker rows without inventing a golden join. */
export function createSandboxBillingAccount(sql: Sql) {
  return async (caller: Caller, id: string): Promise<SandboxBillingAccount | null> => {
    const row = (
      await sql.query<{ id: string; name: string; kind: CredentialKind; version: number }>(
        `select c.id,c.name,c.kind,s.credential_version as version from public.sandboxes s
       join public.credentials c on c.id=s.credential_id
       join public.members m on m.org_id=s.org_id and m.user_id=$2
       where s.id=$1 and s.owner_id=$2 and s.org_id=any($3::uuid[])
       and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
       and ((c.scope='user' and c.owner_id=$2) or (c.scope='org' and c.owner_id=s.org_id))`,
        [id, caller.userId, caller.orgs.map((membership) => membership.orgId)],
      )
    ).rows[0];
    return row
      ? { ...row, billing: row.kind === "codex_auth" || row.kind === "claude_oauth" ? "subscription" : "api-key" }
      : null;
  };
}
