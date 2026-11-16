import { statfs } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  DEFAULT_DOCKER_DISK_FLOOR_BYTES,
  type DockerDiskReport,
  dockerDiskRefusal,
} from "../../core/src/docker-disk-policy.ts";
import { type DockerMachineCli, DockerMachineError } from "../../core/src/docker-machine.ts";

export function diskFloorBytes(value: string | undefined): number {
  if (value === undefined) return DEFAULT_DOCKER_DISK_FLOOR_BYTES;
  const bytes = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(bytes)) throw Error("Invalid ARMADA_DOCKER_DISK_FLOOR_BYTES");
  return bytes;
}

/** Measure the selected local engine's data filesystem, never the daemon's cwd/root.
 * A remote endpoint's path is on another machine: local statfs would invent headroom.
 */
export function createDockerDiskSampler(
  cli: DockerMachineCli,
  options: {
    floorBytes?: number;
    environment?: { DOCKER_HOST?: string | undefined; DOCKER_CONTEXT?: string | undefined };
    filesystem?: (path: string) => Promise<{ bavail: bigint; bsize: bigint }>;
  } = {},
) {
  const floorBytes = options.floorBytes ?? DEFAULT_DOCKER_DISK_FLOOR_BYTES;
  if (!Number.isSafeInteger(floorBytes) || floorBytes < 0) throw Error("Invalid Docker disk floor");
  const environment = options.environment ?? process.env;
  const filesystem = options.filesystem ?? ((path: string) => statfs(path, { bigint: true }));
  return async (): Promise<DockerDiskReport> => {
    try {
      // Docker gives an explicit context precedence over DOCKER_HOST.
      let endpoint = environment.DOCKER_CONTEXT ? undefined : environment.DOCKER_HOST;
      if (endpoint === undefined) {
        const context = await cli.run(
          ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
          undefined,
          { timeoutMs: 3000 },
        );
        if (context.exitCode !== 0) throw Error("Docker context unavailable");
        endpoint = JSON.parse(context.stdout) as string;
      }
      if (typeof endpoint !== "string" || !endpoint.startsWith("unix:///") || !isAbsolute(endpoint.slice(7)))
        throw Error("Docker endpoint is not a local Unix socket");
      const info = await cli.run(["info", "--format", "{{json .DockerRootDir}}"], undefined, { timeoutMs: 3000 });
      if (info.exitCode !== 0) throw Error("Docker data directory unavailable");
      const directory: unknown = JSON.parse(info.stdout);
      if (typeof directory !== "string" || !isAbsolute(directory)) throw Error("Invalid Docker data directory");
      const usage = await filesystem(directory);
      const freeBytes = Number(usage.bavail * usage.bsize);
      if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) throw Error("Invalid Docker disk space");
      return { freeBytes, floorBytes };
    } catch {
      return { freeBytes: null, floorBytes };
    }
  };
}
export async function requireDockerDisk(sample: () => Promise<DockerDiskReport>): Promise<void> {
  const reason = dockerDiskRefusal(await sample());
  if (reason) throw new DockerMachineError(reason);
}
