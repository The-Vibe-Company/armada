import type { Sql } from "@armada/core/server";

export async function withdrawExpiredModalDrainLease(
  tx: Sql,
  journal: { scope: string; id: string },
  expiredToken: string,
) {
  const { rows } = await tx.query(
    `update public.modal_machines set lease_id=null,lease_until=null
     where scope=$1 and id=$2 and lease_id=$3 and lease_until<=clock_timestamp()
     returning id`,
    [journal.scope, journal.id, expiredToken],
  );
  return rows.length === 1;
}
