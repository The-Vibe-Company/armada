import type { CoordinatorRecord } from "./live.ts";

/** Other roles still owning work after twice the project's silence interval. */
export function strandedOwners(
  records: readonly CoordinatorRecord[],
  me: string,
  silenceMinutes: number,
  now: Date,
): CoordinatorRecord[] {
  return records.filter(
    (role) =>
      role.name !== me &&
      role.tickets.length > 0 &&
      now.getTime() - Date.parse(role.seenAt) > 2 * silenceMinutes * 60_000,
  );
}
