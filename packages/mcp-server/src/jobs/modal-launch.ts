import type { SandboxStatus } from "@armada/core";
import {
  GoldenError,
  type Machine,
  type MachineIdentity,
  type MachineIncarnation,
  type Sql,
} from "@armada/core/server";
import { createModalMachine, type ModalMachineOptions } from "@armada/provider-modal";
import { z } from "zod";
import {
  bindModalLaunchMachine,
  insertStartingModalSandbox,
  type ModalLaunchSandbox,
  transitionSandbox,
} from "../sandbox-lifecycle.ts";
import type { Job, JobContext, JobResult } from "./runner.ts";
import { ConflictingJobRequest, createJobsStore, withJobLease } from "./store.ts";

export type ModalLaunchAllocation = Omit<Parameters<Machine["create"]>[0], "sandboxId" | "generation" | "signal">;
export interface ModalLaunchAdmission {
  orgId: string;
  ownerId: string;
  request?: { key: string; digest: string };
  sandbox: ModalLaunchSandbox;
  allocation: ModalLaunchAllocation & { source: { kind: "snapshot" } };
  initialPrompt?: string;
  deadline: Date;
  maxAttempts: number;
}

// WARNING: Activate only after the receipt backfill and launch runner integration.
export async function admitModalLaunch(sql: Sql, encryptionKey: string, input: ModalLaunchAdmission) {
  if (!sql.transaction) throw new Error("Modal admission requires a transaction.");
  const { orgId, ownerId, sandbox, allocation, request } = input;
  const sandboxId = crypto.randomUUID();
  const generation = 1;
  const store = createJobsStore(sql, encryptionKey);
  const key = request ? JSON.stringify(["ordinary", request.key]) : JSON.stringify(["unkeyed", sandboxId]);

  try {
    return await sql.transaction(async (tx) => {
      const {
        rows: [golden],
      } = await tx.query<{
        visibility: "org" | "private";
        provider_snapshot_id: string | null;
        modal_workspace: string;
        modal_environment: string;
        modal_app_id: string;
      }>(
        `select g.visibility, g.provider_snapshot_id, g.modal_workspace, g.modal_environment, g.modal_app_id
         from public.goldens g join public.members m on m.org_id=g.org_id and m.user_id=$3
         where g.id=$1 and g.org_id=$2 and g.provider='modal' and g.removed_at is null
           and (g.visibility='org' or g.owner_id=$3)
         for update of g for share of m`,
        [sandbox.goldenId, orgId, ownerId],
      );
      if (!golden) throw new GoldenError("not_found", "Modal golden not found.");

      const jobId = await store.enqueue(
        "launch",
        sandboxId,
        generation,
        key,
        {
          allocation,
          modal: {
            workspace: golden.modal_workspace,
            environment: golden.modal_environment,
            appId: golden.modal_app_id,
          },
        },
        {
          orgId,
          deadline: input.deadline,
          maxAttempts: input.maxAttempts,
          request: { ownerId, digest: request?.digest ?? sandboxId },
        },
        tx,
      );
      const {
        rows: [receipt],
      } = await tx.query<{ sandbox_id: string; status: SandboxStatus | null; golden_id: string | null }>(
        `select j.sandbox_id, s.status, s.golden_id from public.jobs j
         left join public.sandboxes s on s.id=j.sandbox_id and s.org_id=j.org_id and s.owner_id=j.request_owner_id
         where j.id=$1 and j.kind='launch' and j.org_id=$2 and j.request_owner_id=$3`,
        [jobId, orgId, ownerId],
      );
      if (!receipt) throw new Error("Modal launch receipt is missing.");
      if (receipt.sandbox_id !== sandboxId) {
        if (receipt.golden_id && receipt.golden_id !== sandbox.goldenId)
          throw new GoldenError("conflict", "Launch key conflicts with an existing receipt.");
        return { sandbox: { id: receipt.sandbox_id, status: receipt.status ?? "deleted" } };
      }

      const snapshot = allocation.source.ref;
      if (golden.provider_snapshot_id !== snapshot)
        throw new GoldenError("conflict", "Golden snapshot changed during launch preparation.");
      await tx.query("select public.lock_golden_snapshot('modal', $1)", [snapshot]);
      const { rows: sealed } = await tx.query(
        "select 1 from public.golden_snapshot_retirements where provider='modal' and old_snapshot=$1 and sealed",
        [snapshot],
      );
      if (sealed.length) throw new GoldenError("conflict", "Golden snapshot is being retired.");

      await insertStartingModalSandbox(
        tx,
        {
          sandboxId,
          orgId,
          ownerId,
          generation,
          snapshot,
          visibility: sandbox.visibility === "private" ? "private" : golden.visibility,
        },
        sandbox,
      );
      if (input.initialPrompt !== undefined) {
        await store.enqueue(
          "launch_initial_turn",
          sandboxId,
          generation,
          jobId,
          { prompt: input.initialPrompt },
          { orgId, maxAttempts: 1 },
          tx,
        );
      }
      return { sandbox: { id: sandboxId, status: "starting" as const } };
    });
  } catch (error) {
    if (error instanceof ConflictingJobRequest)
      throw new GoldenError("conflict", "Launch key conflicts with an existing receipt.");
    throw error;
  }
}

