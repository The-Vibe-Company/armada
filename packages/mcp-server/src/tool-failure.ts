import { GitHubHydrationError, launchFailureHelp, providerRateLimitDetails } from "@armada/core";
import {
  EncryptionKeyError,
  GoldenError,
  LaunchError,
  ProviderError,
  ProviderRoutingError,
  VaultError,
} from "@armada/core/server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { apiFailureCode } from "./api-failure.ts";
import { INTERNAL_FAILURE_MESSAGE } from "./control-response.ts";
import { DataError } from "./data.ts";
import { recordOperatorFailure } from "./request-observability.ts";
import { ToolError } from "./tool-error.ts";

export function errorResult(error: unknown, tool: string, logError: (line: string) => void) {
  const { code, message } = describeToolFailure(error);
  logToolFailure(error, tool, code, logError);
  return {
    isError: true,
    ...(error instanceof LaunchError && error.reason
      ? {
          structuredContent: {
            error: {
              code,
              message,
              details: { reason: error.reason, action: error.action, ...(error.stage ? { stage: error.stage } : {}) },
            },
          },
        }
      : {}),
    ...(error instanceof ProviderError && code === "rate_limited"
      ? {
          structuredContent: {
            error: {
              code,
              message,
              details: providerRateLimitDetails({ ...error.details, retryAfterSeconds: error.retryAfterSeconds }),
            },
          },
        }
      : {}),
    ...(error instanceof GitHubHydrationError ? { _meta: { error: { code, message, details: error.details } } } : {}),
    content: [
      { type: "text", text: message },
      { type: "text", text: `error code: ${code}` },
      ...(error instanceof GitHubHydrationError
        ? [{ type: "text" as const, text: JSON.stringify({ error: { code, message, details: error.details } }) }]
        : []),
    ],
  } satisfies CallToolResult;
}

export function logToolFailure(error: unknown, tool: string, code: string, logError?: (line: string) => void) {
  if (
    [
      "internal",
      "unavailable",
      "provider_unavailable",
      "dependency_unavailable",
      "outcome_unknown",
      "start_failed",
    ].includes(code)
  ) {
    recordOperatorFailure(`tool.${tool}`, error, {
      sandboxId: error instanceof LaunchError ? error.sandboxId : undefined,
      ...(logError ? { log: logError } : {}),
    });
  }
}

export function describeToolFailure(error: unknown) {
  const failure = apiFailureCode(error);
  if (failure) return { code: failure, message: error instanceof Error ? error.message : failure };
  if (error instanceof ToolError) return { code: error.code, message: error.message };
  if (error instanceof LaunchError) {
    const tail = error.sandboxId ? ` Sandbox ${error.sandboxId} is recorded as failed and its machine is stopped.` : "";
    return {
      code: error.code,
      message: `${launchFailureHelp(error.code, undefined, error.message) ?? error.message}${tail}`,
    };
  }
  if (error instanceof GoldenError) return { code: error.code, message: error.message };
  if (error instanceof ProviderRoutingError)
    return { code: error.code, message: launchFailureHelp(error.code, undefined, error.message) ?? error.message };
  if (error instanceof ProviderError) {
    if (error.code === "no_running_turn") {
      return { code: error.code, message: "No turn is running. Use send to start one." };
    }
    return {
      code: error.code,
      message:
        launchFailureHelp(error.code, { ...error.details, retryAfterSeconds: error.retryAfterSeconds }) ??
        error.message,
    };
  }
  if (error instanceof VaultError)
    return {
      code: error.code,
      message: error.message,
    };
  if (error instanceof EncryptionKeyError) return { code: "dependency_unavailable", message: error.message };
  if (error instanceof DataError)
    return { code: error.code === "unavailable" ? "dependency_unavailable" : error.code, message: error.message };
  return { code: "internal", message: INTERNAL_FAILURE_MESSAGE };
}

// WARNING: Attach this catch only to mutation dispatch, after preparation and provider reads.
export function unknownMutationOutcome(error: unknown): never {
  if (!(error instanceof ProviderError) || error.code === "unavailable" || error.code === "unknown")
    throw new LaunchError(
      "outcome_unknown",
      "The operation outcome is unknown. Check sandbox status before retrying.",
      { cause: error },
    );
  throw error;
}

export function publicationFailure(error: unknown, acknowledged: boolean): never {
  if (acknowledged)
    throw new LaunchError(
      "outcome_unknown",
      "The operation was accepted but its result could not be published. Check sandbox status before retrying.",
      { cause: error },
    );
  throw error;
}
