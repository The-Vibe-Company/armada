// Runtime observations travel through the project-scoped API; the dashboard only reads stored state.
import {
  ArmadaApiError,
  type ArmadaConfig,
  CONFIG_DEFAULTS,
  type Credentials,
  type Delivery,
  deliveryKey,
  type Fleet,
  machinePaths,
  OBSERVABLE_RUNTIMES,
  type PendingLaunch,
  processAlive,
  Refusal,
  type RuntimeHandle,
  readWatchState,
  releaseWatchLock,
  runtimeNameOf,
  takeWatchLock,
  updateWatchState,
} from "@armada/core";
import type { Io } from "./io.ts";
import { requireSignIn } from "./login.ts";
import { archiveClaimKey, claimRef, guarded, launchRef, runtimeFor } from "./runtimes/adapter.ts";
import { liveFleet, type WorkerArgs } from "./worker.ts";

const observing = new Set<string>();

/** Discover workers from claims. Cache Conductor attempts across separate inbox/watch processes. */
export async function observeRuntimes(io: Io, fleet: Fleet, config?: ArmadaConfig): Promise<RuntimeHandle[]> {
  const handles = await fleet.runtimeHandles();
  if (!io.exec) return handles;
  const paths = machinePaths(io.env);
  const now = (io.now ?? (() => new Date()))();
  const projects = [...new Set(handles.map((h) => h.project))];
  let changed = false;
  for (const project of projects) {
    const local = handles.filter(
      (h) => h.project === project && OBSERVABLE_RUNTIMES.includes(runtimeNameOf(h.runtime) as "herdr" | "conductor"),
    );
    if (!local.length) continue;
    // A watch and a separate status command share the throttle, even when they overlap.
    const lockProject = `${project}.runtime-observe`;
    const lockKey = `${paths?.dir ?? io.cwd}/${lockProject}`;
    if (observing.has(lockKey)) continue;
    observing.add(lockKey);
    let locked = false;
    try {
      if (paths && local.some((h) => runtimeNameOf(h.runtime) === "conductor")) {
        const lock = await takeWatchLock(paths, lockProject, io.pid ?? process.pid, io.processAlive ?? processAlive);
        if (!lock.taken) continue;
        locked = true;
      }
      // Keep reservations in the same dedicated namespace as their lock. Ordinary
      // watch updates can otherwise overwrite a reservation with an older reading.
      const saved = paths ? await readWatchState(paths, lockProject).catch(() => null) : null;
      const observed = { ...saved?.runtimeObserved };
      const eligible = local.filter((h) => {
        if (runtimeNameOf(h.runtime) !== "conductor") return true;
        const age = now.getTime() - Date.parse(h.lastHeartbeatAt ?? h.claimedAt);
        if (age <= (config?.policy.silentAfterMinutes ?? CONFIG_DEFAULTS.silentAfterMinutes) * 30_000) return false;
        const readingAge = now.getTime() - Date.parse(h.runtimeState?.at ?? "");
        if (Number.isFinite(readingAge) && readingAge >= 0 && readingAge < 5 * 60_000) return false;
        const key = `${h.handle}@${h.claimedAt}`;
        const last = Date.parse(observed[key] ?? "");
        if (Number.isFinite(last) && now.getTime() >= last && now.getTime() - last < 60_000) return false;
        observed[key] = now.toISOString();
        return true;
      });
      // Reserve attempts BEFORE runtime I/O, so a killed/outage-bound reader cannot immediately repeat them.
      if (paths && local.some((h) => runtimeNameOf(h.runtime) === "conductor")) {
        const active = new Set(local.map((h) => `${h.handle}@${h.claimedAt}`));
        const runtimeObserved = Object.fromEntries(Object.entries(observed).filter(([key]) => active.has(key)));
        await updateWatchState(paths, lockProject, { runtimeObserved });
      }
      await Promise.all(
        eligible.map(async (h) => {
          try {
            const reading = await runtimeFor(io, config, h.runtime).observe(claimRef(h));
            if (reading.state === "gone" && runtimeNameOf(h.runtime) === "conductor") {
              changed =
                (await fleet.stopRuntime({ ticket: h.ticket, handle: h.handle, claimedAt: h.claimedAt })) || changed;
              return;
            }
            const input = {
              ticket: h.ticket,
              handle: h.handle,
              claimedAt: h.claimedAt,
              state: reading.state,
              ...(reading.since ? { since: reading.since } : {}),
              ...(reading.sequence === undefined ? {} : { sequence: reading.sequence }),
            };
            try {
              changed = (await fleet.observeRuntime(input)) || changed;
            } catch (e) {
              // A pre-migration server cannot store the new vocabulary yet.
              if (e instanceof ArmadaApiError && e.status === 400 && ["failed", "gone"].includes(reading.state))
                changed = (await fleet.observeRuntime({ ...input, state: "unknown" })) || changed;
              else throw e;
            }
          } catch {
            // Remote herdr claims and runtime outages retain their last stored reading until it expires.
          }
        }),
      );
    } catch {
      // An unavailable machine store is optional. Do not flood a runtime when its throttle cannot be held.
    } finally {
      if (paths && locked) await releaseWatchLock(paths, lockProject, io.pid ?? process.pid).catch(() => {});
      observing.delete(lockKey);
    }
  }
  return changed ? fleet.runtimeHandles() : handles;
}

