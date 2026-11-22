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
