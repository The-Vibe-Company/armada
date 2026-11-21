import type { SandboxStatus } from "@armada/core";
import { unsettledRuntimeCommands } from "./runtime-idle-evidence.ts";

export interface StopRefusalEvidence {
  state: SandboxStatus;
  generation: string;
  activityLeaseId: string | null;
  activityLeaseHeld: boolean;
  reconcileLeaseHeld: boolean;
  requestGeneration?: string;
  stopRequested: boolean;
  launchJob: "queued" | "leased" | null;
  resumeDispatched: boolean;
  queuedTurn: boolean;
  runtimeWorkPending: boolean;
}

export const stopRefusalEvidence = `s.status::text as state, s.lifecycle_generation::text as generation,
  s.activity_lease_id as "activityLeaseId",
  coalesce(s.activity_until>=now(),false) as "activityLeaseHeld",
  coalesce(s.reconcile_lease_until>=now(),false) as "reconcileLeaseHeld",
  s.stop_requested_at is not null as "stopRequested",
  (select j.state from public.jobs j where j.sandbox_id=s.id
    and j.generation=s.lifecycle_generation and j.kind='launch' and j.state in ('queued','leased')
    order by (j.state='leased') desc limit 1) as "launchJob",
  exists(select 1 from public.runtime_resumes rr join public.runtime_enrolments r
    on r.sandbox_id=rr.sandbox_id and r.epoch=rr.target_epoch and r.lifecycle_generation=s.lifecycle_generation
    where rr.sandbox_id=s.id and rr.phase='dispatched') as "resumeDispatched",
  exists(select 1 from public.account_turn_queue q
    where q.sandbox_id=s.id and q.state in ('queued','dispatching')) as "queuedTurn",
  exists(${unsettledRuntimeCommands("s.id", "s.lifecycle_generation")}) as "runtimeWorkPending"`;
