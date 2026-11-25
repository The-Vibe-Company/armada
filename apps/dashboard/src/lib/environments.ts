import type { SandboxProviderId } from "@armada/core";
import { type CapacityState, type LaunchReadiness, PROVIDER_LABELS } from "./golden-form.ts";
import { CLOUD_PROVIDERS_LABEL } from "./labels.ts";
import type { ResourceState } from "./resource-list.ts";

/**
 * The Environments page (#808): one row per golden, its state in plain words and the one action the viewer can take
 * from the row. `launch` opens the launch form, `snapshot` opens the row's panel on its build form, `connect` goes
 * to the provider settings. Null: nothing the viewer can do from here (someone else builds it, the server is down).
 */
type EnvironmentAction = "launch" | "snapshot" | "connect" | null;

type EnvironmentState = ResourceState & { action: EnvironmentAction; detail: string };

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
      detail: `An org admin connects ${label} in Machines → ${CLOUD_PROVIDERS_LABEL} to build and launch it.`,
      action: "connect",
    };
  if (readiness.kind === "no-snapshot")
    return buildBlocker === null
      ? { bucket: "action", tone: "warning", label: "Not built yet", detail: readiness.detail, action: "snapshot" }
      : { bucket: "rest", tone: "neutral", label: "Not built yet", detail: buildBlocker, action: null };
  return { bucket: "rest", tone: readiness.tone, label: readiness.label, detail: readiness.detail, action: null };
}

/** One provider's part of the capacity line under the list. */
type CapacityPart = { provider: SandboxProviderId; kind: CapacityState["kind"]; text: string; reason?: string };

/**
 * The golden capacity of each connected provider, in one line ("Boat: 1 of 1 slot used · Modal: no limit"). The
 * usage is what the server reports for the goldens the viewer can see; a slot a removed golden still holds is said.
 */
export function capacityParts(
  entries: readonly { provider: SandboxProviderId; state: CapacityState; removed: number }[],
): CapacityPart[] {
  return entries.map(({ provider, state, removed }) => {
    const label = PROVIDER_LABELS[provider];
    if (state.kind === "unknown") return { provider, kind: state.kind, text: `${label} has no snapshot limit.` };
    if (state.kind === "unavailable")
      return {
        provider,
        kind: state.kind,
        text: `${label} snapshot capacity could not be checked.`,
        reason: state.reason,
      };
    const held =
      removed === 0 ? "" : ` ${removed} ${removed === 1 ? "place is" : "places are"} still held by removed snapshots.`;
    const full = state.used >= state.capacity;
    return {
      provider,
      kind: state.kind,
      text: `${label} allows ${state.capacity} ${state.capacity === 1 ? "snapshot" : "snapshots"} here; ${state.used} ${state.used === 1 ? "is" : "are"} using that capacity.${held}${full ? " There is no room for another snapshot." : ""}`,
    };
  });
}
