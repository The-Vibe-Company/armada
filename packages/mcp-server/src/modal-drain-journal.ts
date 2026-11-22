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

export function hasModalDrainExitProof(record: string) {
  return `jsonb_typeof(${record}->'generation')='number'
    and ${record}->'deletePhysicalExitGeneration'=${record}->'generation'`;
}

export function isFullModalDrainTombstone(record: string) {
  return `${record}->>'phase'='deleted'
    and ${record}->>'deleteScope' is distinct from 'physical-only'
    and ${hasModalDrainExitProof(record)}`;
}

export async function lockFullModalDrainTombstone(tx: Sql, id: string) {
  // WARNING: Modal ingest takes the sandbox and journal locks in reverse order.
  const {
    rows: [journal],
  } = await tx.query<{ scope: string; id: string; lease_id: string | null }>(
    `select m.scope,m.id,m.lease_id
     from public.sandboxes s join public.modal_machines m
       on m.org_id=s.org_id and m.owner_id=s.owner_id and m.id=s.provider_sandbox_id
     join public.sandbox_native_preservation_receipts r on r.sandbox_id=s.id
     where s.id=$1 and m.record->>'commonRuntime' is distinct from 'true'
       and ${isFullModalDrainTombstone("m.record")}
       and r.capture_acknowledgements->>'drainAdmissionGeneration'=m.record->>'generation'
       and 1=(select count(*) from public.modal_machines placement
         where placement.org_id=s.org_id and placement.id=s.provider_sandbox_id)
       and ${availableJournal}
     for update of m nowait`,
    [id],
  );
  return !!journal && (!journal.lease_id || (await withdrawExpiredModalDrainLease(tx, journal, journal.lease_id)));
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

const historicalModalCohort = `s.provider='modal' and not s.boat_runtime
  and s.runtime_transport is distinct from 'dialout'
  and s.status in ('stopped','failed') and s.stopped_at is not null and s.deleted_at is null
  and not s.application_secret_tainted and s.created_at < timestamptz '2026-11-22 00:00:00+00'
  and not exists(select 1 from public.sandbox_native_preservation_receipts r where r.sandbox_id=s.id)`;

const historicalJournalMatch = `m.org_id=s.org_id and m.owner_id=s.owner_id and m.id=s.provider_sandbox_id
  and m.record->>'commonRuntime' is distinct from 'true'
  and jsonb_typeof(m.record->'generation')='number'
  and 1=(select count(*) from public.modal_machines placement
    where placement.org_id=s.org_id and placement.id=s.provider_sandbox_id)`;
const historicalAdmissionStamp = `jsonb_build_object('sandboxId',s.id,'physicalGeneration',m.record->'generation')`;
const availableJournal = `((m.lease_id is null and m.lease_until is null)
  or (m.lease_id is not null and m.lease_until<=clock_timestamp()))`;
const historicalTombstone = `m.record->>'phase'='deleted' and (
  m.record->'deletePhysicalExitGeneration'=m.record->'generation'
  or (s.stop_requested_at is not null and m.record->'deletePhysicalExitGeneration' is null)
)`;

const historicalReplay = `m.record->'historicalDrainAdmission'=${historicalAdmissionStamp}
  and (
    (${historicalTombstone}) or (s.stop_requested_at is null and (
      m.record->>'phase'='stopped' or (m.record->>'phase'='deleting'
        and m.record->'deletePhysicalExitGeneration'=m.record->'generation')
    ))
  )`;

const historicalAdmission = `case when s.native_drain_pending then ${historicalReplay}
  else m.record->'historicalDrainAdmission' is null and (
    (s.stop_requested_at is null and m.record->>'phase'='stopped')
    or (${historicalTombstone})
  ) end`;

const managedHistoricalJournal = `s.stop_requested_at is null
  and (m.record->'deleteScope' is null or m.record->>'deleteScope'='physical-and-retained')
  and case when m.record->>'phase' in ('deleting','deleted')
    then ${hasModalDrainExitProof("m.record")}
    else m.record->'deletePhysicalExitGeneration' is null or ${hasModalDrainExitProof("m.record")}
  end`;

export function historicalModalDrainCandidate(managed: boolean) {
  return `${historicalModalCohort} and exists (
    select 1 from public.modal_machines m
    where ${historicalJournalMatch} and ${availableJournal}
      and ${managed ? managedHistoricalJournal : "true"} and ${historicalAdmission}
  )`;
}

export async function lockHistoricalManagedModalTombstone(tx: Sql, id: string) {
  // WARNING: Modal ingest can acquire the journal before the sandbox.
  const {
    rows: [journal],
  } = await tx.query<{ scope: string; id: string; lease_id: string | null }>(
    `select m.scope,m.id,m.lease_id
     from public.sandboxes s join public.modal_machines m on ${historicalJournalMatch}
     where s.id=$1 and ${historicalModalCohort} and not s.native_drain_pending
       and ${availableJournal} and m.record->'historicalDrainAdmission' is null
       and m.record->>'phase'='deleted'
       and (m.record->'deleteScope' is null or m.record->>'deleteScope'='physical-and-retained')
       and (
         ${hasModalDrainExitProof("m.record")}
         or (s.stop_requested_at is not null and m.record->'deletePhysicalExitGeneration' is null
           and m.record->'deleteScope' is null and m.record->>'recoveryImageId' is null
           and coalesce(m.record->'retainedRecoveryIds','[]'::jsonb)='[]'::jsonb)
       )
     for update of m nowait`,
    [id],
  );
  return !!journal && (!journal.lease_id || (await withdrawExpiredModalDrainLease(tx, journal, journal.lease_id)));
}

export function historicalModalDrainPhase(allow: string, managed = false) {
  return `case when ${allow} and ${historicalModalCohort} then (
    select m.record->>'phase' from public.modal_machines m
    where ${historicalJournalMatch} and ${availableJournal} and ${historicalReplay}
      and ${managed ? managedHistoricalJournal : "true"}
    for update of m nowait
  ) end`;
}

export async function admitHistoricalModalDrain(tx: Sql, id: string, pending: boolean, managed = false) {
  // WARNING: Modal ingest can lock the journal before the sandbox. Refuse contention without waiting.
  const {
    rows: [journal],
  } = await tx.query<{
    scope: string;
    id: string;
    lease_id: string | null;
    stamp: Record<string, unknown>;
  }>(
    `select m.scope,m.id,m.lease_id,${historicalAdmissionStamp} as stamp
     from public.sandboxes s join public.modal_machines m on ${historicalJournalMatch}
     where s.id=$1 and ${historicalModalCohort} and ${availableJournal}
       and ${historicalAdmission} and ${managed ? managedHistoricalJournal : "true"}
     for update of m nowait`,
    [id],
  );
  if (!journal) return false;
  if (journal.lease_id && !(await withdrawExpiredModalDrainLease(tx, journal, journal.lease_id))) return false;
  if (!pending) {
    await tx.query(
      `update public.modal_machines set record=jsonb_set(record,'{historicalDrainAdmission}',$3::jsonb)
       where scope=$1 and id=$2`,
      [journal.scope, journal.id, JSON.stringify(journal.stamp)],
    );
  }
  return true;
}
