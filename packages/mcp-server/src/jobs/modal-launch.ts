import type { Machine, MachineIdentity, Sql } from "@armada/core/server";
import { createModalMachine, type ModalMachineOptions } from "@armada/provider-modal";
import { bindModalLaunchMachine } from "../sandbox-lifecycle.ts";
import type { Job, JobContext } from "./runner.ts";
import { createJobsStore, withJobLease } from "./store.ts";

type LaunchInput = Omit<Parameters<Machine["create"]>[0], "sandboxId" | "generation" | "signal">;
type DispatchContext = Pick<JobContext, "canDispatch" | "signal">;

interface ModalLaunchPlan {
  allocation: LaunchInput;
  bindingRef: string;
  machine: Omit<ModalMachineOptions, "journal">;
}

export async function dispatchModalLaunch(
  sql: Sql,
  job: Job,
  context: DispatchContext,
  plan: ModalLaunchPlan,
): Promise<"bootstrapped" | "reconcile"> {
  const sandboxId = job.sandbox_id;
  const generation = Number(job.generation);
  if (job.kind !== "launch" || !sandboxId || !Number.isSafeInteger(generation) || generation < 1)
    throw new Error("Invalid Modal launch claim.");

  const { signal, canDispatch } = context;
  const incarnation = { sandboxId, generation, signal };
  const machine = createModalMachine({ ...plan.machine, journal: createJobsStore(sql).modalLaunchJournal(job) });
  const target = () =>
    withJobLease(sql, job, async (tx) => {
      if (!(await canDispatch(tx))) return;
      const {
        rows: [row],
      } = await tx.query<{ provider_sandbox_id: string | null }>(
        `select provider_sandbox_id from public.sandboxes
         where id=$1 and provider='modal' and runtime_transport='dialout'
           and stop_requested_at is null and deleted_at is null
           and (status='starting' or (status in ('ready','running') and provider_sandbox_id is not null))`,
        [sandboxId],
      );
      return row;
    });

  const current = await target();
  if (!current) {
    signal.throwIfAborted();
    await machine.observe(incarnation);
    return "reconcile";
  }

  let allocated: MachineIdentity;
  if (current.provider_sandbox_id) {
    allocated = { sandboxId, generation, machineId: current.provider_sandbox_id };
  } else {
    const observed = job.attempts > 1 ? await machine.observe(incarnation) : undefined;
    if (observed && !(await target())) return "reconcile";
    signal.throwIfAborted();
    allocated = await machine.create({ ...plan.allocation, ...incarnation });
    if (
      allocated.sandboxId !== sandboxId ||
      allocated.generation !== generation ||
      (observed?.kind === "present" && observed.machine.machineId !== allocated.machineId)
    )
      throw new Error("Modal launch changed the observed machine identity.");
    const bound = await withJobLease(sql, job, async (tx) => {
      if (!(await canDispatch(tx))) return false;
      return bindModalLaunchMachine(tx, allocated);
    });
    if (!bound) return "reconcile";
  }

  const readyToBootstrap = await target();
  if (readyToBootstrap?.provider_sandbox_id !== allocated.machineId) return "reconcile";
  signal.throwIfAborted();
  await machine.bootstrap({ ...allocated, signal, bindingRef: plan.bindingRef });
  return "bootstrapped";
}