type DispatchContext = Pick<JobContext, "canDispatch" | "signal">;

interface ModalLaunchPlan {
  allocation: ModalLaunchAllocation;
  bindingRef: string;
  machine: Omit<ModalMachineOptions, "journal">;
}

const LAUNCH_FAILURE = "modal_launch_failed";
const RECONCILING_ALLOCATION = "modal_launch_reconciling";
const RECONCILE_DELAY_MS = 30_000;
const DELETE_DISPATCH_BUDGET_MS = 5 * 60_000;

export async function runModalLaunch(
  sql: Sql,
  encryptionKey: string,
  job: Job,
  context: DispatchContext,
  plan: ModalLaunchPlan,
) {
  const sandboxId = job.sandbox_id;
  const generation = Number(job.generation);
  if (job.kind !== "launch" || !sandboxId || !Number.isSafeInteger(generation) || generation < 1)
    throw new Error("Invalid Modal launch claim.");

  const dispatch = await dispatchModalLaunch(sql, job, context, plan, { sandboxId, generation });
  if (dispatch.kind === "bootstrapped") return { status: "done" } satisfies JobResult;

  const startingTarget = async (tx: Sql) => {
    const {
      rows: [row],
    } = await tx.query<{
      org_id: string;
      provider_sandbox_id: string | null;
      journaled_id: string | null;
      has_intent: boolean;
    }>(
      `select s.org_id, s.provider_sandbox_id,
              j.outcome #>> '{modal_machine,entry,machineId}' as journaled_id,
              j.outcome #> '{modal_machine,entry}' is not null as has_intent
       from public.sandboxes s join public.jobs j on j.id=$2 and j.sandbox_id=s.id
         and j.org_id=s.org_id and j.request_owner_id=s.owner_id and j.generation=s.lifecycle_generation
       where s.id=$1 and s.provider='modal' and s.runtime_transport='dialout'
         and s.status='starting' and s.deleted_at is null and s.stop_requested_at is null`,
      [sandboxId, job.id],
    );
    return row;
  };
  const target = await withJobLease(sql, job, startingTarget);
  context.signal.throwIfAborted();
  if (!target) return { status: "done" } satisfies JobResult;

  const observed = dispatch.observation.kind === "present" ? dispatch.observation.machine.machineId : null;
  const known = target.provider_sandbox_id ?? target.journaled_id;
  if (
    (target.provider_sandbox_id && target.journaled_id && target.provider_sandbox_id !== target.journaled_id) ||
    (known && observed && known !== observed) ||
    (!known && (target.has_intent ? !observed : observed !== null))
  ) {
    return {
      status: "retry",
      after: new Date(Date.now() + RECONCILE_DELAY_MS),
      outcome: RECONCILING_ALLOCATION,
    } satisfies JobResult;
  }

  return {
    status: "fail",
    reason: LAUNCH_FAILURE,
    async commit(tx) {
      if (!(await startingTarget(tx))) throw new Error("Modal launch settlement target changed.");
      const transition = await transitionSandbox(tx, {
        sandboxId,
        expectedGeneration: generation,
        fromStates: ["starting"],
        toState: "failed",
        actor: "lifecycle_runner",
        code: LAUNCH_FAILURE,
        effects: [],
      });
      if (transition.kind !== "applied") throw new Error("Modal launch failure lost its generation.");
      await createJobsStore(sql, encryptionKey).enqueue(
        "delete",
        sandboxId,
        generation,
        "modal-launch-failure",
        { launchJobId: job.id, machineId: known ?? observed },
        {
          orgId: target.org_id,
          deadline: new Date(Date.now() + DELETE_DISPATCH_BUDGET_MS),
          maxAttempts: job.max_attempts,
        },
        tx,
      );
    },
  } satisfies JobResult;
}

