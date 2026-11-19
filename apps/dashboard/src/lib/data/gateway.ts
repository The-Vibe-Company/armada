import { createControlClient } from "@/lib/control";
import { mcpUrl } from "@/lib/env";
import { createGateway, sandboxGateway } from "@/lib/gateway";
import type { Viewer } from "./viewer";

/** The server-side client of the Armada server for this viewer, or null when none is configured. */
export function viewerGateway(viewer: Viewer) {
  const url = mcpUrl();
  if (!url || !viewer.token) return null;
  const token = viewer.token;
  return sandboxGateway(
    createGateway({ url, token }),
    // Docker deletion can wait up to 45 seconds for the host to acknowledge cleanup.
    createControlClient({ serverUrl: url, token, timeoutMs: 60_000 }),
  );
}
