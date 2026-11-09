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

/** No production native adapter currently satisfies the checkpoint/restore contract.
 * Keep the legacy off response byte-compatible when no pair is requested. This is
 * a diagnostic policy, NOT a capability override or an activation implementation. */
export function orchestratorCapabilities(requested: readonly OrchestratorPair[] = []) {
  const off = { version: 1 as const, enabled: false, reason: "native_conformance_required" };
  if (requested.length === 0) return off;
  return {
    ...off,
    pairs: PAIRS.map((pair) => {
      const [provider, harness] = pair.split(":");
      const selected = requested.includes(pair);
      return {
        provider,
        harness,
        requested: selected,
        enabled: false,
        reason: !selected
          ? "server_setting_off"
          : provider === "modal"
            ? "modal_activation_not_supported"
            : "boat_native_checkpoint_restore_unavailable",
      };
    }),
  };
}
