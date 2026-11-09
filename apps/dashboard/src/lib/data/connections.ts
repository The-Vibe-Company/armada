import { cache } from "react";
import type { McpCatalogService, McpConnection } from "@/lib/connections";
import { ControlError, createMcpControl } from "@/lib/control";
import { mcpUrl } from "@/lib/env";
import { selectedOrganization } from "./selected-org";
import { requireViewer } from "./viewer";

/** The control client acting as the signed-in viewer, or null when no Armada server is configured. */
export async function viewerControl() {
  const viewer = await requireViewer();
  const url = mcpUrl();
  if (!url || !viewer.token) return null;
  return createMcpControl({ serverUrl: url, token: viewer.token });
}

export type ConnectionList =
  | { state: "ready"; orgId: string; connections: McpConnection[] }
  | { state: "no-org" }
  | { state: "not-configured" }
  | { state: "error"; message: string };

/** The selected org's connections that the viewer may see: their own personal ones and the org's. */
export const listSelectedConnections = cache(async (): Promise<ConnectionList> => {
  const selected = await selectedOrganization();
  if (!selected) return { state: "no-org" };
  const control = await viewerControl();
  if (!control) return { state: "not-configured" };
  try {
    return { state: "ready", orgId: selected.org.id, connections: await control.list(selected.org.id) };
  } catch (error) {
    if (error instanceof ControlError) return { state: "error", message: error.message };
    throw error;
  }
});

export type ServiceCatalog =
  | { state: "ready"; services: McpCatalogService[] }
  | { state: "unavailable"; message: string };

/** The curated services the Armada server offers the selected org. A failed read leaves custom servers usable. */
export async function listSelectedCatalog(orgId: string): Promise<ServiceCatalog> {
  const control = await viewerControl();
  if (!control) return { state: "unavailable", message: "The Armada server is not configured." };
  try {
    return { state: "ready", services: await control.catalog(orgId) };
  } catch (error) {
    if (error instanceof ControlError) return { state: "unavailable", message: error.message };
    throw error;
  }
}

export type SandboxConnections =
  | { state: "ready"; connections: McpConnection[] }
  | { state: "not-configured" }
  | { state: "error"; message: string };

/** The connections the registry bound to a sandbox at launch (`POST mcp/sandbox-connections`), as the viewer sees them. */
export async function listSandboxConnections(sandbox: { id: string; org_id: string }): Promise<SandboxConnections> {
  const control = await viewerControl();
  if (!control) return { state: "not-configured" };
  try {
    return { state: "ready", connections: await control.sandboxConnections({ org: sandbox.org_id, id: sandbox.id }) };
  } catch (error) {
    if (error instanceof ControlError) return { state: "error", message: error.message };
    throw error;
  }
}
