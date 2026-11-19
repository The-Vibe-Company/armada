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
 * Cleanup remains available even when admission cannot prove enough free space. */
export function withDiskFloor(executor: Executor, sample: () => Promise<number | null>): Executor {
  return {
    ...executor,
    ...(executor.resume
      ? {
          async resume(request: Parameters<NonNullable<Executor["resume"]>>[0]) {
            requireDockerDiskSpace(await sample());
            return executor.resume!(request);
          },
        }
      : {}),
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

const STOPPED_INSPECT_CHUNK = 50;
const VOLUME_USAGE_FORMAT = "{{range .Volumes}}{{.Name}}|{{.Size}}{{println}}{{end}}";
const STOPPED_INSPECT_FORMAT =
  '{{json .Config.Labels}}\t{{json .State.Status}}\t{{.SizeRw}}\t{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}},{{end}}{{end}}';

const DOCKER_SIZE_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"] as const;

/** Parse the SI, four-significant-digit sizes that `docker system df` renders. */
export function dockerHumanSizeBytes(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(B|kB|MB|GB|TB|PB)$/.exec(value.trim());
  if (!match) return null;
  const exponent = DOCKER_SIZE_UNITS.indexOf(match[2] as (typeof DOCKER_SIZE_UNITS)[number]);
  const bytes = Math.round(Number(match[1]) * 1000 ** exponent);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

/** Read-only, approximate inventory. Only volumes attached to non-running owned
 * containers with both installation labels are counted; shared volumes are counted once.
 * Docker's human-readable volume sizes are rounded, so this is not reclaimable space.
 * Inspect only the fields needed, in bounded chunks: full inspect JSON for a large
 * stopped inventory can exceed the CLI's 1 MiB output bound and its 3-second timeout. */
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
        "status=created",
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
    let total = 0;
    const volumes = new Set<string>();
    for (let offset = 0; offset < ids.length; offset += STOPPED_INSPECT_CHUNK) {
      const chunk = ids.slice(offset, offset + STOPPED_INSPECT_CHUNK);
      const inspection = await cli.run(
        ["container", "inspect", "--size", "--format", STOPPED_INSPECT_FORMAT, ...chunk],
        undefined,
        { timeoutMs: 3000 },
      );
      if (inspection.exitCode !== 0) return null;
      const lines = inspection.stdout.trim().split("\n").filter(Boolean);
      if (lines.length !== chunk.length) return null;
      for (const line of lines) {
        const [rawLabels, rawStatus, rawSize, rawVolumes = ""] = line.split("\t");
        let labels: unknown;
        let status: unknown;
        try {
          labels = JSON.parse(rawLabels ?? "");
          status = JSON.parse(rawStatus ?? "");
        } catch {
          return null;
        }
        const size = Number(rawSize);
        if (
          !labels ||
          typeof labels !== "object" ||
          Array.isArray(labels) ||
          (labels as Record<string, unknown>)["dev.armada.machine.installation"] !== state.installationId ||
          (labels as Record<string, unknown>)["dev.armada.machine.host"] !== state.hostId ||
          !["exited", "dead", "created"].includes(String(status)) ||
          !Number.isSafeInteger(size) ||
          size < 0
        )
          return null;
        total += size;
        for (const name of rawVolumes.split(",").filter(Boolean)) volumes.add(name);
      }
    }
    const names = [...volumes];
    if (names.length) {
      // Volume inspect omits UsageData; only the Engine's /system/df response has
      // per-volume sizes. Ask disk usage for its volumes only, so unrelated images,
      // containers and build cache cannot inflate the bounded CLI output.
      const usage = await cli.run(["system", "df", "--verbose", "--format", VOLUME_USAGE_FORMAT], undefined, {
        timeoutMs: 5000,
      });
      if (usage.exitCode !== 0) return null;
      for (const line of usage.stdout.split("\n").filter(Boolean)) {
        const separator = line.lastIndexOf("|");
        if (separator < 0) return null;
        const name = line.slice(0, separator);
        if (!volumes.has(name)) continue;
        const size = dockerHumanSizeBytes(line.slice(separator + 1));
        if (size === null || !volumes.delete(name)) return null;
        total += size;
      }
    }
    return Number.isSafeInteger(total) && total >= 0 ? total : null;
  } catch {
    return null;
  }
}
