import { DOCKER_IMAGE_UNAVAILABLE_MESSAGE, DOCKER_LAUNCH_FAILURE_MESSAGES } from "./docker-api.ts";

import { RUNTIME_STARTUP_FAILURES } from "./runtime-startup-failure.ts";

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
  output_limit_exceeded: {
    title: "Model output limit reached",
    hint: "The model stopped before it finished this response. Send a message to continue.",
  },
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
  const publicHelp = Object.values(HELP).find(
    (help) => reason === help.hint || reason === `${help.title}. ${help.hint}`,
  );
  if (publicHelp) return publicHelp;
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

/** Normalize public prompt diagnoses without exposing arbitrary native output. */
export function promptFailureReason(message?: string): string {
  const help =
    describeNativeFailure(message) ??
    Object.values(HELP).find((help) => message === help.hint || message === `${help.title}. ${help.hint}`) ??
    HELP.harness_failed!;
  return `${help.title}. ${help.hint}`;
}

/** Closed sandbox-level explanations, including persisted legacy status reasons. */
export function describeSandboxFailure(reason: string | null | undefined): { title: string; hint: string } {
  if (reason && Object.values(RUNTIME_STARTUP_FAILURES).some((message) => message === reason))
    return { title: "Sandbox startup failed", hint: reason };
  const native = describeNativeFailure(reason);
  if (native) return native;
  if (
    reason &&
    (Object.values(DOCKER_LAUNCH_FAILURE_MESSAGES).some((value) => value === reason) ||
      reason === DOCKER_IMAGE_UNAVAILABLE_MESSAGE)
  )
    return { title: "Sandbox preparation failed", hint: reason };
  if (reason === "Docker sandbox startup failed." || reason === "Docker sandbox failed.")
    return { title: "Sandbox startup failed", hint: DOCKER_LAUNCH_FAILURE_MESSAGES.startup };
  if (reason === "expired")
    return { title: "Sandbox expired", hint: "The sandbox reached its deadline. Launch a new sandbox to continue." };
  if (reason === "agent_finished")
    return { title: "Agent finished", hint: "The agent ended its session. Launch a new sandbox to continue." };
  if (reason === "Armada runtime bootstrap failed.")
    return {
      title: "Sandbox startup failed",
      hint: "The agent runtime could not start. Launch a new sandbox; if it fails again, ask the server operator to check the runtime setup.",
    };
  if (reason === "Runtime resume failed before a restored worker was confirmed; cleanup requested.")
    return {
      title: "Sandbox resume failed",
      hint: "The agent runtime could not resume. Launch a new sandbox; if it fails again, ask the server operator to check the runtime setup.",
    };
  if (
    reason === "The machine failed (exited)." ||
    reason === "The machine failed (unrecognized)." ||
    reason === "Provider confirmed physical exit without a new verified recovery checkpoint."
  )
    return {
      title: "Sandbox machine stopped",
      hint: "The provider stopped the sandbox machine. Launch a new sandbox; if it fails again, ask the server operator to check the provider.",
    };
  return {
    title: "Sandbox failed",
    hint: "The sandbox stopped without a public diagnosis. Launch a new sandbox; if it fails again, ask the server operator to inspect its status.",
  };
}

/** Project persisted Docker failures through the shared closed public vocabulary. */
export function dockerSandboxFailureReason(reason: string | null | undefined): string {
  const explanation = describeSandboxFailure(reason);
  return explanation.title === "Sandbox failed" ? DOCKER_LAUNCH_FAILURE_MESSAGES.startup : explanation.hint;
}
