import { VaultError } from "@armada/core/server";

export class RuntimeReconciliationConflict extends VaultError {
  readonly reason = "runtime_reconciliation_active";

  constructor() {
    super("conflict", "Sandbox reconciliation is active. Wait for it to finish before retrying.");
  }
}
