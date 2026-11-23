import type { ModalBinding, Provider, Sql } from "@armada/core/server";
import {
  createModalMachine,
  type Machine as ModalRecord,
  prepareFilesystemSnapshot,
  scopeKey,
} from "@armada/provider-modal";
import type { Job, JobKind } from "./jobs/runner.ts";
import { createJobsStore, withJobLease } from "./jobs/store.ts";
import { recordUnconfirmedModalStop, settleModalStop } from "./sandbox-lifecycle.ts";
import { captureFinalOutputs } from "./sandbox-outputs.ts";

type CleanupMachine = Parameters<typeof import("./jobs/modal-launch.ts").createModalLaunchCleanupJob>[1];
type OpenMachine = (
  ...args: Parameters<CleanupMachine>
) => Promise<Awaited<ReturnType<CleanupMachine>> & { canUseModalCredential(tx: Sql): Promise<boolean> }>;

export function createModalStopJob(
  sql: Sql,
  key: string,
  open: OpenMachine,
  providerFor: (id: string) => Promise<Provider>,
) {
  const jobs = createJobsStore(sql, key);
  return {
    concurrency: 4,
    async run(job, { signal, canDispatch }) {
      const retry = { status: "retry", after: new Date(Date.now() + 1_000) } as const;
      if (!job.sandbox_id || !job.generation) return { status: "fail", reason: "modal_stop_identity_missing" };
      const reconcile = {
        status: "retry",
        after: new Date(Date.now() + 60_000),
        commit: (tx: Sql) => recordUnconfirmedModalStop(tx, job.sandbox_id!, job.generation!),
      } as const;
      const sandboxId = job.sandbox_id;
      const generation = Number(job.generation);
      try {
        const {
          retain: requestedRetention = false,
          checkpoint: admittedCheckpoint = null,
          captured = false,
        } = (job.outcome as {
          retain?: boolean;
          checkpoint?: { epoch: string; watermark: number };
          captured?: boolean;
        } | null) ?? {};
        const target = await withJobLease(
          sql,
          job,
          async (tx) =>
            (
              await tx.query<{
                owner_id: string;
                org_id: string;
                visibility: "org" | "private";
                provider_sandbox_id: string;
                deadline_at: Date;
                app_name: string;
                binding: ModalBinding;
                authority_scope: "org" | "user";
                authority_owner_id: string;
                record: ModalRecord;
                scope: string;
              }>(
                `select s.owner_id,s.org_id,s.visibility,s.provider_sandbox_id,j.deadline_at,
               a.app_name,a.authority_scope,a.authority_owner_id,
               jsonb_build_object('appId',a.app_id,'environment',a.environment,'workspace',g.modal_workspace) as binding,
               m.record,m.scope
             from public.sandboxes s join public.jobs j on j.id=$3
             join public.goldens g on g.id=s.golden_id
             join public.modal_server_apps a on a.org_id=s.org_id and a.app_id=g.modal_app_id and a.environment=g.modal_environment
             join public.modal_machines m on m.id=s.provider_sandbox_id and m.org_id=s.org_id and m.owner_id=s.owner_id
               and m.visibility=s.visibility
             join public.members member on member.org_id=s.org_id and member.user_id=s.owner_id
             where s.id=$1 and s.lifecycle_generation=$2 and s.provider='modal' and s.runtime_transport='dialout'
               and s.deleted_at is null and s.stopped_at is null and s.stop_requested_at is not null
               and (m.lease_until is null or m.lease_until<=clock_timestamp())
               and (s.activity_until is null or s.activity_until<=clock_timestamp())
               and (s.reconcile_lease_until is null or s.reconcile_lease_until<=clock_timestamp())`,
                [sandboxId, generation, job.id],
              )
            ).rows,
        );
        const [row] = target ?? [];
        if (!row || target?.length !== 1) return (await canDispatch()) ? retry : reconcile;
        const { record, binding } = row;
        const machineId = record.physicalId;
        const scope = scopeKey({ binding, orgId: row.org_id, userId: row.owner_id, visibility: row.visibility });
        if (
          scope !== row.scope ||
          !machineId ||
          record.info.id !== row.provider_sandbox_id ||
          !record.commonRuntime ||
          record.golden ||
          !record.managementAuthority ||
          record.managementAuthority.credentialScope !== row.authority_scope ||
          record.managementAuthority.credentialOwnerId !== row.authority_owner_id
        )
          return reconcile;
        const prior = record.runtimeCheckpoint;
        const retainedStop =
          prior?.physicalId === machineId &&
          prior.generation === record.generation &&
          ["snapshot", "terminate", "stopped"].includes(record.phase);
        const retain = requestedRetention || retainedStop;
        const checkpoint = retainedStop ? { epoch: prior.epoch, watermark: prior.watermark } : admittedCheckpoint;
        const ports = await open(
          {
            appName: row.app_name,
            binding,
            credentialScope: row.authority_scope,
            credentialOwnerId: row.authority_owner_id,
          },
          signal,
        );
        try {
          const address = { sandboxId, generation: record.generation, machineId };
          const request = { ...address, signal };
          const allowed = async (tx: Sql) => {
            const { rows } = await tx.query(
              `select 1 from public.members member join public.sandboxes s on s.org_id=member.org_id and s.owner_id=member.user_id
               join public.modal_machines m on m.scope=$2 and m.id=s.provider_sandbox_id
               where s.id=$1 and s.deleted_at is null and s.stop_requested_at is not null and m.record->>'physicalId'=$3
                 and m.record->>'generation'=$4 and (m.lease_until is null or m.lease_until<clock_timestamp())
                 and (not $5::boolean or exists(select 1 from public.runtime_checkpoints p
                   join public.runtime_enrolments r on r.sandbox_id=p.sandbox_id and r.epoch=p.epoch
                   where p.sandbox_id=s.id and p.epoch=$6 and p.watermark=$7 and p.completed_at is not null
                     and not s.application_secret_tainted
                     and p.watermark=(select coalesce(max(sequence),0) from public.runtime_events where sandbox_id=s.id)))`,
              [
                sandboxId,
                scope,
                machineId,
                String(record.generation),
                retain,
                checkpoint?.epoch ?? null,
                checkpoint?.watermark ?? null,
              ],
            );
            return rows.length === 1 && (await ports.canUseModalCredential(tx)) && (await canDispatch(tx));
          };
          const authorizeStop = async () => {
            const live = await withJobLease(sql, job, allowed);
            if (!live) throw Error("Modal stop no longer owns dispatch.");
            signal.throwIfAborted();
          };
          const machine = createModalMachine({
            ...ports,
            journal: jobs.modalStopJournal(job, allowed),
            authorizeStop,
            existing: {
              machine: address,
              ...(retainedStop
                ? {
                    retainedStop:
                      record.phase === "snapshot" || !record.recoveryImageId
                        ? { snapshotDispatched: true }
                        : { recoveryImageId: record.recoveryImageId },
                  }
                : {}),
              ...(record.info.name === sandboxId && machineId === row.provider_sandbox_id
                ? {}
                : {
                    ownershipTags: {
                      armada_scope: scope,
                      armada_sandbox: record.info.id,
                      armada_generation: String(record.generation),
                    },
                  }),
            },
            async prepareCheckpoint(_request, physical) {
              if (!checkpoint || !Number.isSafeInteger(checkpoint.watermark))
                throw Error("Modal checkpoint proof unavailable.");
              signal.throwIfAborted();
              await prepareFilesystemSnapshot(physical, record);
            },
          });
          let observation = await machine.observe(request);
          let recovery =
            observation.kind === "present" && observation.receipt?.operation === "stop"
              ? observation.receipt.retained
              : null;
          if (observation.kind !== "present" || observation.phase !== "stopped") {
            if (!(await canDispatch())) return reconcile;
            const captureMs = Math.min(12_000, +new Date(row.deadline_at) - Date.now() - 5_000);
            if (!captured && observation.kind === "present" && observation.phase === "running" && captureMs > 0) {
              const captureSignal = AbortSignal.any([signal, AbortSignal.timeout(captureMs)]);
              await captureFinalOutputs(sql, () => providerFor(sandboxId), sandboxId, {
                key,
                signal: captureSignal,
                expectedGeneration: job.generation!,
                async onPublish(tx) {
                  if (!(await allowed(tx)) || !(await jobs.checkpointStopCapture(tx, job)))
                    throw Error("Modal stop capture lost its lease.");
                },
              }).catch(() => {});
              await withJobLease(sql, job, async (tx) => jobs.checkpointStopCapture(tx, job));
            }
            await authorizeStop();
            const remaining = +new Date(row.deadline_at) - Date.now();
            if (remaining <= 0) return reconcile;
            await machine.stop({
              ...request,
              retain,
              signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
            });
            observation = await machine.observe(request);
            recovery =
              observation.kind === "present" && observation.receipt?.operation === "stop"
                ? observation.receipt.retained
                : null;
          }
          if (observation.kind !== "present" || observation.phase !== "stopped")
            return (await canDispatch()) ? retry : reconcile;
          const retentionLost = retain && (!recovery || !checkpoint);
          return {
            status: "done",
            async commit(tx) {
              await finishModalStop(tx, job, row, recovery?.ref, checkpoint, retentionLost);
            },
          };
        } finally {
          await ports.close();
        }
      } catch {
        signal.throwIfAborted();
        return (await canDispatch()) ? retry : reconcile;
      }
    },
  } satisfies JobKind;
}

