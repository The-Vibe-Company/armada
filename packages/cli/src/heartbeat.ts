import { createHash } from "node:crypto";
import {
  type ArmadaConfig,
  type Credentials,
  heartbeatLoop,
  machinePaths,
  processAlive,
  releaseWatchLock,
  takeWatchLock,
} from "@armada/core";
import { type Io, UsageError } from "./io.ts";
import { currentTicket, liveFleet } from "./worker.ts";

export async function heartbeat(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: { rest: string[]; options: Record<string, string>; config: string | null },
): Promise<number> {
  if (args.rest.length) throw new UsageError("heartbeat takes no positional argument");
  const interval = args.options.every ?? "5m";
  const match = interval.match(/^(\d+(?:\.\d+)?)(s|m)$/);
  const everyMs = match ? Number(match[1]) * (match[2] === "m" ? 60_000 : 1000) : 0;
  if (!Number.isFinite(everyMs) || everyMs < 1000 || everyMs > config.policy.silentAfterMinutes * 60_000)
    throw new UsageError("--every needs seconds or minutes, at least 1s and no longer than policy.silence_minutes");
  const parent = Number(args.options.parent);
  if (!Number.isSafeInteger(parent) || parent <= 1)
    throw new UsageError('--parent needs the persistent agent PID (pass --parent "$PPID" from its command shell)');
  const ticket = currentTicket(
    io,
    config,
    args.options.ticket,
    credentials.armadaSignIn?.kind === "worker" ? [credentials.armadaSignIn.ticket] : [],
  );
  const handle =
    args.options.handle ||
    (io.env.CONDUCTOR_WORKSPACE_ID && io.env.CONDUCTOR_SESSION_ID
      ? `${io.env.CONDUCTOR_WORKSPACE_ID}/${io.env.CONDUCTOR_SESSION_ID}`
      : null);
  if (!handle) throw new UsageError("heartbeat needs --handle <claim-handle> outside Conductor");
  const alive = () => !io.stopped?.() && (io.processAlive ?? processAlive)(parent);
  if (!alive()) throw new UsageError("the heartbeat parent no longer runs");
  const { fleet } = liveFleet(io, config, credentials);
  if (!fleet) throw new UsageError("heartbeat needs an Armada sign-in; use manual reports at least every 15 minutes");
  if (args.options.background === "true") {
    let started = false;
    try {
      started =
        (await io.startBackground?.([
          "heartbeat",
          "--ticket",
          ticket,
          "--handle",
          handle,
          "--every",
          interval,
          "--parent",
          String(parent),
          ...(args.config ? ["--config", args.config] : []),
        ])) ?? false;
    } catch {}
    if (!started) {
      io.stderr("armada: background heartbeat unavailable; report manually at least every 15 minutes.\n");
      return 1;
    }
    io.stdout(`Heartbeat running in the background for ${ticket} (every ${interval}, parent ${parent}).\n`);
    return 0;
  }
  const paths = machinePaths(io.env);
  if (!paths) throw new UsageError("heartbeat needs HOME or XDG_CONFIG_HOME for its PID file");
  const pid = io.pid ?? process.pid;
  let lock: string | null = null;
  let ready = false;
  try {
    const result = await heartbeatLoop({
      ticket,
      handle,
      everyMs,
      now: io.now ?? (() => new Date()),
      sleep: io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      parentAlive: alive,
      ping: (input) => fleet.heartbeat(input),
      ready: async (session) => {
        const name = `${config.project.slug}-heartbeat-${ticket.toLowerCase()}-${createHash("sha256").update(`${handle}/${session.claimedAt}`).digest("hex").slice(0, 12)}`;
        const acquired = await takeWatchLock(paths, name, pid, io.processAlive ?? processAlive);
        if (acquired.taken) lock = name;
        ready = true;
        io.backgroundReady?.(true);
        return acquired.taken;
      },
    });
    if (!ready) io.backgroundReady?.(false);
    return result === "session-ended" && !ready ? 1 : 0;
  } catch {
    io.backgroundReady?.(false);
    io.stderr("armada: heartbeat unavailable; report manually at least every 15 minutes.\n");
    return 1;
  } finally {
    if (lock) await releaseWatchLock(paths, lock, pid);
  }
}
