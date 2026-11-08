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
  usage_limit: USAGE,
  payment_required: USAGE,
  rate_limited: {
    title: "Rate limited",
    hint: "The provider is throttling this account. Wait a moment and try again.",
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
  const known = HELP[reason.trim().toLowerCase()];
  if (known) return known;
  const lowered = reason.toLowerCase();
  for (const code of Object.keys(HELP)) {
    if (lowered.includes(code)) return HELP[code] ?? null;
  }
  return null;
}
