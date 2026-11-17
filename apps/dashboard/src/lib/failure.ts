import { API_FAILURE_HELP, describeNativeFailure, planLimitFromMessage, planLimitMessage } from "@armada/core";

export type FailureHelp = {
  title: string;
  hint: string;
  /** Where in the dashboard the person can fix it, if anywhere. */
  fix?: { href: string; label: string };
};

const USAGE: FailureHelp = {
  title: "Usage limit reached",
  hint: "The account this agent runs on has hit its plan or billing limit. Wait for the limit to reset, or switch to another account and send the prompt again.",
  fix: { href: "/harness", label: "Manage subscriptions" },
};

const AUTH: FailureHelp = {
  title: "Account expired",
  hint: "The account this agent runs on expired or was revoked. Reconnect it, then send the prompt again.",
  fix: { href: "/harness", label: "Reconnect the account" },
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
  credential_refused: AUTH,
  provider_unavailable: {
    title: "Provider unavailable",
    hint: "The sandbox provider is temporarily unavailable. Try again later.",
  },
  dependency_unavailable: {
    title: "Server dependency unavailable",
    hint: "An Armada dependency is temporarily unavailable. Try again later.",
  },
  sandbox_retention_ended: {
    title: "Retention ended",
    hint: "This sandbox's local retention period has ended, so its disk was removed. Launch a new sandbox.",
  },
  outcome_unknown: {
    title: "Outcome unknown",
    hint: "Check the operation status before retrying; it may already have started.",
  },
  auth_expiry: AUTH,
  unauthorized: AUTH,
  provider_routing_unavailable: {
    title: "Server provider setup incomplete",
    hint: API_FAILURE_HELP.provider_routing_unavailable,
  },
  provider_not_configured: {
    title: "No subscription for this agent",
    hint: "Neither you nor the org has a subscription or API key for this agent. Add one, then launch again.",
    fix: { href: "/harness", label: "Add a subscription" },
  },
};

/** A clear message for the reasons an agent or a call fails with. Unknown reasons have none: show them as they are. */
export function describeFailure(reason: string | null | undefined): FailureHelp | null {
  if (!reason) return null;
  const limit = planLimitFromMessage(reason);
  if (limit)
    return {
      ...USAGE,
      title: limit.code === "rate_limited" ? "Rate limit reached" : "Plan limit reached",
      hint: planLimitMessage(limit),
    };
  return describeNativeFailure(reason) ?? HELP[reason] ?? null;
}
