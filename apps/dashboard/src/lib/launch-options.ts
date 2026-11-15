/** Ordinary Boat OpenCode requires installed shared-runtime admission, not an explicit opt-in route. */
export function boatOpenCodeAvailable(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const options = value as {
    providers?: unknown;
    boatRuntime?: { enabled?: unknown; defaultPath?: unknown; opencodeVersion?: unknown };
  };
  if (
    options.boatRuntime?.enabled !== true ||
    options.boatRuntime.opencodeVersion !== 1 ||
    !Array.isArray(options.providers)
  )
    return false;
  return options.providers.some(
    (provider) =>
      provider?.id === "boat" &&
      provider.enabled === true &&
      provider.capabilities?.launch === true &&
      Array.isArray(provider.harnesses) &&
      provider.harnesses.includes("opencode"),
  );
}
