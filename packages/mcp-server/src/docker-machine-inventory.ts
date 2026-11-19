import type { ProviderInventoryMachine, SandboxStatus } from "@armada/core";
import type { ProviderReaperSource } from "./provider-reaper.ts";

interface DockerInventoryContainer extends ProviderInventoryMachine {
  sandboxId: string;
  generation: string;
  containerName: string;
}

interface DockerInventoryOwner {
  id: string;
  generation: string;
  provider_sandbox_id: string;
  status: SandboxStatus;
}

/** A report describes one authenticated installation at the time of its scan. */
export function dockerMachineInventory(
  hostId: string,
  deploymentId: string,
  containers: readonly DockerInventoryContainer[],
  owners: readonly DockerInventoryOwner[],
): ProviderReaperSource {
  const scoped = containers.filter((container) => container.deploymentId === deploymentId);
  const byMachine = new Map(scoped.map((container) => [container.machineId, container]));
  const bySandbox = new Map(owners.map((row) => [row.id, row]));

  return {
    provider: "docker",
    sourceId: hostId,
    deploymentId,
    inventory: {
      async *listInventory(signal) {
        signal?.throwIfAborted();
        for (const container of scoped) {
          signal?.throwIfAborted();
          yield container;
        }
      },
    },
    async lookupOwnership(machine, signal) {
      signal.throwIfAborted();
      const reported = byMachine.get(machine.machineId);
      if (!reported || machine.deploymentId !== deploymentId) return { kind: "unresolved" };
      const owner = bySandbox.get(reported.sandboxId);
      return owner && owner.generation === reported.generation && owner.provider_sandbox_id === reported.containerName
        ? { kind: "owned", status: owner.status, generation: owner.generation }
        : { kind: "absent" };
    },
  };
}
