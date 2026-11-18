import type { Provider, ProviderInventoryMachine, SandboxStatus } from "@armada/core";
import type { SandboxPlacementProviderId } from "@armada/core/sandbox-provider";
import type { ServerLifecycleLane } from "./server-workers.ts";

const UNKNOWN_GRACE_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

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
  /** Omitted for report-only rollout. Fence admission and resume and revalidate ownership
   * while deleting this immutable physical machine. Preserve retained data. A lost race,
   * already absent machine or unavailable fence returns false. */
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

/** One isolated server worker lane per bound source. Structured log counts can be aggregated by provider. */
export function createProviderReaper(
  source: ProviderReaperSource,
  log: (line: string) => void = console.log,
  now: () => number = Date.now,
): ServerLifecycleLane {
  const labels = { provider: source.provider, source: source.sourceId };
  let active: Promise<void> | undefined;
  let nextSweepAt = Number.NEGATIVE_INFINITY;

  async function sweep(signal: AbortSignal) {
    const seen = new Set<string>();
    const deleted: Record<DeleteReason, number> = { unknown: 0, terminal: 0 };
    let unknown = 0;
    let overdue = 0;
    let errors = 0;
    let complete = false;
    const observedAt = now();
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
          if (decision === "unknown") overdue++;
          if (
            (decision === "unknown" || decision === "terminal") &&
            (await source.deleteMachine?.(machine, decision, signal))
          ) {
            deleted[decision]++;
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
        log(JSON.stringify({ metric: "reaper_deleted", ...labels, reason, count: deleted[reason] }));
      }
      if (errors > 0) {
        log(JSON.stringify({ event: "provider_reaper_retry", ...labels, errors }));
      }
    }
  }

  return {
    isolatedSweep: true,
    async reconcileOne(signal) {
      if (active || signal.aborted || now() < nextSweepAt) return false;
      active = sweep(signal);
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
  };
}
