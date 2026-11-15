import {
  GOLDEN_SELECT,
  type GoldenRecord,
  type GoldenRow,
  mapGoldenRow,
  resolveOrg,
  type Sql,
  type VaultStore,
} from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { scopedOrg } from "./control-caller.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const columns = GOLDEN_SELECT.split(",")
  .map((column) =>
    column === "visibility" || column === "provider" ? `g.${column}::text as ${column}` : `g.${column}`,
  )
  .join(",");
type Membership = { selection_org_id: string; selection_name: string; selection_role: "admin" | "member" };
type Row = Membership & (GoldenRow | { id: null });

/** One snapshot for fresh selection authority and visible records; never widen the authenticated org set. */
export function createSqlGoldenList(sql: Sql, store: VaultStore) {
  return async (caller: Caller, ref: string | undefined): Promise<GoldenRecord[]> => {
    // Preserve the existing distinction between no selection and an explicit (possibly empty) ref.
    const bound = ref === undefined ? undefined : scopedOrg(caller, ref);
    const wanted = bound?.trim().toLowerCase();
    const orgIds = caller.orgs.map((org) => org.orgId.toLowerCase());
    if (bound === undefined && orgIds.length === 0) return [];
    const result = await sql.query<Row>(
      `with memberships as materialized (
         select o.id as selection_org_id, o.name as selection_name, m.role::text as selection_role
         from public.members m join public.orgs o on o.id=m.org_id where m.user_id=$2::uuid
           and ($3::uuid is null or m.org_id=$3::uuid)
       ), resources as (
         select ${columns}, g.visibility as sort_visibility from public.goldens g
         where g.org_id=any($1::uuid[]) and (g.visibility='org' or g.owner_id=$2::uuid)
           and g.removed_at is null and ($3::uuid is null or g.org_id=$3::uuid)
       )
       select resources.*, memberships.* from memberships
       left join resources on resources.org_id=memberships.selection_org_id
       order by lower(selection_name), selection_org_id, resources.name, resources.sort_visibility`,
      [orgIds, caller.userId, wanted && UUID.test(wanted) ? wanted : null],
    );
    const memberships = new Map(
      result.rows.map((row) => [
        row.selection_org_id,
        {
          id: row.selection_org_id,
          name: row.selection_name,
          role: row.selection_role,
        },
      ]),
    );
    // Core owns exact name/UUID/empty-ref semantics, including Unicode trim/case handling.
    // UUID requests are filtered in SQL; names read authorized rows and select here without another hop.
    const selected =
      bound === undefined
        ? undefined
        : await resolveOrg(
            {
              ...store,
              memberships: async () => [...memberships.values()],
            },
            caller.userId,
            bound,
          );
    const order = new Map(orgIds.map((id, index) => [id, index]));
    return result.rows
      .filter((row): row is Membership & GoldenRow => row.id !== null)
      .filter((row) => selected === undefined || row.org_id === selected.id)
      .map(mapGoldenRow)
      .sort((a, b) => order.get(a.orgId)! - order.get(b.orgId)!);
  };
}
