import { createControlClient } from "@/lib/control";
import { mcpUrl } from "@/lib/env";
import { createGateway, sandboxGateway } from "@/lib/gateway";
import type { Viewer } from "./viewer";

const SANDBOX_CONTROL_TIMEOUT_MS = 60_000;

/** The server-side client of the Armada server for this viewer, or null when none is configured. */
export function viewerGateway(viewer: Viewer) {
  const url = mcpUrl();
  if (!url || !viewer.token) return null;
  const token = viewer.token;
  return sandboxGateway(
    createGateway({ url, token }),
    createControlClient({ serverUrl: url, token, timeoutMs: SANDBOX_CONTROL_TIMEOUT_MS }),
  );
}
