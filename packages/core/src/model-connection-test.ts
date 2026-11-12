/** Closed, non-secret diagnostics shared by runtime, transport, API and clients. */
export const MODEL_CONNECTION_ERROR_CODES = [
  "invalid_api_key",
  "model_not_found",
  "DeploymentNotFound",
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "rate_limit_error",
  "overloaded_error",
  "api_error",
  "server_error",
  "insufficient_quota",
] as const;
export function modelConnectionErrorCode(value: unknown): string | null {
  return MODEL_CONNECTION_ERROR_CODES.find((code) => code === value) ?? null;
}
export interface ModelConnectionTestResult {
  ok: boolean;
  status: number | null;
  error: "provider_rejected" | "invalid_response" | "connection_failed" | null;
  code: string | null;
}
export function isModelConnectionTestResult(value: unknown): value is ModelConnectionTestResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["ok", "status", "error", "code"].includes(key))) return false;
  const status = typeof v.status === "number" && Number.isInteger(v.status) && v.status >= 100 && v.status <= 599;
  if (v.ok === true)
    return status && Number(v.status) >= 200 && Number(v.status) < 300 && v.error === null && v.code === null;
  if (v.ok !== false) return false;
  if (v.error === "connection_failed") return v.status === null && v.code === null;
  if (!status) return false;
  if (v.error === "invalid_response") return v.code === null;
  return (
    v.error === "provider_rejected" &&
    (v.code === null || (typeof v.code === "string" && modelConnectionErrorCode(v.code) === v.code))
  );
}
