import type { Machine, MachineIdentity, Sql } from "@armada/core/server";
import { createModalMachine, type ModalMachineOptions } from "@armada/provider-modal";
import { bindModalLaunchMachine } from "../sandbox-lifecycle.ts";
import type { Job, JobContext } from "./runner.ts";
import { createJobsStore, withJobLease } from "./store.ts";

export type ModalLaunchAllocation = Omit<Parameters<Machine["create"]>[0], "sandboxId" | "generation" | "signal">;
type DispatchContext = Pick<JobContext, "canDispatch" | "signal">;

interface ModalLaunchPlan {
  allocation: ModalLaunchAllocation;
  bindingRef: string;
  machine: Omit<ModalMachineOptions, "journal">;
}

export async function dispatchModalLaunch(sql: Sql, job: Job, context: DispatchContext, plan: ModalLaunchPlan) {
  const sandboxId = job.sandbox_id;
  const generation = Number(job.generation);
  if (job.kind !== "launch" || !sandboxId || !Number.isSafeInteger(generation) || generation < 1)
    throw new Error("Invalid Modal launch claim.");

  const { signal, canDispatch } = context;
  const incarnation = { sandboxId, generation, signal };
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

  const current = await target();
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
