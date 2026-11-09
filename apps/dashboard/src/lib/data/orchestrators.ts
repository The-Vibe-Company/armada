import { controlPost } from "@/lib/control";
import { mcpUrl } from "@/lib/env";
import { createOrchestratorApi, OrchestratorApiError } from "@/lib/orchestrator-api";
import { type ModelAccount, OrchestratorContractError, parseModelAccounts } from "@/lib/orchestrators";
import type { Viewer } from "./viewer";

/**
 * The orchestrator API as the signed-in viewer, or null when no Armada server is configured. Orchestrators are read
 * and changed through the server only: no direct Supabase query or mutation can bypass its fences and privacy.
 */
export function viewerOrchestrators(viewer: Viewer) {
  const url = mcpUrl();
  if (!url || !viewer.token) return null;
  return createOrchestratorApi({ serverUrl: url, token: viewer.token });
}

/** The page's words for a failed read, whatever failed. */
export function readFailure(error: unknown): {
  failure: OrchestratorApiError["failure"] | "contract";
  message: string;
} {
  if (error instanceof OrchestratorApiError) return { failure: error.failure, message: error.message };
  if (error instanceof OrchestratorContractError) return { failure: "contract", message: error.message };
  throw error;
}

/**
 * The named model accounts the viewer may choose for `orgId`, from the server's credential listing. A server without
 * named accounts lists none with an id, so none is offered: an orchestrator is never created on an implicit account.
 */
export async function listModelAccounts(
  viewer: Viewer,
  orgId: string,
): Promise<{ ok: true; accounts: ModelAccount[] } | { ok: false; reason: string }> {
  const url = mcpUrl();
  if (!url || !viewer.token) return { ok: false, reason: "The Armada server is not configured for this dashboard." };
  try {
    const payload = await controlPost(
      { serverUrl: url, token: viewer.token },
      "/api/v1/creds/list",
      { org: orgId },
      "credentials",
    );
    return { ok: true, accounts: parseModelAccounts(payload, orgId, Date.now()) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "The model accounts could not be read." };
  }
}