async function dispatchModalLaunch(
  sql: Sql,
  job: Job,
  context: DispatchContext,
  plan: ModalLaunchPlan,
  { sandboxId, generation }: Pick<MachineIncarnation, "sandboxId" | "generation">,
) {
  const { signal, canDispatch } = context;
  const incarnation = { sandboxId, generation, signal };
  const reconciliationOnly =
    typeof job.outcome === "object" &&
    job.outcome !== null &&
    "result" in job.outcome &&
    job.outcome.result === RECONCILING_ALLOCATION;
  const dispatchTarget = async (tx: Sql) => {
    const {
      rows: [row],
    } = await tx.query<{ provider_sandbox_id: string | null }>(
      `select s.provider_sandbox_id from public.sandboxes s
         join public.jobs j on j.id=$2 and j.sandbox_id=s.id and j.org_id=s.org_id and j.request_owner_id=s.owner_id
         join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
         where s.id=$1 and s.provider='modal' and s.runtime_transport='dialout'
           and s.stop_requested_at is null and s.deleted_at is null and s.expires_at>clock_timestamp()
           and (s.status='starting' or (s.status in ('ready','running') and s.provider_sandbox_id is not null))
         for share of m`,
      [sandboxId, job.id],
    );
    if (row && (await canDispatch(tx))) return row;
  };
  const target = () => withJobLease(sql, job, dispatchTarget);
  const machine = createModalMachine({
    ...plan.machine,
    journal: createJobsStore(sql).modalLaunchJournal(
      job,
      async (tx) => (await dispatchTarget(tx))?.provider_sandbox_id === null,
    ),
    async resolveRuntimeTicket(request) {
      const ticket = await plan.machine.resolveRuntimeTicket(request);
      if (ticket && (await target())?.provider_sandbox_id !== request.machineId)
        throw new Error("Modal bootstrap dispatch is no longer authorized.");
      return ticket;
    },
  });
  const reconcile = async () => ({ kind: "reconcile", observation: await machine.observe(incarnation) }) as const;

  const current = reconciliationOnly ? undefined : await target();
  if (!current) return reconcile();

  let allocated: MachineIdentity;
  if (current.provider_sandbox_id) {
    allocated = { sandboxId, generation, machineId: current.provider_sandbox_id };
  } else {
    const observed = job.attempts > 1 ? await machine.observe(incarnation) : undefined;
    if (observed && !(await target())) return reconcile();
    signal.throwIfAborted();
    allocated = await machine.create({ ...plan.allocation, ...incarnation });
    if (
      allocated.sandboxId !== sandboxId ||
      allocated.generation !== generation ||
      (observed?.kind === "present" && observed.machine.machineId !== allocated.machineId)
    )
      throw new Error("Modal launch changed the observed machine identity.");
    const bound = await withJobLease(sql, job, async (tx) => {
      if ((await dispatchTarget(tx))?.provider_sandbox_id !== null) return false;
      return bindModalLaunchMachine(tx, allocated);
    });
    if (!bound) return reconcile();
  }

  const readyToBootstrap = await target();
  if (readyToBootstrap?.provider_sandbox_id !== allocated.machineId) return reconcile();
  signal.throwIfAborted();
  await machine.bootstrap({ ...allocated, signal, bindingRef: plan.bindingRef });
  return { kind: "bootstrapped" } as const;
}

