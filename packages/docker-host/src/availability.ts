import { readFile } from "node:fs/promises";
import { loadavg } from "node:os";
import type { DockerMachineCli } from "../../core/src/docker-machine.ts";
import { type DockerHostResources, dockerHostResources } from "../../core/src/docker-resources.ts";
import type { State } from "./daemon.ts";

export type Headroom = { availableCpus: number; availableMemoryBytes: number };

/** Own working set is credited back so Armada does not count its workload twice.
 * Linux docker stats excludes inactive file cache; MemAvailable includes reclaimable memory.
 */
export function availableForArmada(
  machine: DockerHostResources,
  memAvailable: number,
  load: number,
  own: { cpus: number; memoryBytes: number },
): Headroom {
  for (const value of [memAvailable, load, own.cpus, own.memoryBytes])
    if (!Number.isFinite(value) || value < 0) throw Error("Invalid resource observation");
  return {
    availableCpus: Math.max(0, machine.cpus - Math.max(0, load - own.cpus)),
    availableMemoryBytes: Math.floor(Math.min(machine.memoryBytes, memAvailable + own.memoryBytes)),
  };
}
/** Drop headroom immediately; recover only through a 1/4-weight EWMA.
 * Keeping the raw low-water mark below the EWMA avoids optimistic over-admission.
 */
export function smoothHeadroom(previous: Headroom | undefined, current: Headroom): Headroom {
  if (!previous) return current;
  return {
    availableCpus: Math.min(
      current.availableCpus,
      current.availableCpus - previous.availableCpus < 0.05
        ? current.availableCpus
        : previous.availableCpus * 0.75 + current.availableCpus * 0.25,
    ),
    availableMemoryBytes: Math.floor(
      Math.min(
        current.availableMemoryBytes,
        current.availableMemoryBytes - previous.availableMemoryBytes < 16 * 1024 ** 2
          ? current.availableMemoryBytes
          : previous.availableMemoryBytes * 0.75 + current.availableMemoryBytes * 0.25,
      ),
    ),
  };
}
export function parseArmadaUsage(output: string) {
  let cpus = 0,
    memoryBytes = 0;
  for (const line of output.trim().split("\n").filter(Boolean)) {
    const [memory, cpu] = line.split("|");
    const bytes = /^(\d+(?:\.\d+)?)\s*(B|[kMGT]i?B)\s*\//i.exec(memory ?? "");
    const percent = /^(\d+(?:\.\d+)?)%$/.exec((cpu ?? "").trim());
    if (!bytes || !percent) throw Error("Invalid Docker resource stats");
    const power = ({ b: 0, k: 1, m: 2, g: 3, t: 4 } as Record<string, number>)[bytes[2]![0]!.toLowerCase()]!;
    memoryBytes += Number(bytes[1]) * (bytes[2]!.includes("i") ? 1024 : 1000) ** power;
    cpus += Number(percent[1]) / 100;
  }
  if (!Number.isFinite(cpus) || !Number.isFinite(memoryBytes)) throw Error("Invalid Docker resource totals");
  return { cpus, memoryBytes };
}

/** Production sampler: explicit owned container IDs only, no unrelated workload details or logging.
 * Errors report no new capacity, not invented free hardware. TTL cleanup still proceeds.
 */
export function createAvailabilitySampler(cli: DockerMachineCli) {
  let previous: Headroom | undefined;
  return async (state: State): Promise<DockerHostResources> => {
    const machine = dockerHostResources();
    let current: Headroom;
    try {
      const listing = await cli.run(
        [
          "container",
          "ls",
          "--filter",
          `label=dev.armada.machine.installation=${state.installationId}`,
          "--filter",
          `label=dev.armada.machine.host=${state.hostId}`,
          "--format",
          "{{.ID}}",
        ],
        undefined,
        { timeoutMs: 3000 },
      );
      if (listing.exitCode !== 0) throw Error("Resource inventory unavailable");
      const ids = listing.stdout.trim().split("\n").filter(Boolean);
      if (ids.some((id) => !/^[0-9a-f]{12,64}$/.test(id))) throw Error("Invalid resource inventory");
      let own = { cpus: 0, memoryBytes: 0 };
      if (ids.length) {
        const stats = await cli.run(
          ["stats", "--no-stream", "--format", "{{.MemUsage}}|{{.CPUPerc}}", ...ids],
          undefined,
          { timeoutMs: 3000 },
        );
        if (stats.exitCode !== 0 || stats.stdout.trim().split("\n").length !== ids.length)
          throw Error("Resource stats unavailable");
        own = parseArmadaUsage(stats.stdout);
      }
      const memory = /\bMemAvailable:\s+(\d+) kB/.exec(await readFile("/proc/meminfo", "utf8"));
      if (!memory) throw Error("Memory observation unavailable");
      current = availableForArmada(machine, Number(memory[1]) * 1024, loadavg()[0] ?? 0, own);
    } catch {
      current = { availableCpus: 0, availableMemoryBytes: 0 };
    }
    previous = smoothHeadroom(previous, current);
    return { ...machine, ...previous };
  };
}
