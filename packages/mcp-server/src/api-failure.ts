import {
  API_FAILURE_STATUS,
  type ApiFailureCode,
  EncryptionKeyError,
  LaunchError,
  ProviderError,
  VaultError,
} from "@armada/core";

/** Only typed causes determine categories. Never infer an error code from human diagnostics. */
export function apiFailureCode(error: unknown): ApiFailureCode | undefined {
  if (error instanceof LaunchError) {
    if (Object.hasOwn(API_FAILURE_STATUS, error.code)) return error.code as ApiFailureCode;
    // A recorded failed launch is not an ambiguous dispatch: retain its post-start code.
    return undefined;
  }
  if (error instanceof ProviderError) {
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
