import { VaultError } from "@armada/core/server";

export class RuntimeReconciliationConflict extends VaultError {
  readonly reason = "runtime_reconciliation_active";

  constructor() {
    super("conflict", "Sandbox reconciliation is active. Wait for it to finish before retrying.");
  }
}

export class RuntimeCheckpointActivityConflict extends VaultError {
  readonly reason = "activity_lease_present";

  constructor() {
    super("conflict", "Runtime admission is busy; wait or reconcile its original request before checkpointing.");
  }
}

export class RuntimeCheckpointParentConflict extends VaultError {
  constructor() {
    super("conflict", "Scoped parent authority is busy. Retry checkpoint.");
  }
}

export class StartingModalStopChanged extends VaultError {
  constructor() {
    super("conflict", "Modal launch changed before stop admission.");
  }
}
