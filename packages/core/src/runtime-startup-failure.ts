/** Closed wire vocabulary: never persist exception messages or credential material. */
export const RUNTIME_STARTUP_FAILURES = {
  disk_full: "Host disk is full. Free disk space on the host and retry.",
  artifact_manifest_incompatible:
    "Runtime artifact manifest is incompatible. Ask the server operator to publish matching runtime and harness artifacts before launching again.",
  artifact_unavailable:
    "Runtime artifact download failed. Ask the server operator to check artifact publication and container network access before launching again.",
  artifact_integrity:
    "Runtime artifact verification failed. Ask the server operator to repair the published artifacts or cache before launching again.",
  artifact_preparation:
    "Runtime artifact preparation failed. Ask the server operator to check published harness artifacts and container filesystem access before launching again.",
  artifact_permission:
    "Runtime artifact filesystem permission check failed. Ask the operator to check cache ownership and access.",
  artifact_rename: "Runtime artifact cache rename failed. Ask the operator to check cache filesystem access.",
  artifact_write: "Runtime artifact cache write failed. Ask the operator to check cache filesystem health.",
  credential_projection:
    "Runtime credential projection failed. Reconnect the model account; ask the server operator to check runtime authentication configuration if it persists.",
  model_routing:
    "Runtime model routing failed. Ask the server operator to check the configured model endpoint before launching again.",
  runtime_configuration:
    "Runtime configuration failed. Ask the server operator to inspect runtime startup configuration before launching again.",
} as const;
export type RuntimeStartupFailure = keyof typeof RUNTIME_STARTUP_FAILURES;
export function isRuntimeStartupFailure(value: unknown): value is RuntimeStartupFailure {
  return typeof value === "string" && Object.hasOwn(RUNTIME_STARTUP_FAILURES, value);
}

/** Only exact internal codes are recognized; arbitrary exception text never leaves the process. */
export function runtimeStartupFailure(error: unknown, phase: RuntimeStartupFailure): RuntimeStartupFailure {
  if (error instanceof Error && "code" in error && error.code === "ENOSPC") return "disk_full";
  if (error instanceof Error && "code" in error && ["EACCES", "EPERM"].includes(String(error.code)))
    return "artifact_permission";
  const code = error instanceof Error ? error.message : "";
  if (["runtime_cache_not_private", "invalid_harness_cache", "invalid_runtime_tool_cache"].includes(code))
    return "artifact_permission";
  if (code === "runtime_artifact_rename_failed") return "artifact_rename";
  if (code === "runtime_artifact_write_failed") return "artifact_write";
  if (code === "incompatible_harness_manifest") return "artifact_manifest_incompatible";
  if (code === "runtime_artifact_unavailable") return "artifact_unavailable";
  if (["runtime_artifact_size_mismatch", "runtime_artifact_digest_mismatch", "harness_archive_mismatch"].includes(code))
    return "artifact_integrity";
  return phase;
}

/** Closed operator report stages. The authenticated runtime sends no exception text. */
export type RuntimeHarnessFailureStage = "harness_start_failed" | "harness_turn_failed" | "native_auth_publish_failed";
export function isRuntimeHarnessFailureStage(value: unknown): value is RuntimeHarnessFailureStage {
  return value === "harness_start_failed" || value === "harness_turn_failed" || value === "native_auth_publish_failed";
}
