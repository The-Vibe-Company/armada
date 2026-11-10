import type { SandboxProviderId } from "@armada/core";
import { type CapacityState, type LaunchReadiness, PROVIDER_LABELS } from "./golden-form.ts";
import { PROVIDER_SETTINGS_PATH } from "./provider-setup.ts";
import type { Blocker, ResourceState } from "./resource-list.ts";

/**
 * The Environments page (#808): one row per golden, its state in plain words and the one action the viewer can take
 * from the row. `launch` opens the launch form, `snapshot` opens the row's panel on its build form, `connect` goes
 * to the provider settings. Null: nothing the viewer can do from here (someone else builds it, the server is down).
 */
export type EnvironmentAction = "launch" | "snapshot" | "connect" | null;

export type EnvironmentState = ResourceState & { action: EnvironmentAction; detail: string };

export function environmentState({
  provider,
  readiness,
  providerMissing,
  buildBlocker,
}: {
  provider: SandboxProviderId;
  readiness: LaunchReadiness;
  /** The org's providers were read and this golden's is not among them. */
  providerMissing: boolean;
  /** Why the viewer cannot build this golden from here, or null when they can. */
  buildBlocker: string | null;
}): EnvironmentState {
  if (readiness.kind === "ready")
    return {
      bucket: "ready",
      tone: "success",
      label: "Ready",
      detail: "Launches from its snapshot.",
      action: "launch",
    };
  const label = PROVIDER_LABELS[provider];
  if (providerMissing)
    return {
      bucket: "action",
      tone: "warning",
      label: `${label} not connected`,
      detail: `Connect ${label} in Settings to build and launch it.`,
      action: "connect",
    };
  if (readiness.kind === "no-snapshot")
    return buildBlocker === null
      ? { bucket: "action", tone: "warning", label: "Needs a snapshot", detail: readiness.detail, action: "snapshot" }
      : { bucket: "rest", tone: "neutral", label: "Needs a snapshot", detail: buildBlocker, action: null };
  return { bucket: "rest", tone: readiness.tone, label: readiness.label, detail: readiness.detail, action: null };
}

/**
 * What keeps the viewer from launching, for the strip on top of the page: a provider to connect (the whole org's
 * when none is, otherwise each one an environment waits for), then each environment the viewer can snapshot.
 */
export function environmentBlockers({
  providerPending,
  rows,
}: {
  /** The org has no sandbox provider yet: nothing builds or launches until one is connected. */
  providerPending: boolean;
  rows: readonly { key: string; name: string; provider: SandboxProviderId; state: EnvironmentState }[];
}): Blocker[] {
  const blockers: Blocker[] = [];
  if (providerPending)
    blockers.push({
      key: "provider",
      label: "Connect a sandbox provider",
      detail: "New builds and launches are paused until the organization connects one.",
      target: { href: PROVIDER_SETTINGS_PATH },
    });
  else {
    const waiting = new Map<SandboxProviderId, number>();
    for (const row of rows)
      if (row.state.action === "connect") waiting.set(row.provider, (waiting.get(row.provider) ?? 0) + 1);
    for (const [provider, count] of waiting)
      blockers.push({
        key: `connect-${provider}`,
        label: `Connect ${PROVIDER_LABELS[provider]}`,
        detail: `${count} ${count === 1 ? "environment waits" : "environments wait"} for it.`,
        target: { href: PROVIDER_SETTINGS_PATH },
      });
  }
  const snapshots = rows.filter((row) => row.state.action === "snapshot");
  for (const row of snapshots) {
    // Twins (one name on each provider) are told apart by their provider.
    const twin = snapshots.some((other) => other !== row && other.name === row.name);
    blockers.push({
      key: `snapshot-${row.key}`,
      label: `Snapshot ${row.name}${twin ? ` on ${PROVIDER_LABELS[row.provider]}` : ""}`,
      detail: "Build it once before launching from it.",
      target: { item: row.key },
    });
  }
  return blockers;
}

/** One provider's part of the capacity line under the list. */
export type CapacityPart = { provider: SandboxProviderId; kind: CapacityState["kind"]; text: string; reason?: string };

/**
 * The golden capacity of each connected provider, in one line ("Boat: 1 of 1 slot used · Modal: no limit"). The
 * usage is what the server reports for the goldens the viewer can see; a slot a removed golden still holds is said.
 */
export function capacityParts(
  entries: readonly { provider: SandboxProviderId; state: CapacityState; removed: number }[],
): CapacityPart[] {
  return entries.map(({ provider, state, removed }) => {
    const label = PROVIDER_LABELS[provider];
    if (state.kind === "unknown") return { provider, kind: state.kind, text: `${label}: no limit` };
    if (state.kind === "unavailable")
      return { provider, kind: state.kind, text: `${label}: capacity unavailable`, reason: state.reason };
    const held = removed === 0 ? "" : `, ${removed} by removed ${removed === 1 ? "environment" : "environments"}`;
    return {
      provider,
      kind: state.kind,
      text: `${label}: ${state.used} of ${state.capacity} ${state.capacity === 1 ? "slot" : "slots"} used${held}`,
    };
  });
}

/** Whether a new Boat golden would be refused: its slots are all taken (or over-taken by older goldens). */
export function boatFull(capacities: Partial<Record<SandboxProviderId, CapacityState>>): boolean {
  const boat = capacities.boat;
  return boat?.kind === "full" || boat?.kind === "legacy";
}
