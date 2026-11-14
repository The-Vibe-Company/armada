import type { LaunchError, VaultErrorCode } from "@armada/core/server";
import type { ToolApiError } from "./tool-api.ts";

export function fail(
  status: number,
  code: string,
  message: string,
  details?: ToolApiError["details"] | Pick<LaunchError, "reason" | "action">,
): Response {
  return Response.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export const VAULT_STATUS: Record<VaultErrorCode, number> = {
  credential_busy: 409,
  credential_binding_required: 409,
  credential_binding_unsafe: 409,
  credential_binding_unsupported: 409,
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  missing_credential: 404,
  conflict: 409,
  unavailable: 503,
  credential_refused: 422,
};
