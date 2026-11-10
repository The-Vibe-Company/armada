export type FailureHelp = {
  title: string;
  hint: string;
  /** Where in the dashboard the person can fix it, if anywhere. */
  fix?: { href: string; label: string };
};

const USAGE: FailureHelp = {
  title: "Usage limit reached",
  hint: "The credential this agent runs on has hit its plan or billing limit. Wait for the limit to reset, or switch to another credential and send the prompt again.",
  fix: { href: "/credentials", label: "Manage credentials" },
};

const AUTH: FailureHelp = {
  title: "Credential expired",
  hint: "The credential this agent runs on expired or was revoked. Replace it, then send the prompt again.",
  fix: { href: "/credentials", label: "Replace the credential" },
};

const HELP: Record<string, FailureHelp> = {
  interrupted_by_provider_move: {
    title: "Turn interrupted",
    hint: "The sandbox moved to a new machine. Send the prompt again.",
  },
  interrupted_by_harness_exit: {
    title: "Agent process exited",
    hint: "Send the prompt again to start a fresh agent process.",
  },
  usage_limit: USAGE,
  payment_required: USAGE,
  rate_limited: {
    title: "Rate limited",
    hint: "The provider is throttling this account. Wait a moment and try again.",
  },
  credential_refused: AUTH,
  provider_unavailable: {
    title: "Provider unavailable",
    hint: "The sandbox provider is temporarily unavailable. Try again later.",
  },
  dependency_unavailable: {
    title: "Server dependency unavailable",
    hint: "An Armada dependency is temporarily unavailable. Try again later.",
  },
  outcome_unknown: {
    title: "Outcome unknown",
    hint: "Check the operation status before retrying; it may already have started.",
  },
  auth_expiry: AUTH,
  unauthorized: AUTH,
  provider_not_configured: {
    title: "No credential for this agent",
    hint: "Neither you nor the org has a key for this agent. Add one, then launch again.",
    fix: { href: "/credentials", label: "Add a credential" },
  },
};

/** A clear message for the reasons an agent or a call fails with. Unknown reasons have none: show them as they are. */
export function describeFailure(reason: string | null | undefined): FailureHelp | null {
  if (!reason) return null;
  return HELP[reason] ?? null;
}
