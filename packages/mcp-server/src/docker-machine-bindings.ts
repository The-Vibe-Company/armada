import type { Sql } from "@armada/core";
import type { MachineIncarnation, MachineInventoryEntry } from "@armada/core/server";
import type { DockerInventoryContainer } from "./docker-machine-inventory.ts";

interface HostInstallation {
  readonly hostId: string;
  readonly installationId: string;
  readonly deploymentId: string;
}

interface GenerationBinding {
  sandbox_id: string;
  daemon_generation: string;
  machine_generation: number | string;
}

export function createDockerMachineGenerationBindings(sql: Sql, scope: Omit<HostInstallation, "deploymentId">) {
  const { hostId, installationId } = scope;

  async function lookup({ sandboxId, generation }: MachineIncarnation) {
    const { rows } = await sql.query<{ daemon_generation: string }>(
      `select daemon_generation from public.docker_machine_bindings
       where sandbox_id=$1 and machine_generation=$2 and host_id=$3 and installation_id=$4`,
      [sandboxId, generation, hostId, installationId],
    );
    return rows[0]?.daemon_generation;
  }

  return {
    lookup,

    async bind({ sandboxId, generation }: MachineIncarnation) {
      if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("Invalid Docker Machine generation");
      const params = [sandboxId, generation, hostId, installationId];
      const inserted = await sql.query<{ daemon_generation: string }>(
        `insert into public.docker_machine_bindings(sandbox_id,machine_generation,host_id,installation_id)
         values($1,$2,$3,$4) on conflict(sandbox_id,machine_generation) do nothing returning daemon_generation`,
        params,
      );
      if (inserted.rows[0]) return inserted.rows[0].daemon_generation;

      const existing = await lookup({ sandboxId, generation });
      if (!existing) throw new Error("Docker Machine incarnation bound to another host installation");
      return existing;
    },
  };
}

export async function* projectDockerMachineInventory(
  sql: Sql,
  { hostId, installationId, deploymentId }: HostInstallation,
  report: readonly DockerInventoryContainer[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const containers = report.filter(
    ({ sandboxId, generation, containerName, deploymentId: reportedDeployment }) =>
      reportedDeployment === deploymentId &&
      containerName === `armada-${installationId}-${hostId}-${sandboxId}-${generation}`,
  );
  if (containers.length === 0) return;
  const { rows } = await sql.query<GenerationBinding>(
    `select b.sandbox_id,b.daemon_generation,b.machine_generation
     from public.docker_machine_bindings b
     join unnest($3::uuid[],$4::uuid[]) as r(sandbox_id,daemon_generation)
       on b.sandbox_id=r.sandbox_id and b.daemon_generation=r.daemon_generation
     where b.host_id=$1 and b.installation_id=$2`,
    [hostId, installationId, containers.map((entry) => entry.sandboxId), containers.map((entry) => entry.generation)],
  );
  const generations = new Map(
    rows.map((row) => [`${row.sandbox_id}/${row.daemon_generation}`, Number(row.machine_generation)]),
  );
  for (const { sandboxId, generation, machineId, createdAt } of containers) {
    signal?.throwIfAborted();
    const machineGeneration = generations.get(`${sandboxId}/${generation}`);
    if (machineGeneration !== undefined) {
      yield {
        sandboxId,
        generation: machineGeneration,
        machineId,
        deploymentId,
        createdAt,
      } satisfies MachineInventoryEntry;
    }
  }
}
