/** Maximum remote MCP connections in a launch, template or runtime selection. */
export const MAX_MCP_CONNECTIONS = 100;

/** v1: candidates must already be scoped to the current actor and selected organization. */
interface McpLaunchCandidate {
  id: string;
  defaultForLaunch?: boolean;
  status: "connected" | "not_connected" | "needs_reconnect" | "unavailable" | "disabled";
}
interface McpLaunchSelection {
  /** Immutable IDs to submit; undefined input means snapshot defaults, [] means opt out. */
  ids: string[];
  /** Explicit selections that disappeared or cannot currently launch. Never silently omit. */
  blockedIds: string[];
}
export function mcpLaunchSelection(
  available: readonly McpLaunchCandidate[],
  explicit?: readonly string[],
): McpLaunchSelection {
  const ids = [
    ...new Set(explicit ?? available.filter((c) => c.defaultForLaunch && c.status !== "disabled").map((c) => c.id)),
  ];
  return {
    ids,
    blockedIds: ids.filter((id) => available.find((c) => c.id === id)?.status !== "connected"),
  };
}
