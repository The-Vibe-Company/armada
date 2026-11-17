import { DOCKER_HOST_DRAIN_SECONDS } from "../../core/src/docker-host-drain.ts";

/** Whether `alias` (a docker_hosts alias) is inside an active drain window. Interpolated only from a number. */
export function hostDrainingSql(alias: string): string {
  return `(${alias}.draining_at is not null and ${alias}.draining_at > now() - ${DOCKER_HOST_DRAIN_SECONDS} * interval '1 second')`;
}
