import { randomUUID } from "node:crypto";
import { ArmadaApiError, type ArmadaConfig, type Credentials, type Fleet, Refusal, workerSlots } from "@armada/core";
import { apiOf } from "./api.ts";
import { coordinatorName } from "./coordinator.ts";
import { type Io, UsageError } from "./io.ts";
import { requireSignIn } from "./login.ts";
import { liveFleet } from "./worker.ts";

export function overCapReason(options: Record<string, string>): string | null {
  const raw = options["over-cap"];
  if (raw === undefined) return null;
  const reason = raw.trim();
  if (!reason || reason.length > 1500) throw new UsageError("--over-cap needs a reason of at most 1500 characters");
  return reason;
}

export async function countWorkerSlots(io: Io, fleet: Fleet) {
  // Read launches first: a claim can remove its pending row only after its
  // handle exists. The later handle read cannot lose that occupied slot.
  const [launches, coordinators] = await Promise.all([fleet.pendingLaunches(), fleet.coordinators()]);
  const handles = await fleet.runtimeHandles();
  return workerSlots({ handles, launches, coordinators, now: (io.now ?? (() => new Date()))() });
}

/** Serialize count and token creation only; the pending launch reserves the slot. */
export async function mintLaunchToken(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  target: {
    ticket: string;
    priority?: number;
    overCap?: string | null;
    replacement?: boolean;
    coordinator?: string | null;
  },
) {
  const api = apiOf(io, credentials.armadaApi.url);
  const signIn = requireSignIn(credentials);
  const request = {
    project: config.project.slug,
    ticket: target.ticket,
    coordinator: target.coordinator === undefined ? await coordinatorName(io, config.project.slug) : target.coordinator,
  };
  const max = config.policy.maxWorkers;
  if (!max || target.replacement) return api.launchToken(signIn, request);
  const next = `armada launch ${target.ticket} --when-unblocked or armada launch ${target.ticket} --over-cap "<why>"`;
  const bypass = target.overCap || (target.priority === 1 ? "urgent priority" : null);
  const { fleet } = liveFleet(io, config, credentials);
  if (!fleet) throw new Refusal("cannot count workers; retry or --over-cap", next);
  const holder = `launch-slots:${randomUUID()}`;
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const lease = await fleet.acquireLease({ name: "launch-slots", holder, ttlMs: 60_000 });
      if (lease.acquired) {
        acquired = true;
        break;
      }
      if (attempt < 3) await (io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(1000);
    }
  } catch {
    // A lost acquire response may have committed. Renew only our stable holder
    // to confirm ownership; never mint under an unknown or another owner's lease.
    try {
      acquired = await fleet.renewLease({ name: "launch-slots", holder, ttlMs: 60_000 });
    } catch {
      // Unknown outcomes remain fail-closed, including explicit overrides.
    }
    if (!acquired) throw new Refusal("cannot confirm worker-slot lease; retry", next);
  }
  if (!acquired) throw new Refusal("another launch is counting worker slots; retry", next);
  let releaseSlots = true;
  const mint = async (overCap: string | null) => {
    if (!(await fleet.renewLease({ name: "launch-slots", holder, ttlMs: 60_000 })))
      throw new Refusal("worker-slot lease expired while counting; retry", next);
    try {
      return await api.launchToken(signIn, { ...request, ...(overCap ? { overCap } : {}) });
    } catch (error) {
      // A timed-out write may still be committing. Keep the lease until expiry
      // so another launcher cannot count before its pending row becomes visible.
      if (!(error instanceof ArmadaApiError && error.status !== null && error.status >= 400 && error.status < 500)) {
        releaseSlots = false;
        io.stderr("armada: warning: launch token outcome unknown; worker-slot lease retained until its 60 s expiry.\n");
      }
      throw error;
    }
  };
  try {
    let taken: number;
    try {
      taken = (await countWorkerSlots(io, fleet)).taken;
    } catch {
      if (!target.overCap) throw new Refusal("cannot count workers; retry or --over-cap", next);
      return await mint(`launched over the cap (count unavailable, max ${max}): ${bypass}`);
    }
    if (taken >= max && !bypass)
      throw new Refusal(`worker cap reached: ${taken} of ${max} workers; nothing was launched`, next);
    const overCap = taken >= max ? `launched over the cap (${taken + 1} of ${max}): ${bypass}` : null;
    return await mint(overCap);
  } finally {
    try {
      if (releaseSlots) await fleet.releaseLease({ name: "launch-slots", holder });
    } catch {
      io.stderr("armada: warning: could not release worker-slot lease; it expires after 60 s.\n");
    }
  }
}