async function finishModalStop(
  tx: Sql,
  job: Job,
  target: { scope: string; provider_sandbox_id: string; record: ModalRecord },
  recoveryImageId: string | undefined,
  checkpoint: { epoch: string; watermark: number } | null,
  retentionLost: boolean,
) {
  const { record } = target;
  const stoppedAt = new Date();
  const written = await tx.query(
    `update public.modal_machines set record=(record-'runtimeResumeGeneration'-'runtimeCheckpoint'-'recoveryImageId') || $4::jsonb ||
        jsonb_build_object('info',record->'info' || $5::jsonb)
     where scope=$1 and id=$2 and record->>'physicalId'=$3
       and record->>'generation'=$6 and (lease_until is null or lease_until<clock_timestamp())
       and exists(select 1 from public.sandboxes s where s.id=$7 and s.lifecycle_generation=$8
         and s.provider_sandbox_id=$2 and s.deleted_at is null and s.stop_requested_at is not null)
     returning id`,
    [
      target.scope,
      target.provider_sandbox_id,
      record.physicalId,
      JSON.stringify({
        phase: "stopped",
        ...(record.recoveryImageId && record.recoveryImageId !== recoveryImageId
          ? { retainedRecoveryIds: [...(record.retainedRecoveryIds ?? []), record.recoveryImageId] }
          : {}),
        ...(recoveryImageId && checkpoint
          ? {
              recoveryImageId,
              runtimeCheckpoint: { ...checkpoint, physicalId: record.physicalId, generation: record.generation },
            }
          : {}),
      }),
      JSON.stringify({ state: "stopped", providerState: "stopped", stoppedAt }),
      String(record.generation),
      job.sandbox_id,
      job.generation,
    ],
  );
  if (!written.rows.length) throw Error("Modal stop recovery handoff lost its incarnation.");
  await settleModalStop(tx, job.sandbox_id!, job.generation!, stoppedAt, retentionLost);
}
