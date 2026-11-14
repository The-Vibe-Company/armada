/** Native compatibility bridges only; Docker admission remains host/epoch-owned. */
export function runtimeBridgeTarget(target: {
  provider: string;
  harness: string;
  boatRuntime?: boolean;
  runtimeTransport?: string;
}): boolean {
  return (
    ((target.provider === "boat" && Boolean(target.boatRuntime)) ||
      (target.provider === "modal" && target.runtimeTransport === "dialout")) &&
    (target.harness === "codex" ||
      target.harness === "claude" ||
      (target.provider === "modal" && target.harness === "opencode"))
  );
}
