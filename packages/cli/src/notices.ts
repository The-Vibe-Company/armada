// Contextual hints share durable machine reservations with release notices.
import {
  type ArmadaConfig,
  type CoordinatorRecord,
  type Credentials,
  machinePaths,
  reserveNotice,
  strandedOwners,
} from "@armada/core";
import { coordinatorName } from "./coordinator.ts";
import type { Io } from "./io.ts";
import type { StatusHints } from "./render.ts";

export function coordinatorHintsAllowed(io: Io, credentials: Credentials): boolean {
  return (
    !io.env.ARMADA_TICKET?.trim() &&
    credentials.armadaSignIn?.kind !== "worker" &&
    !(!credentials.armadaSignIn && credentials.workerTickets.length > 0)
  );
}

export async function dailyHint(io: Io, credentials: Credentials, key: string): Promise<boolean> {
  if (!coordinatorHintsAllowed(io, credentials)) return false;
  const paths = machinePaths(io.env);
  return paths
    ? reserveNotice(paths, key, (io.now ?? (() => new Date()))(), 24 * 60 * 60_000, {
        pid: io.pid,
        alive: io.processAlive,
      })
    : false;
}

/** Called only for human output, so JSON never consumes a hint. Older servers omit the state. */
export async function statusHints(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  coordinators?: () => Promise<CoordinatorRecord[]>,
): Promise<StatusHints> {
  if (!coordinatorHintsAllowed(io, credentials)) return {};
  const records = await coordinators?.().catch(() => []);
  return {
    stranded: strandedOwners(
      records ?? [],
      await coordinatorName(io, config.project.slug),
      config.policy.silentAfterMinutes,
      (io.now ?? (() => new Date()))(),
    ),
    digest: await dailyHint(io, credentials, `hint:digest:${config.project.slug}`),
  };
}
