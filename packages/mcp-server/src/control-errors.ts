import { BodyTooLargeError } from "@armada/auth";
import { API_FAILURE_STATUS, GitHubHydrationError } from "@armada/core";
import {
  ENCRYPTION_KEY_ENV,
  EncryptionKeyError,
  GoldenError,
  type GoldenErrorCode,
  LaunchError,
  ProviderError,
  ProviderRoutingError,
  VaultError,
} from "@armada/core/server";
import { GatewayError } from "../../mcp-gateway/src/network.ts";
import { apiFailureCode, providerFailureResponse } from "./api-failure.ts";
import { AuthUnavailable } from "./caller.ts";
import { Unauthorized } from "./control-caller.ts";
import { fail, VAULT_STATUS as STATUS } from "./control-response.ts";
import { InvitationError } from "./invitations.ts";
import { ToolApiError } from "./tool-api.ts";

const GOLDEN_STATUS: Record<GoldenErrorCode, number> = {
  invalid_config: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  setup_failed: 502,
  snapshot_failed: 502,
  build_failed: 502,
};

export function controlFailureResponse(error: unknown): Response {
  if (error instanceof BodyTooLargeError) return fail(413, "invalid", error.message);
  if (error instanceof ProviderError) {
    const { status, error: failure } = providerFailureResponse(error);
    return Response.json({ error: failure }, { status, headers: { "cache-control": "no-store" } });
  }
  const failureCode = apiFailureCode(error);
  if (failureCode)
    return Response.json(
      {
        error: {
          code: failureCode,
          message: error instanceof Error ? error.message : failureCode,
          ...(error instanceof GitHubHydrationError ? { details: error.details } : {}),
        },
      },
      { status: API_FAILURE_STATUS[failureCode], headers: { "cache-control": "no-store" } },
    );
  if (error instanceof GatewayError) {
    const status = error.code === "denied" ? 403 : error.code === "busy" ? 409 : error.code === "upstream" ? 502 : 400;
    return fail(status, error.code, error.action);
  }
  if (error instanceof ToolApiError) return fail(error.status, error.code, error.message, error.details);
  if (error instanceof Unauthorized) return fail(401, "unauthorized", error.message);
  if (error instanceof AuthUnavailable)
    return fail(503, "dependency_unavailable", "Authentication is temporarily unavailable.");
  if (error instanceof ProviderRoutingError) return fail(503, error.code, error.message);
  if (error instanceof LaunchError)
    return fail(
      400,
      error.code,
      error.message,
      error.reason
        ? { reason: error.reason, action: error.action, ...(error.stage ? { stage: error.stage } : {}) }
        : undefined,
    );
  if (error instanceof InvitationError)
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          reason: error.reason,
          ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
        },
      },
      { status: STATUS[error.code], headers: { "cache-control": "no-store" } },
    );
  if (error instanceof VaultError) {
    if (error.code === "credential_busy")
      return Response.json(
        { error: { code: "conflict", reason: "credential_busy", message: error.message } },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    return fail(STATUS[error.code], error.code, error.message);
  }
  if (error instanceof GoldenError) return fail(GOLDEN_STATUS[error.code], error.code, error.message);
  if (error instanceof EncryptionKeyError) {
    return fail(
      503,
      "dependency_unavailable",
      `Credential encryption is not configured on the server (${ENCRYPTION_KEY_ENV}).`,
    );
  }
  return fail(500, "internal", "The server could not complete the request.");
}
