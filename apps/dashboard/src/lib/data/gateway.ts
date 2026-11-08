import { mcpUrl } from "@/lib/env";
import { createGateway, sandboxGateway } from "@/lib/gateway";
import type { Viewer } from "./viewer";

/** The server-side client of the Armada MCP server for this viewer, or null when none is configured. */
export function viewerGateway(viewer: Viewer) {
  const url = mcpUrl();
  if (!url || !viewer.token) return null;
  return sandboxGateway(createGateway({ url, token: viewer.token }));
}
