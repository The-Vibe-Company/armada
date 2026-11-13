import {
  API_FAILURE_STATUS,
  type ApiFailureCode,
  EncryptionKeyError,
  GitHubHydrationError,
  LaunchError,
  ProviderError,
  providerRateLimitDetails,
  providerRateLimitMessage,
  VaultError,
} from "@armada/core";
import { isProviderStartRateLimit } from "@armada/core/server";

/** Only typed causes determine categories. Never infer an error code from human diagnostics. */
export function apiFailureCode(error: unknown): ApiFailureCode | undefined {
  if (error instanceof GitHubHydrationError) return "github_hydration_failed";
  if (error instanceof LaunchError) {
    if (Object.hasOwn(API_FAILURE_STATUS, error.code)) return error.code as ApiFailureCode;
    // A recorded failed launch is not an ambiguous dispatch: retain its post-start code.
    return undefined;
  }
  if (error instanceof ProviderError) {
    if (error.details?.keepSource || error.details?.resourceReceipt) return "outcome_unknown";
    if (error.code === "unauthorized") return "credential_refused";
    if (error.code === "unavailable" || error.code === "unknown") return "provider_unavailable";
  }
  if (error instanceof VaultError) {
    if (error.code === "credential_refused") return "credential_refused";
    if (error.code === "unavailable") return "dependency_unavailable";
  }
  if (error instanceof EncryptionKeyError) return "dependency_unavailable";
  return undefined;
}

/** One HTTP projection for every provider, after the shared typed failure classification. */
export function providerFailureResponse(error: ProviderError) {
  const category = apiFailureCode(error);
  const limit =
    !category && isProviderStartRateLimit(error)
      ? providerRateLimitDetails({ ...error.details, provider: "boat", retryAfterSeconds: error.retryAfterSeconds })
      : undefined;
  const statuses = new Map<ProviderError["code"], number>([
    ["rate_limited", 429],
    ["payment_required", 402],
    ["conflict", 409],
    ["forbidden", 403],
    ["invalid_request", 400],
  ]);
  return {
    status: category ? API_FAILURE_STATUS[category] : (statuses.get(error.code) ?? 503),
    error: {
      code: category ?? error.code,
      message: limit ? providerRateLimitMessage(limit) : error.message,
      ...(limit
        ? { details: limit }
        : error.details?.keepSource === true
          ? { details: { keepSource: true, sourceSandboxId: error.details.sourceSandboxId } }
          : {}),
    },
  };
}
