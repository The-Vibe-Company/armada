import { parseGoldenConfig } from "@armada/core";
import { VaultError } from "@armada/core/server";

export function parseModalLaunchWorkspace(payload: { workspace?: unknown }) {
  return parseGoldenConfig(payload.workspace);
}

const refusalMessages = {
  modal_launch_setup_pending: "Modal launch setup is still in progress.",
  modal_launch_setup_failed: "Modal launch setup failed.",
  modal_launch_prompt_pending: "Modal launch prompt is awaiting dispatch.",
};

export class ModalLaunchSetupConflict extends VaultError {
  constructor(readonly reason: keyof typeof refusalMessages) {
    super("conflict", refusalMessages[reason]);
  }
}

export function assertModalLaunchSetup(state: string | null | undefined) {
  if (state === "queued" || state === "leased") throw new ModalLaunchSetupConflict("modal_launch_setup_pending");
  if (state === "failed") throw new ModalLaunchSetupConflict("modal_launch_setup_failed");
}

export function modalSetupFailureReason(reason: string | null) {
  return reason !== null && setupFailureReasons.has(reason) ? reason : "modal_initial_turn_unclassified";
}

const setupFailureReasons = new Set([
  "invalid_modal_initial_turn",
  "modal_initial_turn_unavailable",
  "modal_initial_turn_budget_exhausted",
  "modal_initial_turn_environment_refused",
  "modal_initial_turn_workspace_refused",
  "modal_initial_turn_skills_refused",
  "modal_initial_turn_mcp_refused",
  "modal_initial_turn_scoped_access_unavailable",
  "modal_initial_turn_scoped_reference_refused",
  "modal_initial_turn_refused",
]);
