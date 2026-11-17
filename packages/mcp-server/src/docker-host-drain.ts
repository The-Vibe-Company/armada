/** Whether `alias` (a docker_hosts alias) is draining for uninstall. A drain has no deadline. */
export function hostDrainingSql(alias: string): string {
  return `(${alias}.draining_at is not null)`;
}