export async function runFailedModalLaunchDelete(
  sql: Sql,
  job: Job,
  context: DispatchContext,
  prepareMachine: () => Promise<ModalLaunchPlan["machine"]>,
) {
  const sandboxId = job.sandbox_id;
  const generation = Number(job.generation);
  const payload = job.payload;
  if (
    job.kind !== "delete" ||
    !sandboxId ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !payload ||
    typeof payload !== "object" ||
    !("launchJobId" in payload) ||
    !z.uuid().safeParse(payload.launchJobId).success ||
    !("machineId" in payload) ||
    (payload.machineId !== null && typeof payload.machineId !== "string")
  ) {
    return { status: "fail", reason: "invalid_modal_launch_cleanup" } satisfies JobResult;
  }

  const { launchJobId, machineId } = payload;
  const loadTarget = async (tx: Sql) => {
    const { rows } = await tx.query<{ deleted: boolean | null }>(
      `select launch.outcome #>> '{evidence,modal_machine,entry,phase}' = 'deleted' as deleted
       from public.sandboxes s
       join public.jobs cleanup on cleanup.id=$2 and cleanup.org_id=s.org_id
       join public.jobs launch on launch.id=$3 and launch.kind='launch' and launch.state='failed'
         and launch.sandbox_id=s.id and launch.generation=s.lifecycle_generation
         and launch.org_id=s.org_id and launch.request_owner_id=s.owner_id
       where s.id=$1 and s.provider='modal' and s.runtime_transport='dialout'
         and s.status='failed' and s.deleted_at is null and s.stop_requested_at is null
         and launch.outcome->>'reason'=$5
         and (s.provider_sandbox_id is null or s.provider_sandbox_id=$4)
         and (
           ($4::text is null and launch.outcome #> '{evidence,modal_machine}' is null)
           or (launch.outcome #>> '{evidence,modal_machine,entry,operation}'='create'
             and (launch.outcome #>> '{evidence,modal_machine,entry,machineId}'=$4
               or (launch.outcome #>> '{evidence,modal_machine,entry,phase}'='creating' and $4 is not null)))
         )`,
      [sandboxId, job.id, launchJobId, machineId, LAUNCH_FAILURE],
    );
    return rows[0];
  };
  const current = await withJobLease(sql, job, loadTarget);
  if (!current) {
    return { status: "fail", reason: "modal_launch_cleanup_target_changed" } satisfies JobResult;
  }
  context.signal.throwIfAborted();
  if (machineId === null || current.deleted) return { status: "done" } satisfies JobResult;

  const isCurrent = async (tx: Sql) => Boolean(await loadTarget(tx));
  const mayDispatch = () => withJobLease(sql, job, async (tx) => (await isCurrent(tx)) && context.canDispatch(tx));
  const dispatchRevoked = new Error("Modal cleanup dispatch is no longer authorized.");
  const unconfirmed = { status: "fail", reason: "modal_launch_cleanup_unconfirmed" } satisfies JobResult;
  let options: ModalLaunchPlan["machine"];
  try {
    options = await prepareMachine();
  } catch (error) {
    if (await mayDispatch()) throw error;
    context.signal.throwIfAborted();
    return unconfirmed;
  }
  const machine = createModalMachine({
    ...options,
    client: {
      apps: options.client.apps,
      images: options.client.images,
      cpClient: options.client.cpClient,
      sandboxes: guardModalTermination(options.client.sandboxes, async () => {
        if (!(await mayDispatch())) throw dispatchRevoked;
        context.signal.throwIfAborted();
      }),
    },
    journal: createJobsStore(sql).modalFailedLaunchJournal(job, launchJobId, isCurrent, context.canDispatch),
  });
  const target = { sandboxId, generation, machineId, signal: context.signal };
  const dispatch = await mayDispatch();
  context.signal.throwIfAborted();
  if (dispatch) {
    try {
      await machine.delete({ ...target, scope: "physical-only" });
      return { status: "done" } satisfies JobResult;
    } catch (error) {
      if (error !== dispatchRevoked) throw error;
    }
  }

  const observed = await machine.observe(target);
  if (
    (observed.kind === "absent" && observed.receipt?.operation === "delete") ||
    (observed.kind === "present" && observed.phase === "stopped")
  )
    return { status: "done" } satisfies JobResult;
  return unconfirmed;
}

function guardModalTermination(
  sandboxes: ModalLaunchPlan["machine"]["client"]["sandboxes"],
  authorize: () => Promise<void>,
) {
  return new Proxy(sandboxes, {
    get(service, key) {
      if (key === "fromId") {
        return async (...args: Parameters<typeof service.fromId>) => {
          const sandbox = await service.fromId(...args);
          return new Proxy(sandbox, {
            get(instance, property) {
              if (property === "terminate") {
                return async (...params: Parameters<typeof instance.terminate>) => {
                  await authorize();
                  return instance.terminate(...params);
                };
              }
              const value = Reflect.get(instance, property, instance);
              return typeof value === "function" ? value.bind(instance) : value;
            },
          });
        };
      }
      const value = Reflect.get(service, key, service);
      return typeof value === "function" ? value.bind(service) : value;
    },
  });
}
