import { statfs } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { requireDockerDiskSpace } from "../../core/src/docker-disk-policy.ts";
import type { DockerMachineCli } from "../../core/src/docker-machine.ts";
import type { Executor } from "./daemon.ts";

/** Measure the Docker data filesystem, not the daemon's HOME filesystem. Remote
 * Docker contexts cannot be measured using local statfs and are refused safely.
 */
export async function dockerDiskFreeBytes(cli: DockerMachineCli): Promise<number | null> {
  try {
    let endpoint = process.env.DOCKER_HOST;
    if (!endpoint || process.env.DOCKER_CONTEXT) {
      const context = await cli.run(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]);
      if (context.exitCode !== 0) return null;
      endpoint = JSON.parse(context.stdout);
    }
    if (typeof endpoint !== "string" || !endpoint.startsWith("unix://")) return null;
    const info = await cli.run(["info", "--format", "{{json .DockerRootDir}}"]);
    if (info.exitCode !== 0) return null;
    const directory: unknown = JSON.parse(info.stdout);
    if (typeof directory !== "string" || !isAbsolute(directory)) return null;
    const disk = await statfs(directory, { bigint: true });
    const bytes = disk.bavail * disk.bsize;
    return bytes >= 0n && bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : null;
  } catch {
    return null;
  }
}

/** Fresh local proof closes the heartbeat-to-dispatch race for allocations/builds.
 * Retained resume and cleanup reuse owned resources and never require new disk proof. */
export function withDiskFloor(executor: Executor, sample: () => Promise<number | null>): Executor {
  return {
    ...executor,
    async create(request) {
      requireDockerDiskSpace(await sample());
      return executor.create(request);
    },
    ...(executor.buildSnapshot
      ? {
          async buildSnapshot(job, recoverOnly) {
            if (!recoverOnly) requireDockerDiskSpace(await sample());
            return executor.buildSnapshot!(job, recoverOnly);
          },
        }
      : {}),
  };
}

/** Read-only, approximate inventory. Only volumes attached to stopped containers
 * with both installation labels are counted; shared volumes are counted once.
 * Docker's human-readable volume sizes are rounded, so this is not reclaimable space. */
export async function stoppedSandboxBytes(
  cli: DockerMachineCli,
  state: { installationId: string; hostId: string },
): Promise<number | null> {
  try {
    const listing = await cli.run(
      [
        "container",
        "ls",
        "--all",
        "--filter",
        "status=exited",
        "--filter",
        "status=dead",
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
    if (listing.exitCode !== 0) return null;
    const ids = listing.stdout.trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return 0;
    if (ids.length > 1000 || ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id))) return null;
    const inspection = await cli.run(["container", "inspect", "--size", ...ids], undefined, { timeoutMs: 3000 });
    if (inspection.exitCode !== 0) return null;
    const containers = JSON.parse(inspection.stdout);
    if (!Array.isArray(containers) || containers.length !== ids.length) return null;
    let total = 0;
    const volumes = new Set<string>();
    for (const item of containers) {
      const labels = item.Config?.Labels;
      if (
        labels?.["dev.armada.machine.installation"] !== state.installationId ||
        labels?.["dev.armada.machine.host"] !== state.hostId ||
        !["exited", "dead"].includes(item.State?.Status) ||
        !Number.isSafeInteger(item.SizeRw) ||
        item.SizeRw < 0 ||
        !Array.isArray(item.Mounts)
      )
        return null;
      total += item.SizeRw;
      for (const mount of item.Mounts)
        if (mount.Type === "volume" && typeof mount.Name === "string") volumes.add(mount.Name);
    }
    if (volumes.size) {
      const usage = await cli.run(
        ["system", "df", "--verbose", "--format", "{{range .Volumes}}{{.Name}}|{{.Size}}{{println}}{{end}}"],
        undefined,
        { timeoutMs: 3000 },
      );
      if (usage.exitCode !== 0) return null;
      for (const line of usage.stdout.trim().split("\n")) {
        const [name, size] = line.split("|");
        if (!name || !volumes.has(name)) continue;
        const match = /^(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|PB)$/.exec(size ?? "");
        if (!match) return null;
        total += Math.round(Number(match[1]) * 1000 ** ["B", "kB", "MB", "GB", "TB", "PB"].indexOf(match[2]!));
        volumes.delete(name);
      }
      if (volumes.size) return null;
    }
    return Number.isSafeInteger(total) && total >= 0 ? total : null;
  } catch {
    return null;
  }
}
