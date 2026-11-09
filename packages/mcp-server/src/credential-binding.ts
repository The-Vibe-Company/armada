/** Shared fail-closed guidance for an unbound legacy Modal sandbox; it names the owner's recovery route. */
export const CREDENTIAL_BINDING_GUIDANCE =
  "This legacy Modal sandbox needs an explicit account binding by its owner. Stop it safely, then its owner chooses an account on the sandbox's dashboard page or runs 'armada bind-credential <sandbox-id> --credential-id <account-uuid>'. Its workspace and conversations are retained.";
