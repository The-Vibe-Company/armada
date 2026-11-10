export type VaultErrorCode =
  | "credential_binding_required"
  | "credential_binding_unsafe"
  | "invalid"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "missing_credential"
  | "unavailable"
  | "credential_refused";

/** An org or credential failure a CLI or server can show. The message never holds a secret. */
export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}
