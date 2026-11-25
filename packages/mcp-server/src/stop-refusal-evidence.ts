import type { SandboxStatus } from "@armada/core";
import { unresolvedResume } from "./modal-launch-handoff.ts";
import { unsettledRuntimeCommands } from "./runtime-idle-evidence.ts";

export interface StopRefusalEvidence {
  state: SandboxStatus;
  generation: string;
  activityLeaseId: string | null;
  activityLeaseHeld: boolean;
  reconcileLeaseHeld: boolean;
  requestGeneration?: string;
  stopRequested: boolean;
  deadlineElapsed: boolean;
  applicationSecretTainted: boolean;
  retainedCheckpointCurrent?: boolean | null;
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
  s.expires_at<=clock_timestamp() as "deadlineElapsed",
  s.application_secret_tainted as "applicationSecretTainted",
  (select j.state from public.jobs j where j.sandbox_id=s.id
    and j.generation=s.lifecycle_generation and j.kind='launch' and j.state in ('queued','leased')
    order by (j.state='leased') desc limit 1) as "launchJob",
  ${unresolvedResume("s")} as "resumeDispatched",
  exists(select 1 from public.account_turn_queue q
    where q.sandbox_id=s.id and q.state in ('queued','dispatching')) as "queuedTurn",
  exists(${unsettledRuntimeCommands("s.id", "s.lifecycle_generation")}) as "runtimeWorkPending"`;
