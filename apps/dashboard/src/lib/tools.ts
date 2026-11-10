import { connectAction, type McpCatalogService, type McpConnection, statusLabel } from "./connections.ts";
import type { Blocker, ResourceState } from "./resource-list.ts";
import type { Tone } from "./status-tone.ts";

/**
 * The Tools page (#808): one row per MCP connection, then each catalog service nobody added yet. A connection's
 * state comes from the registry; its row action is {@link connectAction}'s, for whoever may manage it.
 */
export type ToolAction = NonNullable<ReturnType<typeof connectAction>>;

export type ToolState = ResourceState & { action: ToolAction | null };

const TONES: Record<McpConnection["status"], Tone> = {
  connected: "success",
  not_connected: "neutral",
  needs_reconnect: "warning",
  unavailable: "destructive",
  disabled: "neutral",
};

export function toolState(
  connection: Pick<McpConnection, "status" | "transport" | "authType">,
  canManage: boolean,
): ToolState {
  const action = canManage ? connectAction(connection) : null;
  const tone = TONES[connection.status];
  const label = statusLabel(connection);
  if (connection.status === "connected") return { bucket: "ready", tone, label, action };
  // A broken connection someone else manages still sorts with the rest: its row says who fixes it.
  return { bucket: action ? "action" : "rest", tone, label, action };
}

/** A catalog service with no connection yet: offered at the end of the list, or waiting on the server's setup. */
export function serviceState(service: Pick<McpCatalogService, "availability">): ResourceState {
  return service.availability === "available"
    ? { bucket: "rest", tone: "neutral", label: "Not added" }
    : { bucket: "rest", tone: "warning", label: "Needs server setup" };
}

/** The catalog services no connection was created from: a service already connected is a row of its own. */
export function unaddedServices<T extends Pick<McpCatalogService, "id">>(
  services: readonly T[],
  connections: readonly Pick<McpConnection, "catalogId">[],
): T[] {
  return services.filter((service) => !connections.some((connection) => connection.catalogId === service.id));
}

/** Each connection the viewer can fix, named by its fix ("Reconnect Acme Sentry"); its row's panel holds the button. */
export function toolBlockers(
  rows: readonly { key: string; connection: Pick<McpConnection, "name" | "lastError">; state: ToolState }[],
): Blocker[] {
  return rows.flatMap(({ key, connection, state }) =>
    state.bucket === "action" && state.action
      ? [
          {
            key: `fix-${key}`,
            label: `${state.action} ${connection.name}`,
            detail: connection.lastError ?? `${state.label}: agents cannot use it until it is fixed.`,
            target: { item: key },
          },
        ]
      : [],
  );
}

/** A connection's useful fact on its row: who it signed in as and how many tools it exposes. */
export function toolFact(connection: Pick<McpConnection, "accountLabel" | "toolCount" | "transport">): string | null {
  const parts = [
    connection.accountLabel ? `Signed in as ${connection.accountLabel}` : null,
    connection.transport !== "stdio" && connection.toolCount !== undefined
      ? `${connection.toolCount} ${connection.toolCount === 1 ? "tool" : "tools"}`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}
