import { API_FAILURE_HELP, type ApiFailureCode } from "../api-failure.ts";
import type { GoldenErrorCode } from "../golden-config.ts";
import type { LaunchErrorCode } from "../launch-error.ts";
import type { ProviderErrorCode } from "../provider.ts";
import type { VaultErrorCode } from "../vault-error.ts";

export const sandboxDispatchErrors = [
  "unauthorized",
  "dependency_unavailable",
  "invalid",
  "forbidden",
  "not_found",
  "unavailable",
  "internal",
] as const;

export const sandboxControlErrors = [
  "conflict",
  "invalid_request",
  "unsupported",
  "credential_binding_required",
  "sandbox_terminal",
  "sandbox_retention_ended",
  "rate_limited",
  "outcome_unknown",
] as const;

export const readLogsErrors = [
  "invalid",
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "unavailable",
  "dependency_unavailable",
  "provider_mismatch",
  "provider_unavailable",
  "provider_routing_unavailable",
  "rate_limited",
  "internal",
] as const;

export const stopSandboxErrors = ["conflict", "credential_binding_unsafe", "rate_limited", "outcome_unknown"] as const;

export const sandboxStatusErrors = ["conflict", "rate_limited"] as const;

const sharedFailureCodes = [
  "build_failed",
  "busy",
  "credential_binding_unsupported",
  "credential_busy",
  "denied",
  "host_draining",
  "host_full",
  "init_failed",
  "invalid_config",
  "invalid_name",
  "missing_credential",
  "no_credentials",
  "no_running_turn",
  "payment_required",
  "prompt_failed",
  "provider_not_configured",
  "relay_unavailable",
  "sandbox_not_ready",
  "setup_failed",
  "snapshot_failed",
  "start_failed",
  "unknown",
  "unknown_route",
  "upstream",
  "viewer_access_denied",
] as const;

const sdkFailureCodes = [
  ...sandboxDispatchErrors,
  ...sandboxControlErrors,
  ...sandboxStatusErrors,
  ...stopSandboxErrors,
  ...readLogsErrors,
  ...sharedFailureCodes,
] as const;

export type ServerFailureCode = ApiFailureCode | (typeof sdkFailureCodes)[number];
const serverFailureCodes: ReadonlySet<string> = new Set([...Object.keys(API_FAILURE_HELP), ...sdkFailureCodes]);

type MissingDomainFailure = Exclude<
  LaunchErrorCode | ProviderErrorCode | VaultErrorCode | GoldenErrorCode,
  ServerFailureCode
>;
const domainFailuresCovered: MissingDomainFailure extends never ? true : never = true;
void domainFailuresCovered;

export function isServerFailureCode(code: string): code is ServerFailureCode {
  return serverFailureCodes.has(code);
}
