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

/** Fresh local proof closes the heartbeat-to-dispatch race. Cleanup is never gated. */
export function withDiskFloor(executor: Executor, sample: () => Promise<number | null>): Executor {
  return {
    ...executor,
    async create(request) {
      requireDockerDiskSpace(await sample());
      return executor.create(request);
    },
    ...(executor.resume
      ? {
          async resume(request) {
            requireDockerDiskSpace(await sample());
            return executor.resume!(request);
          },
        }
      : {}),
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
