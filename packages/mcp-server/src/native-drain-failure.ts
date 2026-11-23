import { EncryptionKeyError } from "../../core/src/crypto.ts";
import { GoldenError } from "../../core/src/golden-config.ts";
import { ProviderError } from "../../core/src/provider.ts";
import { VaultError } from "../../core/src/vault-error.ts";

type NativeDrainRefusal =
  | "authorization_refused"
  | "not_eligible"
  | "stop_admission_refused"
  | "stop_pending"
  | "preservation_refused"
  | "lease_busy"
  | "admission_conflict"
  | "deletion_outcome_unknown"
  | "deletion_pending"
  | "deletion_fence_lost"
  | "provider_configuration_missing"
  | "provider_credentials_unreadable";

const reasons = new WeakMap<Error, NativeDrainRefusal>();

export function withNativeDrainReason(error: Error, reason: NativeDrainRefusal) {
  reasons.set(error, reason);
  return error;
}

export type NativeDrainFailureReason =
  | NativeDrainRefusal
  | "authorization_or_missing"
  | "provider_credentials_missing"
  | "provider_http_4xx"
  | "provider_http_5xx"
  | "provider_error"
  | "unexpected_error";

export function nativeDrainFailureReason(error: unknown) {
  const reason = error instanceof Error ? reasons.get(error) : undefined;
  if (reason) return reason;
  if (error instanceof EncryptionKeyError) return "provider_credentials_unreadable";
  if (error instanceof VaultError && error.code === "missing_credential") return "provider_credentials_missing";
  if (error instanceof ProviderError) {
    if (error.status !== undefined && error.status >= 400 && error.status < 500) return "provider_http_4xx";
    if (error.status !== undefined && error.status >= 500 && error.status < 600) return "provider_http_5xx";
    return "provider_error";
  }
  if (error instanceof GoldenError) {
    if (error.code === "not_found") return "authorization_or_missing";
    if (error.code === "forbidden") return "authorization_refused";
    if (error.code === "conflict") return "not_eligible";
  }
  return "unexpected_error";
}
