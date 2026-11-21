import { VaultError } from "@armada/core/server";

export const MODAL_LAUNCH_SETUP_STATE = `(
  select j.state from public.jobs j where j.idem_key=
    format('["internal","%s","launch_initial_turn","%s",%s,"%s"]',
           s.org_id,s.id,s.lifecycle_generation,s.id)
)`;

export class ModalLaunchSetupConflict extends VaultError {
  constructor(readonly state: "queued" | "leased" | "failed") {
    super("conflict", state === "failed" ? "Modal launch setup failed." : "Modal launch setup is still in progress.");
  }
}

export function assertModalLaunchSetup(state: string | null | undefined) {
  if (state === "queued" || state === "leased" || state === "failed") throw new ModalLaunchSetupConflict(state);
}
