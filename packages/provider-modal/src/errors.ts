import { ProviderError, type ProviderErrorCode } from "@armada/core";
export function refusal(
  code: ProviderErrorCode,
  message: string,
  modalFailure?: "process_quiescence_failed" | "process_baseline_missing" | "ssh_cleanup_failed" | "managed_state_busy",
): ProviderError {
  return new ProviderError({
    provider: "modal",
    code,
    message,
    retryable: code === "unavailable",
    ...(modalFailure ? { details: { modalFailure } } : {}),
  });
}
export function modalError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const name = error instanceof Error ? error.name : "Unknown";
  const codes: Record<string, ProviderErrorCode> = {
    AuthError: "unauthorized",
    NotFoundError: "not_found",
    AlreadyExistsError: "conflict",
    InvalidError: "invalid_request",
    PermissionDeniedError: "forbidden",
    ResourceExhaustedError: "unavailable",
    TimeoutError: "unavailable",
    SandboxTimeoutError: "unavailable",
  };
  // Do not copy upstream messages, causes or request bodies: they may contain credentials.
  let status: number | undefined;
  // nice-grpc ClientError exposes numeric gRPC status (0..16), not an HTTP status.
  if (error instanceof Error && error.name === "ClientError") {
    const code = Reflect.get(error, "code");
    if (Number.isInteger(code) && code >= 0 && code <= 16) status = code;
  }
  return new ProviderError({
    provider: "modal",
    code: codes[name] ?? "unknown",
    retryable: codes[name] === "unavailable",
    message: "Modal operation failed; consult the durable lifecycle phase before retrying.",
    ...(status === undefined ? {} : { status }),
    details: { modalFailure: Object.hasOwn(codes, name) ? name : status === undefined ? "unknown" : "grpc" },
  });
}

/** Retains only sanitized operation metadata and explicit resource provenance, never an upstream cause. */
export class ModalOperationError extends ProviderError {
  readonly receipt: import("./ports.ts").ModalResourceReceipt;
  constructor(error: unknown, receipt: import("./ports.ts").ModalResourceReceipt) {
    const safe = modalError(error);
    super({
      provider: "modal",
      code: safe.code,
      message: safe.message,
      retryable: safe.retryable,
      ...(safe.providerCode ? { providerCode: safe.providerCode } : {}),
      ...(safe.status !== undefined ? { status: safe.status } : {}),
      details: { ...safe.details, resourceReceipt: receipt },
    });
    this.receipt = receipt;
  }
}
export function modalFailureReceipt(error: unknown): import("./ports.ts").ModalResourceReceipt | undefined {
  return error instanceof ModalOperationError ? error.receipt : undefined;
}

/** Closed lifecycle labels only; never retain SDK messages or causal payloads. */
export async function lifecycleStep<T>(
  code:
    | "modal_checkpoint_runner"
    | "modal_checkpoint_scrub"
    | "modal_checkpoint_snapshot"
    | "modal_checkpoint_terminate"
    | "modal_checkpoint_observation"
    | "modal_checkpoint_receipt"
    | "modal_recovery_binding",
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const safe = modalError(error);
    const category = safe.details?.processCategory;
    const failure = safe.details?.processFailure;
    const modalFailure = safe.details?.modalFailure;
    console.warn(
      JSON.stringify({
        event: "modal_lifecycle_step_failed",
        stage: code,
        reason:
          typeof modalFailure === "string" &&
          [
            "process_quiescence_failed",
            "process_baseline_missing",
            "ssh_cleanup_failed",
            "managed_state_busy",
            "AuthError",
            "NotFoundError",
            "AlreadyExistsError",
            "InvalidError",
            "PermissionDeniedError",
            "ResourceExhaustedError",
            "TimeoutError",
            "SandboxTimeoutError",
            "unknown",
            "grpc",
          ].includes(modalFailure)
            ? modalFailure
            : "armada_refusal",
        providerStatusClass: safe.status === undefined ? "unknown" : safe.status <= 16 ? "grpc" : "http",
        ...(typeof category === "string" &&
        ["unknown", "codex", "runtime_or_mcp", "privileged_writer", "user_writer"].includes(category)
          ? { processCategory: category }
          : {}),
        ...(typeof failure === "string" &&
        ["pidfd_open", "pidfd_signal", "identity_changed", "unproven"].includes(failure)
          ? { processFailure: failure }
          : {}),
      }),
    );
    throw new ProviderError({
      provider: "modal",
      code: safe.code,
      message: "Modal lifecycle step failed; source retained for reconciliation.",
      retryable: safe.retryable,
      ...(safe.details ? { details: safe.details } : {}),
      ...(safe.status === undefined ? {} : { status: safe.status }),
      providerCode: code,
    });
  }
}
