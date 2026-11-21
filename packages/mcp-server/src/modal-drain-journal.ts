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

type StrictNativeDrainJournal = {
  lockActive(tx: Sql, id: string): Promise<boolean>;
  hasRetainedCheckpoint(sql: Sql, id: string, generation: number, physicalGeneration?: string): Promise<boolean>;
};

export const strictNativeDrainJournals: Partial<Record<"boat" | "modal", StrictNativeDrainJournal>> = {
  modal: {
    async lockActive(tx, id) {
      // WARNING: Modal ingest can lock the journal before the sandbox. Refuse contention without waiting.
      const journal = await tx.query<{ eligible: boolean }>(
        `select (m.owner_id=s.owner_id and m.record->>'phase'='active'
           and m.record->>'commonRuntime' is distinct from 'true'
           and m.lease_id is null and m.lease_until is null) as eligible
         from public.modal_machines m join public.sandboxes s
           on m.org_id=s.org_id and m.id=s.provider_sandbox_id
         where s.id=$1 and s.provider='modal'
         for update of m nowait`,
        [id],
      );
      return journal.rows.length === 1 && journal.rows[0]?.eligible === true;
    },
    async hasRetainedCheckpoint(sql, id, generation, physicalGeneration) {
      if (!physicalGeneration) return false;
      const result = await sql.query(
        `select 1 from public.sandboxes s join public.modal_machines m
           on m.org_id=s.org_id and m.owner_id=s.owner_id and m.id=s.provider_sandbox_id
         join public.sandbox_native_preservation_receipts r on r.sandbox_id=s.id
         where s.id=$1 and s.lifecycle_generation=$2 and r.generation=s.lifecycle_generation
           and r.stop_generation=s.stop_generation
           and m.record->>'phase'='stopped' and nullif(m.record->>'recoveryImageId','') is not null
           and m.record->>'generation'=$3
           and r.capture_acknowledgements->>'physicalGeneration'=m.record->>'generation'`,
        [id, generation, physicalGeneration],
      );
      return result.rows.length === 1;
    },
  },
};
