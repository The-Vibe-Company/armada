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

/** Closed application-vault conflict sentinels shared by API producers and clients. */
export const APPLICATION_VAULT_CONFLICT_MESSAGES = {
  versionChanged: "Application vault version changed.",
  inactive: "Application vault resource is not active.",
  nameInUse:
    "An application vault name is already in use. Update or delete the existing entry; delete revoked secrets before reusing their names.",
} as const;
