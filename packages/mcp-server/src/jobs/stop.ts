import { type MachineIdentity, type Provider, ProviderError, type Sql, VaultError } from "@armada/core/server";
import type { ModalProvider } from "@armada/provider-modal";
import { createDockerHostStore, DockerHostDenied } from "../docker-host-store.ts";
import { DockerMachinePending } from "../docker-machine-adapter.ts";
import { createDockerOutputReader } from "../docker-outputs.ts";
import { scopedRuntimeSql } from "../runtime-enrolment.ts";
import { holdModalStop, recordDockerCleanupReceipt, settleModalStop, transitionSandbox } from "../sandbox-lifecycle.ts";
import { captureFinalOutputs, enqueueStopOutput, type StagedOutput } from "../sandbox-outputs.ts";
import { preserveBeforeStop } from "../work-preservation.ts";
import type { Job, JobContext, JobKind, JobResult } from "./runner.ts";
import { createJobsStore, mergeStopOutcome, withJobLease } from "./store.ts";
export interface DockerStopIntent {
  actor: { userId: string; orgId: string };
  actorEpoch: string;
  checkpoint: string;
  workMerged: boolean;
  machineId: string;
  generation: number;
  runtimeEpoch: string;
  daemonGeneration: string;
  hostId: string;
  installationId: string;
  captureUntil: number;
}
export function createStopJob(
  sql: Sql,
  key: string,
  readOutputs = createDockerOutputReader(sql, key),
  now = Date.now,
  resolveModal?: (sandboxId: string) => Promise<Provider>,
) {
  const hosts = createDockerHostStore(sql, key);
  const jobs = createJobsStore(sql, key);
  async function capture(
    job: Job,
    context: JobContext,
    provider: Provider | ReturnType<typeof readOutputs>,
    remaining: number,
  ) {
    if (remaining <= 0) return;
    await captureFinalOutputs(sql, provider, job.sandbox_id!, {
      key,
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(remaining)]),
      generation: job.generation!,
      async stage(tx: Sql, output: StagedOutput) {
        context.signal.throwIfAborted();
        if (!(await context.canDispatch(tx))) throw new Error("Stop capture claim changed.");
        await mergeStopOutcome(tx, job.id, { output });
      },
    }).catch(() => {});
  }

  const runModal: (job: Job, context: JobContext, sandboxId: string, generation: string) => Promise<JobResult> = async (
    job,
    context,
    sandboxId,
    generation,
  ) => {
    if (!resolveModal) return { status: "fail", reason: "modal_stop_unavailable" };
    const {
      rows: [target],
    } = await sql.query<{
      org_id: string;
      owner_is_member: boolean;
      provider_sandbox_id: string;
      status: "failed" | "stopping";
      retention_required: boolean;
      checkpoint: { epoch: string; watermark: number } | null;
      deadline_at: Date;
    }>(
      `select s.org_id,s.provider_sandbox_id,s.status,
       exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id) as owner_is_member,
       (coalesce(s.status_reason in ('idle_paused','work_merged'),false) or exists(
         select 1 from public.sandbox_transitions t where t.sandbox_id=s.id and t.generation=$2
           and t.code='runtime_retained_stop'
       )) as retention_required,
       p.checkpoint,j.deadline_at
       from public.sandboxes s join public.jobs j on j.id=$3
       left join lateral (
         select jsonb_build_object('epoch',p.epoch::text,'watermark',p.watermark) as checkpoint
         from public.runtime_enrolments r join public.runtime_checkpoints p on p.sandbox_id=r.sandbox_id and p.epoch=r.epoch
         where r.sandbox_id=s.id and not s.application_secret_tainted and p.completed_at is not null
           and p.watermark=(select coalesce(max(sequence),0) from public.runtime_events where sandbox_id=s.id)
       ) p on true
       where s.id=$1 and s.lifecycle_generation=$2 and s.provider='modal' and s.runtime_transport='dialout'
         and s.status in ('stopping','failed') and s.stop_requested_at is not null and s.stopped_at is null
         and s.provider_sandbox_id is not null and s.deleted_at is null`,
      [sandboxId, generation, job.id],
    );
    if (!target) return { status: "fail", reason: "modal_stop_target_changed" };
    const prior = job.outcome as {
      modal_checkpoint?: typeof target.checkpoint;
      modal_capture_complete?: boolean;
      modal_physical?: Pick<MachineIdentity, "machineId" | "generation">;
      output?: StagedOutput;
    } | null;
    const checkpoint = prior?.modal_checkpoint === undefined ? target.checkpoint : prior.modal_checkpoint;
    const retain = Boolean(checkpoint) || target.retention_required;
    const reconcileOnly = (retain && !checkpoint) || !(await context.canDispatch());
    const deadline = new Date(target.deadline_at).getTime();
    const write = async (work: (tx: Sql) => Promise<void>) => {
      const written = await withJobLease(sql, job, async (tx) => {
        context.signal.throwIfAborted();
        await work(tx);
        return true;
      });
      if (!written) throw new Error("Modal stop claim changed.");
      context.signal.throwIfAborted();
    };
    const { signal } = context;
    const retry = { status: "retry", after: new Date(now() + (reconcileOnly ? 30_000 : 1_000)) } satisfies JobResult;
    const hold = {
      status: "retry",
      after: new Date("9999-01-01T00:00:00Z"),
      async commit(tx) {
        await holdModalStop(tx, sandboxId, generation);
      },
    } satisfies JobResult;
    if (!target.owner_is_member) return hold;
    let retentionLost = false;
    try {
      const provider = (await resolveModal(sandboxId)) as ModalProvider;
      const { machine, physical, stopped } = await provider.runtimeStopMachine({
        recordId: target.provider_sandbox_id,
        sandboxId,
        generation: Number(generation),
        physical: prior?.modal_physical,
        checkpoint,
        write,
        reconcileOnly,
        deadlineAt: reconcileOnly ? undefined : deadline,
      });
      if (!reconcileOnly && !prior?.modal_physical)
        await write((tx) => mergeStopOutcome(tx, job.id, { modal_checkpoint: checkpoint, modal_physical: physical }));
      if (!reconcileOnly && !stopped && !prior?.modal_capture_complete && !prior?.output) {
        if (
          (await preserveBeforeStop(sql, provider, sandboxId, target.provider_sandbox_id, "lifecycle_stop", {
            kind: "job",
            token: `${job.id}:${job.lease_epoch}`,
            generation: Number(generation),
            signal,
          })) === "pending"
        )
          return retry;
        await capture(job, context, provider, deadline - 90_000 - now());
        await write((tx) => mergeStopOutcome(tx, job.id, { modal_capture_complete: true }));
      }
      if (!reconcileOnly && !(await context.canDispatch())) return retry;
      const remaining = deadline - now();
      if (!reconcileOnly && remaining <= 0) return retry;
      const stopSignal = reconcileOnly ? signal : AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
      signal.throwIfAborted();
      const retained = await machine.stop({
        machineId: physical.machineId,
        generation: Number(generation),
        sandboxId,
        retain,
        signal: stopSignal,
      });
      retentionLost = retain && retained === null;
      if (
        retained &&
        (retained.kind !== "image" || retained.generation !== Number(generation) || retained.sandboxId !== sandboxId)
      )
        return retry;
    } catch (error) {
      signal.throwIfAborted();
      if (
        (error instanceof VaultError &&
          ["missing_credential", "credential_refused", "forbidden"].includes(error.code)) ||
        (error instanceof ProviderError && ["unauthorized", "forbidden"].includes(error.code))
      )
        return hold;
      return retry;
    }
    return {
      status: "done",
      async commit(tx) {
        await settleModalStop(tx, sandboxId, generation, target.status, retentionLost);
        await enqueueStopOutput(tx, jobs, sandboxId, target.org_id, generation);
      },
    };
  };

  return {
    concurrency: 8,
    async run(job, context) {
      if (job.sandbox_id && job.generation && job.payload === null)
        return runModal(job, context, job.sandbox_id, job.generation);
      const intent = job.payload as DockerStopIntent | null;
      if (!job.sandbox_id || !job.generation || !intent) return { status: "fail", reason: "stop_intent_missing" };
      const sandboxId = job.sandbox_id;
      const target = { sandboxId, generation: intent.generation, machineId: intent.machineId };
      const { signal } = context;
      const retry = (delay = 2_000) => ({ status: "retry", after: new Date(now() + delay) }) satisfies JobResult;
      const finish = {
        status: "done",
        async commit(tx) {
          const settled = await recordDockerCleanupReceipt(tx, sandboxId, Number(job.generation), "stop");
          if (settled.kind !== "applied") throw new Error("Docker stop settlement changed generation.");
          await enqueueStopOutput(tx, jobs, sandboxId, intent.actor.orgId, settled.generation);
        },
      } satisfies JobResult;
      if (job.generation !== String(intent.generation)) {
        const outcome = await hosts.checkpointedStopOutcome(sandboxId, intent);
        signal.throwIfAborted();
        if (outcome === "stopped") return finish;
        if (outcome === "refused") return { status: "fail", reason: "stop_receipt_refused" };
        return retry((await context.canDispatch()) ? 2_000 : 30_000);
      }
      if (!(await context.canDispatch())) return { status: "fail", reason: "stop_dispatch_deadline" };
      if (!job.outcome)
        await capture(job, context, readOutputs(sandboxId, intent.runtimeEpoch), intent.captureUntil - now());
      signal.throwIfAborted();
      if (!(await context.canDispatch())) return { status: "fail", reason: "stop_dispatch_deadline" };
      try {
        await context.handoffGeneration({
          lockPrerequisites: (tx) => hosts.lockCheckpointedStop(tx, sandboxId, intent),
          async advance(tx) {
            const result = await transitionSandbox(tx, {
              sandboxId,
              expectedGeneration: intent.generation,
              fromStates: ["ready", "running"],
              toState: "stopping",
              actor: "idle",
              code: intent.workMerged ? "docker_work_merged" : "docker_idle_paused",
              effects: [],
            });
            if (result.kind === "conflict") throw new Error("Docker stop target changed.");
            const dispatch = createDockerHostStore(scopedRuntimeSql(tx), key).machineCleanup(intent.actor, intent);
            try {
              await dispatch.stop({ ...target, retain: true, signal });
            } catch (error) {
              if (!(error instanceof DockerMachinePending)) throw error;
            }
          },
        });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof DockerHostDenied) return { status: "fail", reason: "stop_authority_changed" };
        throw error;
      }
      return retry();
    },
  } satisfies JobKind;
}
