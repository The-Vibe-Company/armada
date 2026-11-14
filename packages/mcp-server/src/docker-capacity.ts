import { ProviderError, type Sql } from "@armada/core";
import {
  type DockerHostResources,
  type DockerResourceOverrides,
  dockerResourcePolicy,
} from "../../core/src/docker-resources.ts";

/** Unknown hardware on older daemons deliberately retains the pre-limit behavior. */
export function dockerHostCapacity(
  resources: DockerHostResources | null,
  overrides: DockerResourceOverrides = {},
): number | null {
  return resources ? dockerResourcePolicy(resources, overrides).capacity : null;
}
export type DockerPolicyRow = {
  machine_cpus: number | null;
  machine_memory_bytes: number | string | null;
  sandbox_cpus: number | null;
  sandbox_memory_bytes: number | string | null;
  max_sandboxes: number | null;
};
export function hostResourcePolicy(host: DockerPolicyRow) {
  if (host.machine_cpus == null || host.machine_memory_bytes == null) return null;
  try {
    return dockerResourcePolicy(
      { cpus: Number(host.machine_cpus), memoryBytes: Number(host.machine_memory_bytes) },
      {
        ...(host.sandbox_cpus == null ? {} : { cpus: Number(host.sandbox_cpus) }),
        ...(host.sandbox_memory_bytes == null ? {} : { memoryBytes: Number(host.sandbox_memory_bytes) }),
        ...(host.max_sandboxes == null ? {} : { maxSandboxes: host.max_sandboxes }),
      },
    );
  } catch {
    throw new DockerLimitsRefused(
      "conflict",
      "Host hardware changed; stop its sandboxes and reset or adjust its resource limits.",
    );
  }
}
export class DockerLimitsRefused extends ProviderError {
  constructor(code: "conflict" | "invalid_request", message: string) {
    super({ provider: "docker", code, retryable: false, message });
  }
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
    await tx.query<DockerPolicyRow & { name: string | null }>(
      "select name,machine_cpus,machine_memory_bytes,sandbox_cpus,sandbox_memory_bytes,max_sandboxes from public.docker_hosts where id=$1",
      [hostId],
    )
  ).rows[0];
  if (!host || host.machine_cpus == null || host.machine_memory_bytes == null) return;
  const capacity = hostResourcePolicy(host)!.capacity;
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
