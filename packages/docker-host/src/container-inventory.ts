import type { ProviderInventoryMachine } from "@armada/core";
import type { DockerMachineCli } from "../../core/src/docker-machine.ts";
import { type State, type Store, serverOrigin, validId } from "./daemon.ts";

const labelPrefix = "dev.armada.machine.";
const containerId = /^[a-f0-9]{64}$/;
const inspectBatchSize = 50;
const inspectFormat = [
  "{{json .Id}}",
  ...["installation", "host", "sandbox", "generation"].map(
    (key) => `{{json (index .Config.Labels "${labelPrefix}${key}")}}`,
  ),
  "{{json .Created}}",
].join("\t");

export function machineLabelFilters(state: Pick<State, "hostId" | "installationId">): string[] {
  if (!validId(state.hostId) || !validId(state.installationId)) throw new Error("Invalid Docker host registration");
  return [
    "--filter",
    `label=${labelPrefix}installation=${state.installationId}`,
    "--filter",
    `label=${labelPrefix}host=${state.hostId}`,
  ];
}

/** Read actual allocations, including created and stopped containers. The registration
 * binds the observed host and installation labels to one Armada server origin. */
export function createDockerContainerInventory(cli: DockerMachineCli, store: Pick<Store, "load">) {
  return {
    async *listInventory(signal?: AbortSignal): AsyncIterable<ProviderInventoryMachine> {
      signal?.throwIfAborted();
      const state = await store.load();
      const deploymentId = `${serverOrigin(state.server)}/${state.hostId}/${state.installationId}`;

      async function run(argv: string[]): Promise<string[]> {
        signal?.throwIfAborted();
        const result = await cli.run(argv, undefined, { timeoutMs: 3000 });
        signal?.throwIfAborted();
        if (result.exitCode !== 0) throw new Error("Docker container inventory unavailable");
        return result.stdout.trim().split("\n").filter(Boolean);
      }

      const ids = await run(["container", "ls", "--all", "--quiet", "--no-trunc", ...machineLabelFilters(state)]);
      if (ids.some((id) => !containerId.test(id)) || new Set(ids).size !== ids.length)
        throw new Error("Invalid Docker container inventory");

      for (let offset = 0; offset < ids.length; offset += inspectBatchSize) {
        const batch = ids.slice(offset, offset + inspectBatchSize);
        const remaining = new Set(batch);
        const lines = await run(["container", "inspect", "--format", inspectFormat, ...batch]);
        for (const line of lines) {
          const [machineId, installationId, hostId, sandboxId, generation, created]: unknown[] = line
            .split("\t")
            .map((field) => JSON.parse(field));
          if (typeof machineId !== "string" || !remaining.delete(machineId))
            throw new Error("Unexpected Docker container inspection");
          if (installationId !== state.installationId || hostId !== state.hostId) continue;
          if (!validId(sandboxId) || !validId(generation)) continue;
          const createdAt = new Date(typeof created === "string" ? created : NaN);
          if (!Number.isFinite(createdAt.getTime())) throw new Error("Invalid Docker container creation time");
          signal?.throwIfAborted();
          yield { machineId, sandboxId, generation, deploymentId, createdAt };
        }
        if (remaining.size) throw new Error("Incomplete Docker container inspection");
      }
    },
  };
}
