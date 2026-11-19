import type { Provider, ProviderInventoryMachine, SandboxPlacementProviderId, SandboxStatus } from "@armada/core";
import type { ServerLifecycleLane } from "./server-workers.ts";

const UNKNOWN_GRACE_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const OVERDUE_LOG_BATCH_SIZE = 32;

type Ownership =
  | { kind: "absent" }
  | { kind: "unresolved" }
  | { kind: "owned"; status: SandboxStatus; generation?: string };

type DeleteReason = "unknown" | "terminal";
type Decision = "keep" | "unknown_young" | DeleteReason;

export interface ProviderReaperSource {
  provider: SandboxPlacementProviderId;
  /** Stable, nonsecret identity unique to the provider account/binding or host within this deployment. */
  sourceId: string;
  /** Stable environment + server identity used when tagging machines. */
  deploymentId: string;
  /** The source bounds each listing page, ownership lookup and delete call. The full sweep
   * may take longer than the ordinary worker tick and is cancelled on shutdown. */
  inventory: Required<Pick<Provider, "listInventory">>;
  /** Check authoritative ownership by tagged sandbox and physical identity in this source.
   * Ambiguous ownership is unresolved. Errors must never be translated to absence. */
  lookupOwnership(machine: ProviderInventoryMachine, signal: AbortSignal): Promise<Ownership>;
  /** Omitted for report-only sources. Revalidate ownership and apply the provider's
   * admission/resume safeguards before deleting this immutable physical machine.
   * Preserve retained data. Return false when deletion is disallowed, true on confirmed
   * absence (including already gone), and throw on unknown outcomes. */
  deleteMachine?(machine: ProviderInventoryMachine, reason: DeleteReason, signal: AbortSignal): Promise<boolean>;
}

function belongsToDeployment(machine: ProviderInventoryMachine, deploymentId: string): boolean {
  return Boolean(deploymentId.trim() && machine.machineId.trim() && machine.deploymentId === deploymentId);
}

export function decideInventoryMachine(
  machine: ProviderInventoryMachine,
  deploymentId: string,
  ownership: Ownership,
  now: number,
): Decision {
  if (!belongsToDeployment(machine, deploymentId)) return "keep";
  if (ownership.kind === "absent") {
    const createdAt = machine.createdAt.getTime();
    if (!Number.isFinite(createdAt)) return "keep";
    return now - createdAt > UNKNOWN_GRACE_MS ? "unknown" : "unknown_young";
  }
  if (
    ownership.kind === "owned" &&
    (ownership.status === "deleted" || ownership.status === "failed") &&
    machine.generation &&
    machine.generation === ownership.generation
  ) {
    return "terminal";
  }
  return "keep";
}

export function createProviderReaper(
  source: ProviderReaperSource,
  log?: (line: string) => void,
  now?: () => number,
): ServerLifecycleLane {
  return createProviderReaperLane(async () => [source], log, now);
}

/** Refresh the registry each sweep. Each source reports independently. */
export function createProviderReaperLane(
  discover: (signal: AbortSignal) => Promise<readonly ProviderReaperSource[]>,
  log: (line: string) => void = console.log,
  now: () => number = Date.now,
) {
  let active: Promise<void> | undefined;
  let nextSweepAt = Number.NEGATIVE_INFINITY;

  async function sweep(source: ProviderReaperSource, signal: AbortSignal) {
    const labels = { provider: source.provider, source: source.sourceId };
    const seen = new Set<string>();
    const candidates: Record<DeleteReason, number> = { unknown: 0, terminal: 0 };
    const deleted: Record<DeleteReason, number> = { unknown: 0, terminal: 0 };
    let unknown = 0;
    let overdue = 0;
    const overdueMachineIds: string[] = [];
    let errors = 0;
    let complete = false;
    const observedAt = now();
    const reportOverdueMachines = () => {
      if (overdueMachineIds.length === 0) return;
      log(
        JSON.stringify({
          event: "reaper_overdue_machines",
          ...labels,
          deploymentId: source.deploymentId,
          observedAt,
          machineIds: overdueMachineIds,
        }),
      );
      overdueMachineIds.length = 0;
    };
    try {
      for await (const machine of source.inventory.listInventory(signal)) {
        if (signal.aborted) return;
        if (!belongsToDeployment(machine, source.deploymentId) || seen.has(machine.machineId)) continue;
        seen.add(machine.machineId);
        try {
          const ownership = await source.lookupOwnership(machine, signal);
          if (signal.aborted) return;
          const decision = decideInventoryMachine(machine, source.deploymentId, ownership, observedAt);
          if (ownership.kind === "absent") unknown++;
          if (decision === "unknown") {
            overdue++;
            if (source.provider === "modal" || source.provider === "docker") {
              overdueMachineIds.push(machine.machineId);
              // Preserve the observation even if deletion is interrupted.
              if (source.deleteMachine || overdueMachineIds.length === OVERDUE_LOG_BATCH_SIZE) reportOverdueMachines();
            }
          }
          if (decision === "unknown" || decision === "terminal") {
            candidates[decision]++;
            if (await source.deleteMachine?.(machine, decision, signal)) deleted[decision]++;
          }
          if (signal.aborted) return;
        } catch {
          if (signal.aborted) return;
          errors++;
        }
      }
      complete = !signal.aborted && errors === 0;
    } catch {
      if (!signal.aborted) errors++;
    } finally {
      log(
        JSON.stringify({
          metric: "reaper_unknown_machines",
          ...labels,
          count: unknown,
          overdue,
          complete,
        }),
      );
      for (const reason of ["unknown", "terminal"] as const) {
        log(
          JSON.stringify({
            metric: "reaper_deleted",
            ...labels,
            reason,
            candidates: candidates[reason],
            count: deleted[reason],
            reportOnly: source.deleteMachine === undefined,
            complete,
          }),
        );
      }
      reportOverdueMachines();
      if (errors > 0) {
        log(JSON.stringify({ event: "provider_reaper_retry", ...labels, errors }));
      }
    }
  }

  return {
    isolatedSweep: true,
    async reconcileOne(signal) {
      if (active || signal.aborted || now() < nextSweepAt) return false;
      active = (async () => {
        let sources: readonly ProviderReaperSource[];
        try {
          sources = await discover(signal);
        } catch {
          if (!signal.aborted) {
            log(JSON.stringify({ event: "provider_reaper_retry", phase: "discovery", errors: 1, complete: false }));
          }
          return;
        }
        for (const source of sources) {
          if (signal.aborted) return;
          await sweep(source, signal);
        }
      })();
      try {
        await active;
      } finally {
        nextSweepAt = now() + SWEEP_INTERVAL_MS;
        active = undefined;
      }
      return false;
    },
    async drain() {
      await active;
    },
  } satisfies ServerLifecycleLane;
}
