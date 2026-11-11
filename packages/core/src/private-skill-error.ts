/** Closed private-install diagnostics. Browser-safe: no transport or secret handling. */
export const PRIVATE_SSH_FAILURES = [
  "skillpack_ssh_keygen_failed",
  "skillpack_ssh_local_storage_failed",
  "skillpack_ssh_authorization_failed",
  "skillpack_ssh_connection_invalid",
  "skillpack_ssh_connection_failed",
  "skillpack_ssh_host_key_rejected",
  "skillpack_ssh_authentication_failed",
  "skillpack_ssh_unreachable",
  "skillpack_ssh_timeout",
  "skillpack_ssh_node_missing",
  "skillpack_ssh_flock_missing",
  "skillpack_ssh_home_unavailable",
  "skillpack_ssh_key_cleanup_failed",
  "skillpack_ssh_remote_failed",
  "skillpack_ssh_output_invalid",
] as const;
export class PrivateSshError extends Error {
  constructor(readonly reason: (typeof PRIVATE_SSH_FAILURES)[number]) {
    super(reason);
  }
}
export const PRIVATE_SKILL_FAILURES = [
  ...PRIVATE_SSH_FAILURES,
  "skillpack_credential_unreadable",
  "skillpack_process_failed",
  "skillpack_install_nonzero",
  "skillpack_install_state_invalid",
  "skillpack_registry_unavailable",
  "skillpack_cli_unavailable",
  "skillpack_download_unavailable",
  "skillpack_timeout",
  "skillpack_auth_unavailable",
  "skillpack_protocol_invalid",
  "skillpack_install_conflict",
  "skillpack_request_rejected",
  "skillpack_receipt_invalid",
  "skillpack_transport_failed",
] as const;

export type PrivateSkillFailure =
  | (typeof PRIVATE_SKILL_FAILURES)[number]
  | "skillpack_credential_missing"
  | "skillpack_credential_refused"
  | "skillpack_skill_unavailable";
export class PrivateSkillError extends Error {
  constructor(
    readonly reason: PrivateSkillFailure,
    readonly stage: "credential" | "auth" | "install" | "receipt" | "transport" = "credential",
  ) {
    super(reason);
  }
}
