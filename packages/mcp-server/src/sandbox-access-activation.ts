export type SandboxAccessPair = "boat:codex" | "modal:codex";

/** Default-off operator configuration, independent of retired owner orchestration. */
export function sandboxAccessPairsFromEnv(value: string | undefined): readonly SandboxAccessPair[] {
  if (!value?.trim()) return [];
  const pairs = value.split(",").map((pair) => pair.trim());
  if (pairs.some((pair) => pair !== "boat:codex" && pair !== "modal:codex"))
    throw new Error("ARMADA_SANDBOX_ACCESS_PAIRS must list boat:codex or modal:codex.");
  return [...new Set(pairs)] as SandboxAccessPair[];
}
