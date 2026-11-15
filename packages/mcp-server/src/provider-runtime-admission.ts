/** Shared runtime capabilities; callers retain placement, transport and authorization guards. */
export function runtimeBridgeTarget(target: {
  provider: string;
  harness: string;
  boatRuntime?: boolean;
  runtimeTransport?: string;
}): boolean {
  return (
    ((target.provider === "boat" && Boolean(target.boatRuntime)) ||
      (target.provider === "modal" && target.runtimeTransport === "dialout")) &&
    runtimeHarnessSupported(target.provider, target.harness)
  );
}

export function runtimeHarnessSupported(provider: string, harness: string): boolean {
  return (
    ["codex", "claude"].includes(harness) || (["boat", "modal", "docker"].includes(provider) && harness === "opencode")
  );
}

/** Closed provider refusal names; unrecognized identities retain the generic diagnostic. */
export function runtimeConfigurationFailure(id: unknown) {
  const names: Record<string, string> = { boat: "Boat runtime", docker: "Docker runtime" };
  return `${typeof id === "string" && Object.hasOwn(names, id) ? names[id] : "Runtime"} configuration is unavailable.`;
}
