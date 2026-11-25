import { capabilities } from "@armada/core/machine-capabilities";
import type { Machine, Sql } from "@armada/core/server";
import type { startBoatRuntime } from "@armada/provider-boat";
import type { createObservedBoatProvider } from "../observed-boat.ts";
import { recordBoatRestoreDispatch, recordBoatRestoreObserved } from "./store.ts";

export function createBoatResumeMachine(
  host: ReturnType<typeof createObservedBoatProvider>,
  binding: {
    recordId: string;
    sandboxId: string;
    generation: number;
    providerAuthority: string;
    legacyLabels?: Readonly<Record<string, string>>;
    authorize(): Promise<void>;
    write(work: (tx: Sql) => Promise<unknown>): Promise<void>;
    ticket(
      request: Parameters<Machine["bootstrap"]>[0],
    ): Promise<Omit<Parameters<typeof startBoatRuntime>[1], "sandboxId" | "signal"> | null>;
  },
  jobId: string,
  sql: Sql,
  bootstrap: typeof startBoatRuntime,
) {
  const { recordId: machineId, sandboxId, generation } = binding;
  const identity = { machineId, sandboxId, generation };
  const predecessor = { kind: "disk", ref: machineId, sandboxId, generation: generation - 1 } as const;
  return {
    predecessor,
    async resume(request) {
      if (
        request.sandboxId !== sandboxId ||
        request.generation !== generation ||
        request.predecessor.sandboxId !== sandboxId ||
        request.predecessor.generation !== predecessor.generation ||
        request.predecessor.kind !== predecessor.kind ||
        request.predecessor.ref !== machineId
      )
        throw Error("Boat resume identity changed.");
      const observed = await host.get(machineId, request.signal ? { signal: request.signal } : undefined);
      if (
        observed.id !== machineId ||
        (binding.legacyLabels &&
          !Object.entries(binding.legacyLabels).every(([name, value]) => observed.labels[name] === value))
      )
        throw Error("Boat resume identity changed.");
      const {
        rows: [intent],
      } = await sql.query<{ dispatched: boolean }>(
        "select outcome ? 'boat_restore_dispatched' as dispatched from public.jobs where id=$1",
        [jobId],
      );
      if (observed.state === "ready" || observed.state === "running") {
        if (!intent?.dispatched || observed.physicalExitConfirmed) throw Error("Boat resume is unconfirmed.");
        await binding.write((tx) => recordBoatRestoreObserved(tx, jobId));
        return identity;
      }
      if (
        !intent ||
        intent.dispatched ||
        observed.state !== "stopped" ||
        observed.physicalExitConfirmed ||
        observed.retainedSnapshot !== "usable"
      )
        throw Error("Boat retention or resume is unconfirmed.");
      await binding.authorize();
      await binding.write(async (tx) => {
        if (!(await recordBoatRestoreDispatch(tx, jobId, binding.providerAuthority)))
          throw Error("Boat resume was already dispatched.");
      });
      request.signal?.throwIfAborted();
      await host.resumeRuntime(
        machineId,
        Math.min(request.computeTtlSeconds, capabilities("boat").maxTtlSeconds),
        request.signal,
      );
      await binding.write((tx) => recordBoatRestoreObserved(tx, jobId));
      return identity;
    },
    async bootstrap(request) {
      if (request.machineId !== machineId || request.sandboxId !== sandboxId || request.generation !== generation)
        throw Error("Boat bootstrap identity changed.");
      const ticket = await binding.ticket(request);
      if (!ticket) return;
      await binding.authorize();
      request.signal?.throwIfAborted();
      await bootstrap(
        {
          ...host,
          async sshKey(key) {
            await binding.authorize();
            request.signal?.throwIfAborted();
            return host.sshKey(key);
          },
        },
        { ...ticket, sandboxId: machineId, signal: request.signal },
      );
    },
  } satisfies Pick<Machine, "resume" | "bootstrap"> & { predecessor: typeof predecessor };
}
