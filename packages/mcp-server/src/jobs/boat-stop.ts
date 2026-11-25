import {
  createSqlVaultStore,
  type Machine,
  type MachineIdentity,
  ProviderError,
  resolveBoatKey,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { createBoatMachine } from "@armada/provider-boat";
import { createObservedBoatProvider } from "../observed-boat.ts";
import { holdUnconfirmedBoatStop, settleBoatStop } from "../sandbox-lifecycle.ts";
import { enqueueStopOutput, type OutputReader, stageStopOutputs } from "../sandbox-outputs.ts";
import { runtimePreservationNote } from "../work-preservation.ts";
import type { Job, JobContext, JobResult } from "./runner.ts";
import { createJobsStore } from "./store.ts";

type ExitEvidence = { stoppedAt: Date | undefined };

type Target = MachineIdentity & {
  orgId: string;
  ownerId: string;
  visibility: "org" | "private";
  launchGeneration: number | null;
  backendId: string | null;
  scope: string | null;
  deadline: number;
  retain: boolean;
};

function boatStopMachine(sql: Sql, key: string, deploymentId: string) {
  return async (target: Target, authorize: () => Promise<void>) => {
    const credential = () =>
      resolveBoatKey(createSqlVaultStore(sql), key, {
        userId: target.ownerId,
        orgId: target.orgId,
        visibility: target.visibility,
      });
    const member = await sql.query("select 1 from public.members where org_id=$1 and user_id=$2", [
      target.orgId,
      target.ownerId,
    ]);
    if (!member.rows.length) throw new VaultError("forbidden", "Boat stop authority unavailable.");
    const authority = await credential();
    const options = { apiKey: authority.key, deploymentId };
    const host = createObservedBoatProvider(options, target.sandboxId);
    if (target.scope !== null && authority.scope !== target.scope)
      throw new VaultError("forbidden", "Boat authority changed.");
    const backend = await host.backendIdentity?.();
    if (target.backendId !== null && backend?.id !== target.backendId)
      throw new VaultError("forbidden", "Boat authority changed.");
    const { sandboxId, generation, machineId, launchGeneration, orgId, ownerId } = target;
    const stopBinding = {
      sandboxId,
      generation,
      machineId,
      ...(launchGeneration === null ? { orgId, ownerId } : { launchGeneration }),
    };
    let exit: ExitEvidence | undefined;
    const machine = createBoatMachine(
      {
        ...options,
        stopBinding,
        onStopped: (value) => {
          exit = { stoppedAt: value };
        },
      },
      host,
      async () => null,
      async () => {
        const current = await credential();
        if (current.key !== authority.key || current.scope !== authority.scope) throw Error("Boat authority changed.");
        await authorize();
      },
    );
    return { machine, outputs: host, exitEvidence: () => exit };
  };
}

export function createBoatStop(
  sql: Sql,
  key: string,
  deploymentId: string,
  now: () => number,
  resolve: (
    target: Target,
    authorize: () => Promise<void>,
  ) => Promise<{
    machine: Pick<Machine, "observe" | "stop">;
    outputs: OutputReader;
    exitEvidence?: () => ExitEvidence | undefined;
  }> = boatStopMachine(sql, key, deploymentId),
) {
  const jobs = createJobsStore(sql, key);
  const run: (job: Job, context: JobContext) => Promise<JobResult> = async (job, context) => {
    const {
      rows: [row],
    } = await sql.query<Omit<Target, "generation" | "launchGeneration"> & { launchGeneration: string | null }>(
      `select s.id as "sandboxId", s.provider_sandbox_id as "machineId",s.org_id as "orgId",
         s.owner_id as "ownerId",s.source_golden_visibility as visibility,(extract(epoch from j.deadline_at)*1000)::float8 as deadline,
         (not s.application_secret_tainted and s.status<>'failed') as retain,
         launch.generation::text as "launchGeneration", launch.authority->>'scope' as scope,
         launch.authority->>'backendId' as "backendId"
       from public.sandboxes s join public.jobs j on j.sandbox_id=s.id and j.generation=s.lifecycle_generation
       left join lateral (
         select l.generation,l.outcome->'boat_authority' as authority from public.jobs l
         where l.sandbox_id=s.id and l.org_id=s.org_id and l.kind='launch'
           and l.outcome #>> '{modal_machine,entry,machineId}'=s.provider_sandbox_id
         order by l.generation limit 1
       ) launch on true
       where j.id=$1 and j.generation=$2 and j.org_id=s.org_id and s.provider='boat'
         and s.provider_sandbox_id is not null and s.status in ('stopping','failed')
         and s.stop_requested_at is not null and s.stopped_at is null and s.deleted_at is null`,
      [job.id, job.generation],
    );
    if (!row) return { status: "fail", reason: "boat_stop_target_changed" };
    const target = {
      ...row,
      generation: Number(job.generation),
      launchGeneration: row.launchGeneration === null ? null : Number(row.launchGeneration),
    };
    const { sandboxId, generation, machineId } = target;
    const identity = { sandboxId, generation, machineId };
    const { deadline } = target;
    const budget = deadline - now();
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(budget > 0 ? budget : 10_000)]);
    const authorize = async () => {
      signal.throwIfAborted();
      if (!(await context.canDispatch())) throw Error("Boat stop ownership or deadline changed.");
      const { rows } = await sql.query(
        `select 1 from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
         where s.id=$1 and s.lifecycle_generation=$2 and s.provider_sandbox_id=$3 and s.org_id=$4 and s.owner_id=$5
           and s.stop_requested_at is not null and s.deleted_at is null`,
        [sandboxId, generation, machineId, target.orgId, target.ownerId],
      );
      if (!rows.length || !(await context.canDispatch())) throw Error("Boat stop authority changed.");
      signal.throwIfAborted();
    };
    let archiveObserved = false;
    const hold = () =>
      ({
        status: "fail",
        reason: "boat_stop_unconfirmed",
        async commit(tx) {
          await holdUnconfirmedBoatStop(tx, sandboxId, generation);
          if (archiveObserved) await enqueueStopOutput(tx, jobs, sandboxId, target.orgId, generation, true);
        },
      }) satisfies JobResult;
    const retry = async () =>
      (await context.canDispatch()) ? ({ status: "retry", after: new Date(now() + 2_000) } as const) : hold();
    try {
      const { machine, outputs, exitEvidence } = await resolve(target, authorize);
      signal.throwIfAborted();
      const observed = await machine.observe({ ...identity, signal });
      if (observed.kind === "unknown") return retry();
      const absent = observed.receipt?.operation === "delete";
      archiveObserved = observed.kind === "absent" && !absent;
      if (absent && (target.retain || !target.backendId)) return retry();
      if (observed.kind === "present" && observed.phase === "running" && (await context.canDispatch()))
        await stageStopOutputs(sql, key, job, context, outputs, Math.min(12_000, deadline - 30_000 - now()));
      signal.throwIfAborted();
      if (!absent) {
        try {
          await machine.stop({ ...identity, retain: target.retain, signal });
          archiveObserved = true;
        } finally {
          archiveObserved ||= exitEvidence?.() !== undefined;
        }
      }
      context.signal.throwIfAborted();
      const exitTime = exitEvidence?.()?.stoppedAt ?? new Date(now());
      const note = target.retain ? await runtimePreservationNote(sql, sandboxId) : null;
      return {
        status: "done",
        async commit(tx) {
          await settleBoatStop(tx, sandboxId, generation, note, exitTime);
          await enqueueStopOutput(tx, jobs, sandboxId, target.orgId, generation);
        },
      };
    } catch (error) {
      context.signal.throwIfAborted();
      if (
        (error instanceof VaultError && ["missing_credential", "forbidden"].includes(error.code)) ||
        (error instanceof ProviderError && ["unauthorized", "forbidden"].includes(error.code))
      )
        return hold();
      return retry();
    }
  };
  return run;
}
