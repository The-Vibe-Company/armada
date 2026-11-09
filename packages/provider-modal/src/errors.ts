import { ProviderError, type ProviderErrorCode } from "@armada/core";
export function refusal(code: ProviderErrorCode, message: string): ProviderError {
  return new ProviderError({ provider: "modal", code, message, retryable: code === "unavailable" });
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
  return refusal(
    codes[name] ?? "unknown",
    "Modal operation failed; consult the durable lifecycle phase before retrying.",
  );
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
      details: { resourceReceipt: receipt },
    });
    this.receipt = receipt;
  }
}
export function modalFailureReceipt(error: unknown): import("./ports.ts").ModalResourceReceipt | undefined {
  return error instanceof ModalOperationError ? error.receipt : undefined;
}
