import { VaultError } from "@armada/core/server";

export const MODAL_LAUNCH_SETUP_KEY = `format('["internal","%s","launch_initial_turn","%s",%s,"%s"]',
  s.org_id,s.id,s.lifecycle_generation,s.id)`;

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
