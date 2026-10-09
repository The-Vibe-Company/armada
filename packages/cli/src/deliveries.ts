// Only keyed runtime messages enter this outbox. It is drained by coordinator watch polls.
import {
  type ArmadaConfig,
  type ClaimRef,
  type Credentials,
  type Delivery,
  type Fleet,
  MAX_DELIVERY_ATTEMPTS,
  machinePaths,
  type PendingDelivery,
  processAlive,
  Refusal,
  RuntimeError,
  readWatchState,
  recordDeliveredAnswer,
  releaseWatchLock,
  takeWatchLock,
  updateWatchState,
} from "@armada/core";
import type { Io } from "./io.ts";
import { outgoingRedactor, redactLinearWriter } from "./redact.ts";
import { claimRef, guarded, runtimeFor } from "./runtimes/adapter.ts";
import { remember } from "./watch.ts";
import { workerContext } from "./worker.ts";

// If settlement is unavailable after native confirmation, this machine retains
// a receipt and retries settlement only. The server remains the shared outbox.
const confirmations = new Set<string>();
async function confirmationReceipt(
  io: Io,
  config: ArmadaConfig,
  key: string,
  action: "read" | "keep" | "clear",
): Promise<boolean> {
  const paths = machinePaths(io.env);
  const namespace = `${config.project.slug}.deliveries`;
  const identity = `${paths?.dir ?? io.cwd}:${namespace}:${key}`;
  if (action === "keep") confirmations.add(identity);
  if (action === "clear") confirmations.delete(identity);
  if (!paths) return confirmations.has(identity);
  try {
    const receipts = { ...(await readWatchState(paths, namespace))?.deliveryConfirmed };
    if (action === "read") return confirmations.has(identity) || !!receipts[key];
    if (action === "keep") receipts[key] = (io.now?.() ?? new Date()).toISOString();
    else delete receipts[key];
    await updateWatchState(paths, namespace, { deliveryConfirmed: receipts });
  } catch {
    if (action !== "read") io.stderr("armada: warning: could not retain the local delivery confirmation receipt\n");
  }
  return confirmations.has(identity);
}

function deliveryRef(row: PendingDelivery): ClaimRef {
  return {
    ticket: row.ticket,
    runtime: row.runtime,
    handle: row.handle,
    claimedAt: row.claimedAt,
    launchId: row.launchId,
    releasedAt: null,
    branch: row.branch,
    coordinator: row.coordinator,
    ...(row.kind === "merge-note" ? { skipHandedBack: true } : {}),
  };
}

async function deliveryTarget(fleet: Fleet, row: PendingDelivery): Promise<ClaimRef> {
  const ref = deliveryRef(row);
  if (ref.claimedAt === null && ref.launchId) {
    const claim = await fleet.runtimeHandle(row.ticket);
    // A bound launch becoming a claim keeps its worker-session identity.
    if (
      claim &&
      !claim.releasedAt &&
      claim.workerSessionId === ref.launchId &&
      claim.handle === ref.handle &&
      claimRef(claim).runtime === ref.runtime
    )
      return { ...claimRef(claim), coordinator: ref.coordinator, skipHandedBack: ref.skipHandedBack };
  }
  return ref;
}

