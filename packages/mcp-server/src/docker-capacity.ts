import { ProviderError, type Sql } from "@armada/core";
import { type DockerHostResources, dockerResourceLimits, GIB } from "../../core/src/docker-resources.ts";

/** Unknown hardware on older daemons deliberately retains the pre-limit behavior. */
export function dockerHostCapacity(resources: DockerHostResources | null): number | null {
  if (!resources) return null;
  const limits = dockerResourceLimits(resources);
  return Math.max(
    1,
    Math.min(
      Math.floor(Math.max(0, resources.memoryBytes - 2 * GIB) / limits.memoryBytes),
      Math.floor((resources.cpus * 2) / limits.cpus),
    ),
  );
}

export class DockerHostFull extends ProviderError {
  constructor(name: string, running: number, capacity: number) {
    super({
      provider: "docker",
      code: "conflict",
      retryable: false,
      message: `Host ${name} is full: ${running}/${capacity} sandboxes running; stop one or raise the limit.`,
    });
  }
}

/** Caller must hold the host row FOR UPDATE. Pending starts reserve capacity too:
 * releasing only after a physical stop/delete ACK prevents concurrent over-admission.
 * Failed/expired logical state alone is not proof the container stopped.
 */
export async function admitDockerCapacity(tx: Sql, hostId: string): Promise<void> {
  const host = (
    await tx.query<{ name: string | null; machine_cpus: number | null; machine_memory_bytes: string | number | null }>(
      "select name,machine_cpus,machine_memory_bytes from public.docker_hosts where id=$1",
      [hostId],
    )
  ).rows[0];
  if (!host || host.machine_cpus == null || host.machine_memory_bytes == null) return;
  const capacity = dockerHostCapacity({
    cpus: Number(host.machine_cpus),
    memoryBytes: Number(host.machine_memory_bytes),
  })!;
  const { rows } = await tx.query<{ running: string | number }>(
    `select (${DOCKER_CAPACITY_USAGE_SQL}) as running from public.docker_hosts h where h.id=$1`,
    [hostId],
  );
  const running = Number(rows[0]?.running ?? 0);
  if (running >= capacity) throw new DockerHostFull(host.name ?? hostId, running, capacity);
}

/** Physical reservations, shared by admission and its displayed usage. Correlated with host alias h. */
export const DOCKER_CAPACITY_USAGE_SQL = `select count(distinct start.bound_sandbox_id) as running from public.docker_host_jobs start
     join public.sandboxes s on s.id=start.bound_sandbox_id
     where s.stopped_at is null and s.deleted_at is null and start.host_id=h.id and start.bound_sandbox_id is not null
       and start.bound_operation in ('create','resume')
       and not exists (select 1 from public.docker_host_jobs stop
         where stop.host_id=start.host_id and stop.bound_sandbox_id=start.bound_sandbox_id
           and stop.position>start.position and stop.bound_operation in ('stop','delete')
           and stop.outcome='completed')`;
