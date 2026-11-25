import { createControlClient } from "@/lib/control";
import { mcpUrl } from "@/lib/env";
import { sandboxGateway } from "@/lib/gateway";
import type { Viewer } from "./viewer";

const SANDBOX_CONTROL_TIMEOUT_MS = 60_000;

export function viewerGateway(viewer: Viewer) {
  const url = mcpUrl();
  if (!url || !viewer.token) return null;
  return sandboxGateway(
    createControlClient({ serverUrl: url, token: viewer.token, timeoutMs: SANDBOX_CONTROL_TIMEOUT_MS }),
  );
}
