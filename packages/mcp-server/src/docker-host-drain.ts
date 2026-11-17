/**
 * Whether `alias` (a docker_hosts alias) is draining for uninstall. A drain has no deadline, but it ends with the
 * uninstall: a revoked host is retired, not draining, so its snapshots report the revoked state instead of asking
 * the user to retry an uninstall that already completed.
 */
export function hostDrainingSql(alias: string): string {
  return `(${alias}.draining_at is not null and ${alias}.revoked_at is null)`;
}
