import { redactKnownTokens } from "./token-redaction.ts";

export interface FailureDiagnostic {
  errorClass: string;
  message: string;
  stack: string[];
}

const retained = new WeakMap<Error, FailureDiagnostic>();
// Only source locations from Armada and installed dependencies. Function names, absolute
// directories, and the stack's message line can contain input or configuration.
const sourceFrame =
  /^\s*at (?:[^\n]*? \()?[^\s?#()]*(?:packages\/(?:core|mcp-server|provider-boat|provider-modal|agent-runtime|docker-host)\/src\/|node_modules\/)((?:[\w@.-]+\/)*[\w.-]+\.[cm]?[jt]s:\d+:\d+)\)?$/;
const internalMessages = new Set([
  "connection terminated unexpectedly",
  "runtime_startup_deadline",
  "runtime_startup_replaced",
  "runtime_startup_wrong_health",
  "runtime_channel_unavailable",
  "runtime_model_required",
  "invalid_runner_grant",
  "runtime_artifact_unavailable",
  "runtime_artifact_digest_mismatch",
  "runtime_artifact_size_mismatch",
  "runtime_artifact_rename_failed",
  "runtime_artifact_write_failed",
  "incompatible_harness_manifest",
]);
const errorClasses = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "TimeoutError",
  "SystemError",
  "ProviderError",
  "VaultError",
  "LaunchError",
  "AuthUnavailable",
  "RuntimeEnrolmentDenied",
  "RuntimeCommandConflict",
  "RuntimeCommandPending",
  "RuntimeCommandRefused",
  "ClientError",
  "AuthError",
  "NotFoundError",
  "AlreadyExistsError",
  "InvalidError",
  "PermissionDeniedError",
  "ResourceExhaustedError",
  "SandboxTimeoutError",
]);
const systemCodes = new Set(["ENOSPC", "EACCES", "EPERM", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOENT"]);

export function failureDiagnostic(error: unknown): FailureDiagnostic {
  try {
    if (!(error instanceof Error)) return { errorClass: typeof error, message: "Non-Error thrown", stack: [] };
    const saved = retained.get(error);
    // One wrapped dependency error often contains the useful code and source location.
    if (!saved && error.cause instanceof Error && error.cause !== error) {
      const cause = retained.get(error.cause) ?? projectError(error.cause);
      if (cause.message !== "Exception message withheld" || cause.stack.length) return cause;
    }
    if (saved) return saved;
    return projectError(error);
  } catch {
    return { errorClass: "Error", message: "Exception details unavailable", stack: [] };
  }
}

function projectError(error: Error): FailureDiagnostic {
  const errorClass = errorClasses.has(error.name)
    ? error.name
    : errorClasses.has(error.constructor.name)
      ? error.constructor.name
      : "Error";
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  // Pattern redaction cannot identify arbitrary values (for example a password
  // echoed by an SDK). Only exact, server-owned messages and system codes survive.
  const message = internalMessages.has(error.message)
    ? error.message
    : systemCodes.has(code)
      ? code
      : "Exception message withheld";
  const stackText = error.stack;
  const header = error.message ? `${error.name}: ${error.message}` : error.name;
  const stack = (
    typeof stackText === "string" && stackText.startsWith(`${header}\n`)
      ? stackText.slice(header.length + 1, header.length + 8193).split("\n")
      : []
  )
    .slice(0, 16)
    .flatMap((line) => {
      const frame = sourceFrame.exec(line)?.[1];
      return frame ? [redactKnownTokens(frame)] : [];
    })
    .slice(0, 8);
  return { errorClass, message, stack };
}

/** A provider normalization can retain evidence without adding data to public error objects. */
export function retainFailureDiagnostic<T extends Error>(wrapper: T, origin: unknown): T {
  retained.set(wrapper, failureDiagnostic(origin));
  return wrapper;
}