export function observingFleet(io: Io, fleet: Fleet, config?: ArmadaConfig): Fleet {
  return {
    ...fleet,
    inbox: async (query) => {
      try {
        await observeRuntimes(io, fleet, config);
      } catch {}
      return fleet.inbox(query);
    },
  };
}

/** Core finishes answer validation first. Claude Code keeps its deliver-with-guide, then record path. */
export async function deliverToRuntime(
  io: Io,
  fleet: Fleet,
  ticket: string,
  text: string,
  expected?: RuntimeHandle | null,
  config?: ArmadaConfig,
  message: {
    item?: number | null;
    kind?: "answer" | "note" | "login";
    identityText?: string;
    key?: string;
    coordinator?: string;
    skipHandedBack?: boolean;
  } = {},
  launch?: PendingLaunch | null,
): Promise<Delivery | null> {
  const ref = expected && !expected.releasedAt ? claimRef(expected) : launch ? launchRef(launch) : null;
  const target = ref && { ...ref, coordinator: message.coordinator, skipHandedBack: message.skipHandedBack };
  if (!target) throw new Refusal(`${ticket}'s claim is missing or changed; no answer was delivered`, "armada inbox");
  const adapter = runtimeFor(io, config, target.runtime);
  if (!adapter.can.deliver) return null;
  if (target.releasedAt) throw new Refusal(`${ticket}'s worker has ended; no answer was delivered`, "armada status");
  return guarded(fleet, target, "active", () =>
    adapter.deliver(target, {
      text,
      kind: message.kind ?? "answer",
      key:
        message.key ??
        deliveryKey({
          project: config?.project.slug ?? expected?.project ?? "",
          ticket,
          // Claiming does not create a new generation for a bound launch.
          claimedAt: target.launchId ? null : target.claimedAt,
          launchId: target.launchId,
          item: message.item ?? null,
          kind: message.kind ?? "answer",
          // Masking availability can change between retries. The original text
          // is only hashed here; delivery and records keep the masked payload.
          text: message.identityText ?? text,
        }),
    }),
  );
}

export async function stop(io: Io, config: ArmadaConfig, credentials: Credentials, args: WorkerArgs) {
  const [raw, ...extra] = args.rest;
  if (!raw || extra.length) throw new Refusal("stop needs one ticket: armada stop <ticket>", "armada stop --help");
  requireSignIn(credentials);
  const { fleet } = liveFleet(io, config, credentials);
  if (!fleet) throw new Refusal("stop needs Armada's stored claim", "armada whoami");
  const ticket = raw.toUpperCase();
  const h = await fleet.runtimeHandle(ticket);
  if (!h) throw new Refusal(`${ticket} has no runtime claim to stop`, "armada status");
  const target = claimRef(h);
  const mergedPr = args.options["merged-pr"];
  const claimKey = args.options["claim-key"];
  if (claimKey && archiveClaimKey(target) !== claimKey)
    throw new Refusal(`${ticket}'s claim changed since the merge; left its workspace untouched`, "armada status");
  if (mergedPr) {
    const event = (await fleet.latestEvents())[ticket];
    if (
      !h.releasedAt ||
      event?.kind !== "merge" ||
      event.prUrl !== mergedPr ||
      Date.parse(event.at) < Date.parse(h.claimedAt)
    )
      throw new Refusal(
        `${ticket} has no ended claim for that merged pull request; left its workspace untouched`,
        "armada status",
      );
  }
  const adapter = runtimeFor(io, config, h.runtime);
  // Guided adapters must give their guide refusal even if an active claim exists.
  if (!adapter.can.archive)
    await adapter.archive(claimRef(h), { reason: "released", whenWorking: "refuse", waitMs: 0 });
  if (adapter.name === "conductor" && !h.releasedAt)
    throw new Refusal(
      `cannot archive ${ticket} while it holds the ticket; release first`,
      `armada release --ticket ${ticket} --reason "<why>"`,
    );
  const archived = await guarded(fleet, target, h.releasedAt ? "ended" : "active", () =>
    adapter.archive(target, {
      reason: "released",
      whenWorking: adapter.name === "herdr" ? "cancel" : "wait",
      waitMs: 600_000,
    }),
  );
  if (!(await fleet.stopRuntime({ ticket, handle: h.handle, claimedAt: h.claimedAt })))
    throw new Refusal("workspace archived, but claim changed during cleanup; inspect the new claim", "armada status");
  const result = {
    ticket,
    ...(archived.path ? { path: archived.path } : {}),
    stopped: true,
    ...(archived.alreadyGone ? { alreadyAbsent: true } : {}),
  };
  io.stdout(
    args.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : archived.alreadyGone
        ? `${ticket}'s ${adapter.name} workspace is already absent; its claim is ended.\n`
        : archived.path
          ? `Stopped ${ticket} and removed ${archived.path}; its branch is retained.\n`
          : `Archived ${ticket}'s Conductor workspace.\n`,
  );
  return 0;
}
