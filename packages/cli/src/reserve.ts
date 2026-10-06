import { ArmadaApiError, type ArmadaConfig, type Credentials, type Fleet } from "@armada/core";
import { type Io, UsageError } from "./io.ts";
import { currentTicket, liveFleet } from "./worker.ts";

interface Args {
  rest: string[];
  json: boolean;
  options: Record<string, string>;
}

function fleetOf(io: Io, config: ArmadaConfig, credentials: Credentials): Fleet {
  const { fleet } = liveFleet(io, config, credentials);
  if (!fleet)
    throw new UsageError(
      "Shared resources require a sign-in to Armada",
      "armada login; if Armada is unavailable, ask the coordinator before choosing a value",
    );
  return fleet;
}

async function throughArmada<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof ArmadaApiError) || error.signedOut || error.status === 403 || error.upgrade) throw error;
    throw new UsageError(
      `Armada could not reserve shared resources: ${error.message}`,
      "Ask the coordinator before choosing a value; reservations have no Linear fallback. A lost response may have reserved it: check armada reserve --list before retrying.",
    );
  }
}

export async function reserveCommand(io: Io, config: ArmadaConfig, credentials: Credentials, args: Args) {
  const o = args.options;
  const list = o.list === "true";
  const next = o.next === "true";
  if (list && (args.rest.length || o.value !== undefined || next || o.floor !== undefined || o.note !== undefined))
    throw new UsageError("--list takes no key or allocation options");
  if (list) {
    const rows = await throughArmada(() =>
      fleetOf(io, config, credentials).reservations(
        credentials.armadaSignIn?.kind === "worker" ? credentials.armadaSignIn.ticket : undefined,
      ),
    );
    io.stdout(
      args.json
        ? `${JSON.stringify(rows, null, 2)}\n`
        : rows.length
          ? `${rows.map((r) => `${r.key}${r.value ? ` = ${r.value}` : " (exclusive)"} · ${r.ticket}${r.merged ? " · merged (used)" : ""}${r.note ? ` · ${r.note}` : ""}`).join("\n")}\n`
          : "No shared resources reserved.\n",
    );
    return 0;
  }
  const [key, ...extra] = args.rest;
  if (!key || extra.length)
    throw new UsageError("reserve needs one key: armada reserve <key> [--value <v> | --next [--floor <n>]]");
  if (next && o.value !== undefined) throw new UsageError("use --next or --value, not both");
  if (o.floor !== undefined && !next) throw new UsageError("--floor requires --next");
  const floor = o.floor === undefined ? undefined : Number(o.floor);
  if (
    floor !== undefined &&
    (!/^\d+$/.test(o.floor ?? "") || !Number.isSafeInteger(floor) || floor >= Number.MAX_SAFE_INTEGER)
  )
    throw new UsageError("--floor must be a nonnegative safe integer below the maximum");
  const ticket = currentTicket(io, config, o.ticket, credentials.workerTickets);
  const result = await throughArmada(() =>
    fleetOf(io, config, credentials).reserve({
      ticket,
      key,
      next,
      ...(o.value === undefined ? {} : { value: o.value }),
      ...(floor === undefined ? {} : { floor }),
      ...(o.note === undefined ? {} : { note: o.note }),
    }),
  );
  if (!result.reserved)
    throw new UsageError(
      `${key}${result.holder.value ? ` = ${result.holder.value}` : " (exclusive)"} is ${result.holder.merged ? "permanently used by merged ticket" : "held by"} ${result.holder.ticket}`,
      "Choose another value, or use --next for a number",
    );
  io.stdout(
    args.json
      ? `${JSON.stringify(result.reservation, null, 2)}\n`
      : next
        ? `${result.reservation.value}\n`
        : `Reserved ${key}${result.reservation.value ? ` = ${result.reservation.value}` : " (exclusive)"} for ${ticket}.\n`,
  );
  return 0;
}

export async function unreserveCommand(io: Io, config: ArmadaConfig, credentials: Credentials, args: Args) {
  const [key, ...extra] = args.rest;
  if (!key || extra.length) throw new UsageError("unreserve needs one key: armada unreserve <key>");
  const ticket = currentTicket(io, config, args.options.ticket, credentials.workerTickets);
  const freed = await throughArmada(() => fleetOf(io, config, credentials).unreserve({ ticket, key }));
  io.stdout(
    args.json
      ? `${JSON.stringify({ freed })}\n`
      : `Freed ${freed} reservation${freed === 1 ? "" : "s"} of ${key} for ${ticket}.\n`,
  );
  return 0;
}
