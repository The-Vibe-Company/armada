import { connectAction, type McpCatalogService, type McpConnection, statusLabel } from "./connections.ts";
import type { Blocker, ResourceState } from "./resource-list.ts";
import type { Tone } from "./status-tone.ts";

/**
 * The Tools page (#808, #896): one row per MCP connection; the catalog services are offered in a section of their
 * own. A connection's
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

/**
 * A catalog service on the Tools page's Services section, its one place (#896): whether it is added, how many of the
 * viewer's connections came from it, and its one action. Connect adds the first account, Connect another a further
 * one (connections are independent, so a service can be added once per account); Setup is the server's to do.
 */
export type ServiceOffer = {
  tone: Tone;
  label: string;
  /** Connections in the viewer's list created from this service. */
  count: number;
  action: "connect" | "another" | "setup";
};

export function serviceOffer(
  service: Pick<McpCatalogService, "id" | "availability">,
  connections: readonly Pick<McpConnection, "catalogId">[],
): ServiceOffer {
  const count = connections.filter((connection) => connection.catalogId === service.id).length;
  if (service.availability !== "available")
    return { tone: "warning", label: "Needs server setup", count, action: "setup" };
  if (count === 0) return { tone: "neutral", label: "Not added", count, action: "connect" };
  return { tone: "success", label: "Added", count, action: "another" };
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