/** Persist before sending: retries reuse both the original key and masked payload. */
export async function deliverKept(
  io: Io,
  fleet: Fleet,
  config: ArmadaConfig,
  ref: ClaimRef,
  message: { key: string; text: string; item: number | null; kind: "answer" | "note" | "merge-note" },
): Promise<Delivery & { attempts: number; text: string }> {
  const previous = (await fleet.pendingDeliveries()).find((row) => row.key === message.key);
  let row = await fleet.keepDelivery({
    key: message.key,
    ticket: ref.ticket,
    item: message.item,
    kind: message.kind,
    text: message.text,
    runtime: ref.runtime,
    handle: ref.handle,
    claimedAt: ref.claimedAt,
    launchId: ref.launchId,
    branch: ref.branch ?? null,
  });
  if (row.state === "abandoned")
    throw new Refusal(`delivery #${row.id} ended: ${row.reason}; inspect the session first`, "armada inbox");
  if (row.state === "delivered")
    return { via: "already confirmed", messageId: row.key, queued: false, attempts: row.attempts, text: row.text };
  const alreadyConfirmed = await confirmationReceipt(io, config, row.key, "read");
  if (previous && !alreadyConfirmed) {
    const attempted = await fleet.attemptDelivery(row.key, true);
    if (!attempted)
      throw new Refusal(`delivery #${row.id} has no tries left; inspect the session first`, "armada inbox");
    row = attempted;
  }
  await remember(io, config.project.slug, {
    root: io.coordinatorRoot ?? io.cwd,
    pendingDeliveries: (await fleet.pendingDeliveries()).map((row) => row.ticket),
  });
  try {
    const adapter = runtimeFor(io, config, row.runtime);
    const target = await deliveryTarget(fleet, row);
    const result = alreadyConfirmed
      ? { via: "already confirmed", messageId: row.key, queued: false }
      : await guarded(fleet, target, "active", () =>
          adapter.deliver(target, {
            key: row.key,
            text: row.text,
            kind: row.kind === "answer" ? "answer" : "note",
          }),
        );
    await confirmationReceipt(io, config, row.key, "keep");
    const settled = await fleet.settleDelivery({
      key: row.key,
      state: "delivered",
      reason: "confirmed by the runtime",
    });
    if (!settled || settled.state !== "delivered")
      throw new Refusal("the confirmed answer was superseded; no answer was recorded", "armada inbox");
    await confirmationReceipt(io, config, row.key, "clear");
    await remember(io, config.project.slug, {
      pendingDeliveries: (await fleet.pendingDeliveries()).map((row) => row.ticket),
    });
    return { ...result, attempts: row.attempts, text: row.text };
  } catch (error) {
    if (await confirmationReceipt(io, config, row.key, "read"))
      throw new Refusal(
        `${row.ticket}'s answer was delivered; Armada could not settle its confirmation`,
        "keep armada watch running to record the confirmation; never send it by hand too",
      );
    if (error instanceof RuntimeError && ["unknown-outcome", "unavailable"].includes(error.code)) {
      if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
        await fleet.settleDelivery({
          key: row.key,
          state: "abandoned",
          reason: `not confirmed after ${MAX_DELIVERY_ATTEMPTS} tries`,
          attempts: row.attempts,
        });
        throw new Refusal(
          `delivery #${row.id} not confirmed after ${MAX_DELIVERY_ATTEMPTS} tries; the question stays open`,
          "armada inbox; inspect the session first",
        );
      }
      throw new Refusal(
        `not confirmed yet; Armada keeps it (delivery #${row.id}) and retries it while armada watch runs; the question stays open`,
        "keep armada watch running; never send it by hand too",
      );
    }
    if (error instanceof RuntimeError)
      await fleet.settleDelivery({
        key: row.key,
        state: "abandoned",
        reason: error.code === "stale" ? "the worker changed" : `runtime delivery refused (${error.code})`,
        attempts: row.attempts,
      });
    throw error;
  }
}

