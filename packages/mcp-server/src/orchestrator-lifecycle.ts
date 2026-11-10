import { createHash } from "node:crypto";
import type { Sql } from "@armada/core/server";
import { type OrchestratorDiagnosticLog, OrchestratorDiagnostics } from "./orchestrator-diagnostics.ts";
import {
  type LifecycleStopReceipt,
  lifecycleNow,
  type OrchestratorLifecycleRuntime,
  type OrchestratorMachine,
  sameMachine,
} from "./orchestrator-lifecycle-contract.ts";
import { orchestratorRuntimeOperations } from "./orchestrator-runtime-operation.ts";

/** A bounded batch for the EXISTING server lifecycle lane. No independent provider poller,
 * quota pacing, allocation freeze or deletion of logical/native history. Feature composition
 * stays absent until #662 supplies real native adapters and operator conformance. */
export function createOrchestratorLifecycle(
  sql: Sql,
  runtime: OrchestratorLifecycleRuntime,
  clock?: () => Date,
  diagnosticLog?: OrchestratorDiagnosticLog,
) {
  const operations = orchestratorRuntimeOperations();
  return {
    drain: operations.drain,
    async reconcileOne(signal?: AbortSignal): Promise<boolean> {
      if (!sql.transaction) throw new Error("Transactional orchestrator lifecycle required.");
      signal?.throwIfAborted();
      const now = await lifecycleNow(sql, clock);
      const lease = crypto.randomUUID();
      const row = (
        await sql.query<{
          orchestrator_id: string;
          sandbox_id: string;
          provider_sandbox_id: string;
          lifecycle_generation: string;
          parent_revision: string;
          expires_at: Date | string;
          stop_operation_id: string | null;
          stop_physical_generation: string | null;
          stop_reason: "idle" | "hard_ttl" | "epoch_expiry" | "owner_removed" | null;
        }>(
          `update public.orchestrator_lifecycle l set lease=$1,lease_until=$2::timestamptz+interval '2 minutes'
        where l.orchestrator_id=(select candidate.orchestrator_id from public.orchestrator_lifecycle candidate
        join public.orchestrators o on o.id=candidate.orchestrator_id
        join public.sandboxes s on s.id=o.sandbox_id
        where (o.state in ('ready','blocked') or (o.state='stopping' and candidate.stop_operation_id is not null)) and candidate.reconcile_after<=$2
        and (candidate.lease_until is null or candidate.lease_until<$2)
        order by candidate.reconcile_after for update of candidate skip locked limit 1)
        returning l.orchestrator_id,l.stop_operation_id,l.stop_reason,l.stop_physical_generation,
        (select revision from public.orchestrators where id=l.orchestrator_id) as parent_revision,
        (select sandbox_id from public.orchestrators where id=l.orchestrator_id) as sandbox_id,
        (select provider_sandbox_id from public.sandboxes where id=(select sandbox_id from public.orchestrators where id=l.orchestrator_id)) as provider_sandbox_id,
        (select lifecycle_generation from public.sandboxes where id=(select sandbox_id from public.orchestrators where id=l.orchestrator_id)) as lifecycle_generation,
        (select expires_at from public.sandboxes where id=(select sandbox_id from public.orchestrators where id=l.orchestrator_id)) as expires_at`,
          [lease, now],
        )
      ).rows[0];
      if (!row) return false;
      const machine: OrchestratorMachine = {
        orchestratorId: row.orchestrator_id,
        sandboxId: row.sandbox_id,
        providerSandboxId: row.provider_sandbox_id,
        generation: String(row.lifecycle_generation),
        ...(row.stop_physical_generation ? { physicalGeneration: row.stop_physical_generation } : {}),
      };
      const completeStop = async (
        operationId: string,
        reason: "idle" | "hard_ttl" | "epoch_expiry" | "owner_removed",
        fresh: boolean,
      ) => {
        const diagnostics = new OrchestratorDiagnostics(diagnosticLog, "stop", "lifecycle");
        diagnostics.bind({ operationId, orchestratorId: machine.orchestratorId, sandboxId: machine.sandboxId });
        diagnostics.stage(fresh ? "stop_dispatch" : "stop_reconcile");
        let result: LifecycleStopReceipt | undefined;
        try {
          signal?.throwIfAborted();
          result = await operations.run(
            () =>
              fresh
                ? runtime.stop(machine, reason, operationId, signal)
                : runtime.reconcileStop(machine, operationId, signal),
            signal,
          );
        } catch (error) {
          diagnostics.report("uncertain", error);
          /* Lost response is reconciled against the exact recorded operation, never replayed. */
        }
        diagnostics.stage("stop_validation");
        const ended = await lifecycleNow(sql, clock);
        const expired = new Date(row.expires_at) <= ended;
        const correlated =
          result &&
          typeof machine.physicalGeneration === "string" &&
          machine.physicalGeneration.length > 0 &&
          result.operationId === operationId &&
          sameMachine(machine, result);
        const confirmed = correlated && result?.state === "stopped" && result?.continuity === "native" && !expired;
        if (!confirmed)
          diagnostics.reportIfUnreported(
            "uncertain",
            undefined,
            expired
              ? "lifecycle_hard_ttl"
              : result?.continuity === "lost"
                ? "native_continuity_lost"
                : "native_stop_unconfirmed",
          );
        diagnostics.stage("lifecycle_publication");
        try {
          const published = await sql.query(
            `with eligible as (
          select o.id,o.revision,r.continuity as prior_continuity from public.orchestrators o
          join public.sandboxes s on s.id=o.sandbox_id
          join public.orchestrator_lifecycle l on l.orchestrator_id=o.id
          join public.orchestrator_runtime r on r.orchestrator_id=o.id
          where o.id=$1 and o.state in ('stopping','blocked')
          and s.id=$4 and s.provider_sandbox_id=$5 and s.lifecycle_generation=$6
          and l.lease=$2 and l.lease_until>$7 and l.stop_operation_id=$8 for update of o,s,l,r),
          published as (
          update public.orchestrators o set state=case when e.prior_continuity='lost' or $11='lost' then 'blocked' else $3 end
          from eligible e where o.id=e.id returning o.id,o.revision,o.state),
          lifecycle as (update public.orchestrator_lifecycle l set
            reason=case when e.prior_continuity='lost' or $11='lost' then 'native_state_lost' else $9 end,
            lease=null,lease_until=null,reconcile_after=$7::timestamptz+interval '1 minute'
            from eligible e,published p where l.orchestrator_id=e.id and p.id=e.id),
          receipt as (update public.orchestrator_operations op set
            state=case when p.state='stopped' and $10='succeeded' then 'succeeded' else 'uncertain' end,
            error_code=case when e.prior_continuity='lost' or $11='lost' then 'native_state_lost'
              when p.state='stopped' then null else $9 end
            from published p,eligible e where op.id=$8 and op.orchestrator_id=p.id and e.id=p.id),
          continuity as (update public.orchestrator_runtime r set
            continuity=case when e.prior_continuity='lost' or $11='lost' then 'lost' else $11 end,
            blocked_reason=case when e.prior_continuity='lost' or $11='lost' then 'native_state_lost'
              when p.state='stopped' then null else $9 end,updated_at=$7
            from published p,eligible e where r.orchestrator_id=p.id and e.id=p.id
            returning r.orchestrator_id,r.continuity)
          insert into public.orchestrator_runtime_events(orchestrator_id,revision,event)
            select p.id,p.revision,jsonb_build_object('kind','state','state',p.state,'continuity',c.continuity)
            from published p join continuity c on c.orchestrator_id=p.id returning orchestrator_id`,
            [
              machine.orchestratorId,
              lease,
              confirmed ? "stopped" : "blocked",
              machine.sandboxId,
              machine.providerSandboxId,
              machine.generation,
              ended,
              operationId,
              confirmed
                ? `${reason}_stopped_native`
                : expired
                  ? "hard_ttl_interrupted_continuity_unverified"
                  : "stop_outcome_unconfirmed",
              confirmed ? "succeeded" : "uncertain",
              correlated && result?.continuity === "lost" ? "lost" : confirmed ? "native" : "unverified",
            ],
          );
          if (published.rows.length === 0)
            diagnostics.report("publication_failed", undefined, "publication_fence_rejected");
        } catch (error) {
          diagnostics.report("publication_failed", error);
          throw error;
        }
      };
      if (row.stop_operation_id && row.stop_reason) {
        const recorded = (
          await sql.query(
            `select orchestrator_id from public.orchestrator_lifecycle
          where orchestrator_id=$1 and stop_generation=$2 and stop_sandbox_id=$3 and stop_provider_sandbox_id=$4`,
            [machine.orchestratorId, machine.generation, machine.sandboxId, machine.providerSandboxId],
          )
        ).rows[0];
        if (recorded) await completeStop(row.stop_operation_id, row.stop_reason, false);
        return true;
      }
      let observed: Awaited<ReturnType<OrchestratorLifecycleRuntime["observe"]>> | undefined;
      try {
        signal?.throwIfAborted();
        observed = await operations.run(() => runtime.observe(machine, signal), signal);
        signal?.throwIfAborted();
        if (!sameMachine(machine, observed) || !observed.evidence) observed = undefined;
        if (observed && !observed.physicalGeneration) observed = { ...observed, state: "unknown" };
        if (observed?.physicalGeneration) machine.physicalGeneration = observed.physicalGeneration;
      } catch {
        observed = undefined;
      }
      // Re-sample server time AFTER network I/O. A stale observation cannot retain a lease.
      const at = await lifecycleNow(sql, clock);
      const interrupted: { id: string; action: string }[] = [];
      const reason = await sql.transaction(async (tx) => {
        const current = (
          await tx.query<{
            lifecycle_generation: string;
            parent_revision: string;
            owner_id: string;
            org_id: string;
            parent_state: string;
            lifecycle_reason: string;
            idle_seconds: number;
            last_activity_at: Date | string;
            observation_state: string;
            member: boolean;
            expires_at: Date | string;
            epoch_expires_at: Date | string | null;
          }>(
            `select o.revision as parent_revision,o.owner_id,o.org_id,o.state as parent_state,l.reason as lifecycle_reason,s.lifecycle_generation,l.idle_seconds,l.last_activity_at,l.observation_state,
          exists(select 1 from public.members m where m.org_id=o.org_id and m.user_id=o.owner_id) as member,s.expires_at,
          (select min(d.expires_at) from public.orchestrator_delegations d where d.orchestrator_id=o.id
            and d.epoch=o.authority_epoch and d.revoked_at is null and d.acknowledged_at is not null) as epoch_expires_at
          from public.orchestrators o join public.sandboxes s on s.id=o.sandbox_id
          join public.orchestrator_lifecycle l on l.orchestrator_id=o.id
          where o.id=$1 and o.state in ('ready','blocked') and l.lease=$2 and l.lease_until>$3
          and s.id=$4 and s.provider_sandbox_id=$5 for update of o,s,l`,
            [machine.orchestratorId, lease, at, machine.sandboxId, machine.providerSandboxId],
          )
        ).rows[0];
        if (
          !current ||
          String(current.lifecycle_generation) !== machine.generation ||
          String(current.parent_revision) !== String(row.parent_revision) ||
          signal?.aborted
        )
          return null;
        let stop: "idle" | "hard_ttl" | "epoch_expiry" | "owner_removed" | null = null;
        let state: "active" | "unknown" | "quiescent" = observed?.state ?? "unknown";
        let code =
          state === "unknown" ? "runtime_unknown" : state === "active" ? "runtime_active" : "idle_cutoff_pending";
        const blockers = (
          await tx.query<{ children: boolean; operations: boolean; waits: boolean; capped: boolean }>(
            `select exists(select 1 from public.orchestrator_children c join public.sandboxes s on s.id=c.sandbox_id
             where c.orchestrator_id=$1 and s.status not in ('stopped','deleted') and not (s.status='failed' and s.stopped_at is not null)) as children,
           (exists(select 1 from public.orchestrator_child_operations where orchestrator_id=$1 and state in ('pending','uncertain'))
            or exists(select 1 from public.orchestrator_operations where orchestrator_id=$1 and state in ('pending','uncertain'))) as operations,
           exists(select 1 from public.orchestrator_waits where orchestrator_id=$1 and released_at is null) as waits,
           exists(select 1 from public.orchestrator_waits where orchestrator_id=$1 and released_at is null and deadline<=$2) as capped`,
            [machine.orchestratorId, at],
          )
        ).rows[0];
        if (!current.member) stop = "owner_removed";
        else if (new Date(current.expires_at).getTime() - at.getTime() <= 600_000) stop = "hard_ttl";
        else if (current.epoch_expires_at && new Date(current.epoch_expires_at).getTime() - at.getTime() <= 600_000)
          stop = "epoch_expiry";
        else if (current.parent_state === "blocked" && current.lifecycle_reason !== "wait_cap_exhausted") {
          // Retained failed compute still needs deadline/removal cleanup, never an idle inference.
          state = "unknown";
          code = current.lifecycle_reason;
        } else if (!blockers) {
          state = "unknown";
          code = "work_observation_unknown";
        } else if (blockers.operations) {
          state = "unknown";
          code = "operation_unresolved";
        } else if (blockers.capped) {
          // Exhaustion revokes admission, NOT native work/history. Never treat it as quiescence.
          if (current.parent_state !== "blocked") {
            await tx.query(`update public.orchestrators set state='blocked',revision=revision+1 where id=$1`, [
              machine.orchestratorId,
            ]);
            await tx.query(
              `update public.orchestrator_runtime set blocked_reason='wait_cap_exhausted',updated_at=$2 where orchestrator_id=$1`,
              [machine.orchestratorId, at],
            );
            await tx.query(
              `insert into public.orchestrator_runtime_events(orchestrator_id,revision,event)
              select o.id,o.revision,jsonb_build_object('kind','state','state','blocked','continuity',r.continuity)
              from public.orchestrators o join public.orchestrator_runtime r on r.orchestrator_id=o.id where o.id=$1`,
              [machine.orchestratorId],
            );
          }
          await tx.query(
            `update public.orchestrator_lifecycle set reason='wait_cap_exhausted',observation_state='unknown',
            reconcile_after=$3::timestamptz+interval '1 minute',lease=null,lease_until=null where orchestrator_id=$1 and lease=$2`,
            [machine.orchestratorId, lease, at],
          );
          return null;
        } else if (blockers.children) {
          state = "active";
          code = "child_active";
        } else if (blockers.waits) {
          state = "unknown";
          code = "wait_requires_evidence";
        } else if (
          state === "quiescent" &&
          current.observation_state === "quiescent" &&
          at.getTime() - new Date(current.last_activity_at).getTime() >= current.idle_seconds * 1000
        )
          stop = "idle";
        if (stop) {
          // Same parent lock as #661 admission and #662 operation reservation: stop wins
          // before any provider action, revoking epoch immediately through the 208 trigger.
          const digest = createHash("sha256")
            .update(JSON.stringify([current.owner_id, current.org_id, machine, stop]))
            .digest("hex");
          // Hard deadline/removal interrupts pending owner work explicitly; idle never preempts it.
          const interruptedRows = await tx.query<{ id: string; action: string }>(
            `update public.orchestrator_operations set state='uncertain',error_code=$2
            where orchestrator_id=$1 and state='pending' returning id,action`,
            [machine.orchestratorId, `lifecycle_${stop}`],
          );
          interrupted.push(...interruptedRows.rows);
          await tx.query(
            `insert into public.orchestrator_operations(id,orchestrator_id,actor_id,action,idempotency_key,request_digest,revision)
            values($1,$2,$3,'stop',$4,$5,$6)`,
            [
              lease,
              machine.orchestratorId,
              current.owner_id,
              `lifecycle:${lease}`,
              digest,
              Number(current.parent_revision) + 1,
            ],
          );
          await tx.query(`update public.orchestrators set state='stopping',revision=revision+1 where id=$1`, [
            machine.orchestratorId,
          ]);
          await tx.query(
            `update public.orchestrator_lifecycle set reason=$2,stop_operation_id=$3,stop_generation=$4,
            stop_sandbox_id=$5,stop_provider_sandbox_id=$6,stop_reason=$2,stop_dispatched=true,stop_physical_generation=$8,
            reconcile_after=$7::timestamptz+interval '1 minute' where orchestrator_id=$1`,
            [
              machine.orchestratorId,
              stop,
              lease,
              machine.generation,
              machine.sandboxId,
              machine.providerSandboxId,
              at,
              machine.physicalGeneration ?? null,
            ],
          );
          return stop;
        }
        if (current.parent_state === "blocked" && current.lifecycle_reason === "wait_cap_exhausted")
          code = "wait_cap_exhausted";
        await tx.query(
          `update public.orchestrator_lifecycle set observation_state=$3,observation_generation=$4,
          observation_evidence=$5,observed_at=$6,reason=$7,
          last_activity_at=case when $3='active' or (observation_state<>'quiescent' and $3='quiescent') then $6 else last_activity_at end,
          reconcile_after=$6::timestamptz+interval '1 minute',lease=null,lease_until=null
          where orchestrator_id=$1 and lease=$2`,
          [machine.orchestratorId, lease, state, machine.generation, observed?.evidence ?? null, at, code],
        );
        return null;
      });
      for (const operation of interrupted) {
        const diagnostics = new OrchestratorDiagnostics(diagnosticLog, operation.action, "lifecycle");
        diagnostics.bind({
          operationId: operation.id,
          orchestratorId: machine.orchestratorId,
          sandboxId: machine.sandboxId,
        });
        diagnostics.stage("lifecycle_interruption");
        diagnostics.report(
          "uncertain",
          undefined,
          reason === "idle"
            ? "lifecycle_idle"
            : reason === "owner_removed"
              ? "lifecycle_owner_removed"
              : reason === "epoch_expiry"
                ? "lifecycle_epoch_expiry"
                : "lifecycle_hard_ttl",
        );
      }
      if (!reason) return true;
      await completeStop(lease, reason, true);
      return true;
    },
  };
}
