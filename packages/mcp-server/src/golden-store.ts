import { GoldenError, type GoldenStore, type Sql } from "@armada/core";
import type { Caller } from "./caller.ts";

export const GOLDEN_VISIBLE = `g.org_id = any($1::uuid[]) and (g.visibility = 'org' or g.owner_id = $2::uuid)
  and exists(select 1 from public.members m where m.org_id=g.org_id and m.user_id=$2::uuid)`;

export function createScopedGoldenWrites(sql: Sql, caller: Caller, scope: [string[], string]) {
  const [orgIds] = scope;
  const writeGolden = async (id: string, column: "provider_sandbox_id" | "provider_snapshot_id", value: string) => {
    const admins = caller.orgs.filter((org) => org.role === "admin").map((org) => org.orgId);
    const alias = column === "provider_sandbox_id" ? "boat_sandbox_id" : "boat_snapshot_id";
    const firstMaster = column === "provider_sandbox_id" ? " and provider_sandbox_id is null" : "";
    const result = await sql.query<{ id: string }>(
      `update public.goldens set ${column} = $1, ${alias} = case when provider = 'boat' then $1 else null end
       where id = $2::uuid and org_id = any($3::uuid[])${firstMaster}
       and exists (select 1 from public.members m where m.org_id = goldens.org_id and m.user_id = $4::uuid
         and (goldens.visibility = 'private' or m.role = 'admin'))
       and ((visibility = 'private' and owner_id = $4::uuid) or (visibility = 'org' and org_id = any($5::uuid[]))) returning id`,
      [value, id, orgIds, caller.userId, admins],
    );
    if (!result.rows.length) throw new GoldenError("forbidden", "You cannot change this golden.");
  };
  return {
    async setSizePolicy(golden, actor, policy) {
      if (actor.userId !== caller.userId) throw new GoldenError("forbidden", "Caller mismatch.");
      const result = await sql.query(
        `update public.goldens g set size_policy=$4::text::jsonb where ${GOLDEN_VISIBLE}
         and g.id=$3::uuid and g.removed_at is null
         and not exists(select 1 from jsonb_object_keys(($4::text::jsonb)->'repositories') k
           where not exists(select 1 from jsonb_array_elements(g.config->'repos') r where r->>'dir'=k))
         and exists(
           select 1 from public.members m where m.org_id=g.org_id and m.user_id=$2::uuid
           and ((g.visibility='private' and g.owner_id=$2::uuid) or (g.visibility='org' and m.role='admin')))
         returning g.id`,
        [...scope, golden.id, JSON.stringify(policy)],
      );
      if (!result.rows.length) throw new GoldenError("forbidden", "You cannot change this golden's size policy.");
    },
    async compareAndSetSnapshot(id, expectedSnapshot, replacement, expectedSandbox) {
      const result = await sql.query(
        `update public.goldens g set provider_snapshot_id=$5,provider_sandbox_id=null
         where ${GOLDEN_VISIBLE} and g.id=$3 and g.provider='modal'
         and ((g.provider_snapshot_id is not distinct from $4 and g.provider_sandbox_id=$6)
           or (g.provider_snapshot_id=$5 and g.provider_sandbox_id is null))
         and exists(select 1 from public.members m where m.org_id=g.org_id and m.user_id=$2
           and ((g.visibility='private' and g.owner_id=$2) or (g.visibility='org' and m.role='admin')))
         returning g.id`,
        [...scope, id, expectedSnapshot, replacement, expectedSandbox],
      );
      return result.rows.length === 1;
    },
    setSandbox: (id, value) => writeGolden(id, "provider_sandbox_id", value),
    async replaceSandbox(id, expectedSandbox, expectedSnapshot, replacement) {
      const result = await sql.query<{ id: string }>(
        `update public.goldens g set provider_sandbox_id = $6, boat_sandbox_id = case when g.provider = 'boat' then $6 else null end
         where ${GOLDEN_VISIBLE} and g.id = $3::uuid and g.provider_sandbox_id is not distinct from $4 and g.provider_snapshot_id is not distinct from $5
           and exists (select 1 from public.members m where m.org_id = g.org_id and m.user_id = $2::uuid and (g.visibility = 'private' or m.role = 'admin'))
           and ((g.visibility = 'private' and g.owner_id = $2::uuid) or (g.visibility = 'org' and g.org_id = any($7::uuid[]))) returning g.id`,
        [
          ...scope,
          id,
          expectedSandbox,
          expectedSnapshot,
          replacement,
          caller.orgs.filter((o) => o.role === "admin").map((o) => o.orgId),
        ],
      );
      return result.rows.length === 1;
    },
    setSnapshot: (id, value) => writeGolden(id, "provider_snapshot_id", value),
    async recordSnapshot(id, expectedSandbox, snapshot) {
      const result = await sql.query<{ id: string }>(
        `update public.goldens g set provider_snapshot_id = $5, boat_snapshot_id = case when g.provider = 'boat' then $5 else null end where ${GOLDEN_VISIBLE}
         and g.id = $3::uuid and g.provider_sandbox_id is not distinct from $4
         and exists (select 1 from public.members m where m.org_id = g.org_id and m.user_id = $2::uuid and
           ((g.visibility = 'private' and g.owner_id = $2::uuid) or (g.visibility = 'org' and m.role = 'admin'))) returning g.id`,
        [...scope, id, expectedSandbox, snapshot],
      );
      return result.rows.length === 1;
    },
  } satisfies Pick<
    GoldenStore,
    "setSizePolicy" | "compareAndSetSnapshot" | "setSandbox" | "replaceSandbox" | "setSnapshot" | "recordSnapshot"
  >;
}