/** Production wrapper shared by plain and following watch; database attempt admission fences other machines. */
export function deliveringFleet(io: Io, fleet: Fleet, config: ArmadaConfig, credentials: Credentials): Fleet {
  const paths = machinePaths(io.env);
  const namespace = `${config.project.slug}.deliveries`;
  const pid = io.pid ?? process.pid;
  return {
    ...fleet,
    inbox: async (query) => {
      let locked = false;
      try {
        if (paths) {
          const lock = await takeWatchLock(paths, namespace, pid, io.processAlive ?? processAlive);
          if (!lock.taken) return await fleet.inbox(query);
          locked = true;
        }
        for (const due of (await fleet.dueDeliveries()).slice(0, 3)) {
          const alreadyConfirmed = await confirmationReceipt(io, config, due.key, "read");
          if (due.attempts >= MAX_DELIVERY_ATTEMPTS && !alreadyConfirmed) {
            await fleet.settleDelivery({
              key: due.key,
              state: "abandoned",
              reason: `not confirmed after ${MAX_DELIVERY_ATTEMPTS} tries`,
              attempts: due.attempts,
            });
            continue;
          }
          const row = alreadyConfirmed ? due : await fleet.attemptDelivery(due.key);
          if (!row) continue;
          const target = await deliveryTarget(fleet, row);
          const adapter = runtimeFor(io, config, row.runtime);
          if (!adapter.can.keyedDelivery) {
            await fleet.settleDelivery({
              key: row.key,
              state: "abandoned",
              reason: "inspect the session first: this runtime has no keyed delivery",
              attempts: row.attempts,
            });
            continue;
          }
          let confirmed = false;
          try {
            if (row.kind !== "merge-note" && row.item !== null && (await fleet.inboxItem(row.item))?.resolvedAt) {
              await fleet.settleDelivery({
                key: row.key,
                state: "abandoned",
                reason: "replaced by a newer answer",
                attempts: row.attempts,
              });
              continue;
            }
            if (!alreadyConfirmed)
              await guarded(fleet, target, "active", () =>
                adapter.deliver(target, {
                  key: row.key,
                  text: row.text,
                  kind: row.kind === "answer" ? "answer" : "note",
                }),
              );
            confirmed = true;
            await confirmationReceipt(io, config, row.key, "keep");
            const settled = await fleet.settleDelivery({
              key: row.key,
              state: "delivered",
              reason: `delivered after ${row.attempts} tries`,
            });
            if (!settled || settled.state !== "delivered")
              throw new Refusal("the confirmed answer was superseded", "armada inbox");
            await confirmationReceipt(io, config, row.key, "clear");
            if (row.kind === "merge-note") {
              const peers = (await fleet.runtimeHandles()).filter(
                (h) =>
                  h.handle === row.handle &&
                  claimRef(h).runtime === row.runtime &&
                  (h.coordinator ?? "default") === row.coordinator,
              );
              for (const peer of peers) {
                const peerRef = { ...claimRef(peer), coordinator: row.coordinator, skipHandedBack: true };
                await guarded(fleet, peerRef, "active", () =>
                  fleet.answer({
                    note: true,
                    generated: true,
                    deliveryKey: row.key,
                    ticket: peer.ticket,
                    text: row.text,
                    item: null,
                  }),
                );
              }
            } else {
              const [claim, launches, mask] = await Promise.all([
                fleet.runtimeHandle(row.ticket),
                fleet.pendingLaunches(),
                outgoingRedactor(io, config, credentials),
              ]);
              const launch = row.claimedAt === null ? (launches.find((l) => l.id === row.launchId) ?? null) : null;
              const ctx = workerContext(io, config, credentials);
              ctx.linear = redactLinearWriter(ctx.linear, mask.text);
              ctx.checkAnswerTarget = async () => {
                await guarded(fleet, target, "active", async () => {});
              };
              const recorded = await recordDeliveredAnswer(ctx, {
                ticket: row.ticket,
                text: row.text,
                item: row.item,
                note: row.kind === "note",
                claim,
                launch,
                delivered: true,
                deliveryAttempts: row.attempts,
              });
              for (const warning of recorded.warnings)
                io.stderr(
                  `armada: warning: ${row.ticket} delivery #${row.id} delivered; ${mask.text(warning).replace(/^Armada: /, "Armada ")}; inspect the ticket before recording manually\n`,
                );
            }
            io.stderr(`armada: ${row.ticket} delivery #${row.id} delivered after ${row.attempts} tries\n`);
          } catch (error) {
            if (confirmed) {
              // Confirmation is terminal even when either recording service is down.
              io.stderr(
                `armada: warning: ${row.ticket} delivery #${row.id} delivered; Armada could not record it; inspect the ticket before recording manually\n`,
              );
            } else if (
              row.attempts >= MAX_DELIVERY_ATTEMPTS &&
              error instanceof RuntimeError &&
              ["unknown-outcome", "unavailable"].includes(error.code)
            ) {
              await fleet.settleDelivery({
                key: row.key,
                state: "abandoned",
                reason: `not confirmed after ${MAX_DELIVERY_ATTEMPTS} tries`,
                attempts: row.attempts,
              });
            } else if (error instanceof RuntimeError && !["unknown-outcome", "unavailable"].includes(error.code)) {
              await fleet.settleDelivery({
                key: row.key,
                state: "abandoned",
                reason: error.code === "stale" ? "the worker changed" : `runtime delivery refused (${error.code})`,
                attempts: row.attempts,
              });
            }
          }
        }
      } finally {
        if (paths && locked) await releaseWatchLock(paths, namespace, pid).catch(() => {});
      }
      return fleet.inbox(query);
    },
  };
}
