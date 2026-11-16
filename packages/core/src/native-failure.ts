/** Closed public explanations: never interpolate native error text. */
const HELP: Record<string, { title: string; hint: string }> = {
  rate_limited: {
    title: "Provider limit reached",
    hint: "The provider account reached a rate or plan limit. Check its limits and wait until the provider says another attempt is available.",
  },
  usage_limit_exceeded: {
    title: "Usage limit reached",
    hint: "Check the account plan or billing limit before retrying.",
  },
  context_window_exceeded: { title: "Context limit reached", hint: "Start a new conversation with a shorter prompt." },
  harness_failed: { title: "Agent failed", hint: "Check the agent configuration before retrying." },

  authentication_failed: {
    title: "Authentication failed",
    hint: "Reconnect the agent account, then send the prompt again.",
  },
  model_unavailable: {
    title: "Model unavailable",
    hint: "Choose a model available to this account, then send the prompt again.",
  },
  model_selection_failed: {
    title: "Model selection failed",
    hint: "Check the selected model and account access, then send the prompt again.",
  },
  session_restore_failed: {
    title: "Session restoration failed",
    hint: "The retained agent session could not be restored. Start a new conversation.",
  },
  session_start_failed: {
    title: "Session creation failed",
    hint: "The agent could not create a session. Check its configuration before retrying.",
  },
  turn_start_failed: {
    title: "Turn request failed",
    hint: "The agent rejected the turn request. Check the model and account configuration before retrying.",
  },
  harness_initialization_failed: {
    title: "Agent initialization failed",
    hint: "Check the agent installation and configuration, then retry.",
  },
};
const PHASES: Record<string, string> = {
  authentication: "During account authentication.",
  session_restore: "During session restoration.",
  model_selection: "During model selection.",
  session_start: "During session creation.",
  turn_start: "During the turn request.",
  initialization: "During agent initialization.",
};
export function describeNativeFailure(reason: string | null | undefined): { title: string; hint: string } | null {
  if (!reason) return null;
  const [code, phase, extra] = reason.split(":");
  if (
    !code ||
    !Object.hasOwn(HELP, code) ||
    extra !== undefined ||
    (phase !== undefined && !Object.hasOwn(PHASES, phase))
  )
    return null;
  const help = HELP[code]!;
  return phase ? { ...help, hint: `${PHASES[phase]} ${help.hint}` } : help;
}
