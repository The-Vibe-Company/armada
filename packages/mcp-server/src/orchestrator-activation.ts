import type { Harness, SandboxProviderId } from "@armada/core";

export type OrchestratorPair = `${SandboxProviderId}:${Harness}`;
const PAIRS = ["boat:claude", "boat:codex", "modal:claude", "modal:codex"] as const;

/** Server deployment intent only. Requesting a pair cannot manufacture native proof. */
export function orchestratorPairsFromEnv(value: string | undefined): readonly OrchestratorPair[] {
  if (!value?.trim()) return [];
  const pairs = value.split(",").map((pair) => pair.trim());
  if (pairs.some((pair) => !(PAIRS as readonly string[]).includes(pair)))
    throw new Error("ARMADA_ORCHESTRATOR_PAIRS must list provider:harness pairs (boat|modal):(claude|codex).");
  return [...new Set(pairs)] as OrchestratorPair[];
}

/** Supported adapter admission is published only after actual service composition.
 * An operator request alone never enables a provider/harness pair. */
export function orchestratorCapabilities(
  requested: readonly OrchestratorPair[] = [],
  available: readonly OrchestratorPair[] = [],
) {
  const off = { version: 1 as const, enabled: false, reason: "native_conformance_required" as string | null };
  if (requested.length === 0) return off;
  const pairs = PAIRS.map((pair) => {
    const [provider, harness] = pair.split(":");
    const selected = requested.includes(pair);
    const enabled = selected && pair === "modal:codex" && available.includes(pair);
    return {
      provider,
      harness,
      requested: selected,
      enabled,
      reason: enabled
        ? null
        : provider === "boat"
          ? "boat_native_checkpoint_restore_unavailable"
          : harness === "claude"
            ? "native_resume_driver_unavailable"
            : !selected
              ? "server_setting_off"
              : "production_runtime_unavailable",
    };
  });
  const enabled = pairs.some((pair) => pair.enabled);
  return {
    ...off,
    enabled,
    reason: enabled ? null : off.reason,
    pairs,
    delegatedWaits: { enabled: false, reason: "admit_wait_not_supported" },
  };
}
